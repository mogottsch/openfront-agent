// NARROW OFFLINE CITY SEAM, not yet a full hybrid benchmark. One explicitly
// mock Choice on fresh native Europe/Compact. No HTTP, Start token or provider
// mode is implemented here. No core mutation, fake starting gold or direct
// construction; adapter callbacks only queue normal stamped intents.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBuildingAdapter } from "../web/building-adapter.js";
import { validateHybridInput } from "../web/hybrid-observation.js";
import { buildHybridRequest, parseHybridDecision, HYBRID_POLICY_VERSION,
} from "../src/hybrid-policy.mjs";
import { POLICY_VERSION } from "../src/policy.mjs";
import { createTickPacer } from "./benchmark-jev-observation.mjs";
import { createFocusedEuropeWorld, observeFocusedCore, parseFocusedEuropeArgs,
} from "./benchmark-focused-europe.mts";

export function parseHybridEuropeArgs(argv) {
  const options = parseFocusedEuropeArgs(argv);
  if (options.mode !== "mock") throw new Error("Narrow City seam supports --mock only; no live/provider mode");
  if (options.maxTicks > 100) throw new Error("First City seam is bounded to 100 post-setup ticks");
  return { ...options, output: argv.includes("--output") ? options.output :
    "logs/benchmark-hybrid-europe-city.json" };
}

/**
 * Truthful, cached GameView-shaped facade. Do not redefine methods on the real
 * core players: native attacks still consume their original Attack objects.
 * Instead, read-only proxies expose PlayerView's actual AttackUpdate shape,
 * use real worker-facing queries and preserve owner/friend identities.
 */
export function createHybridEuropeFacade(world, gameId) {
  const { game, human, runner } = world;
  if (!runner || typeof runner.playerBuildables !== "function" ||
      typeof runner.playerActions !== "function") {
    throw new Error("Real worker-facing GameRunner queries are required");
  }
  const players = new WeakMap();
  const units = new WeakMap();
  const originals = new WeakMap();
  const workerQueries = [];
  const unwrap = (view) => originals.get(view) ?? view;
  const update = (attack) => ({ id: attack.id(),
    attackerID: attack.attacker().smallID(), targetID: attack.target().smallID(),
    troops: attack.troops(), retreating: attack.retreating() });
  const unitView = (core) => {
    if (units.has(core)) return units.get(core);
    const proxy = new Proxy(core, { get(target, prop) {
      if (prop === "owner") return () => playerView(target.owner());
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    units.set(core, proxy);
    originals.set(proxy, core);
    return proxy;
  };
  const coordinates = (tile) => {
    if (tile === undefined) return [undefined, undefined];
    if (!game.isValidRef(tile)) throw new Error("Invalid worker tile ref");
    return [game.x(tile), game.y(tile)]; // ref 0 and x/y 0 are valid
  };
  const playerView = (core) => {
    if (!core?.isPlayer?.()) return core;
    if (players.has(core)) return players.get(core);
    const proxy = new Proxy(core, { get(target, prop) {
      if (prop === "incomingAttacks" || prop === "outgoingAttacks")
        return () => target[prop]().map(update);
      if (prop === "units") return (...types) => target.units(...types).map(unitView);
      if (prop === "borderTiles") return async () => runner.playerBorderTiles(target.id());
      if (prop === "buildables") return async (tile, types) => {
        const [x, y] = coordinates(tile);
        const result = runner.playerBuildables(target.id(), x, y, types);
        workerQueries.push({ kind: "buildables", tick: game.ticks(), tile, types,
          result: result.map((unit) => ({ type: unit.type,
            can_build: unit.canBuild, can_upgrade: unit.canUpgrade,
            cost_gold: typeof unit.cost === "bigint" ? unit.cost.toString() : null })) });
        return result;
      };
      if (prop === "actions") return async (tile, types) => {
        const [x, y] = coordinates(tile);
        workerQueries.push({ kind: "actions", tick: game.ticks(), tile, types });
        return runner.playerActions(target.id(), x, y, types);
      };
      if (["isFriendly", "isOnSameTeam", "isAlliedWith"].includes(prop)) {
        return (other) => target[prop](unwrap(other));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    players.set(core, proxy);
    originals.set(proxy, core);
    return proxy;
  };
  const facade = new Proxy(game, { get(target, prop) {
    if (prop === "gameID") return () => gameId;
    if (prop === "myPlayer") return () => playerView(human);
    if (prop === "playerBySmallID") return (id) => playerView(target.playerBySmallID(id));
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { game: facade, player: playerView(human), workerQueries };
}

export async function prepareCitySeam(world, { gameId, focus = null, history = null,
  maxCandidates = 4, maxExamined = 256, maxWorkerChecks = 8 } = {}) {
  if (!world.read || !world.UnitType || !world.config || typeof gameId !== "string")
    throw new Error("City seam requires the focused world read/config/UnitType API");
  const { game, human } = world;
  const view = createHybridEuropeFacade(world, gameId);
  const queued = [];
  const adapter = createBuildingAdapter({ game: view.game, read: world.read,
    cityUnit: world.UnitType.City, sendBuild: (unit, tile) => {
      const state = world.read();
      if (!state.ready || state.ended || unit !== world.UnitType.City ||
          queued.length || !game.isValidRef(tile)) return false;
      queued.push({ type: "build_unit", clientID: world.clientID, unit, tile });
      return true;
    } });
  const proposal = await adapter.propose({ mapId: "europe-compact", maxCandidates,
    maxExamined, maxWorkerChecks, coverageRadius: 6 });
  const land = observeFocusedCore(game, human, focus, history);
  if (!land.observation || proposal.source_tick !== land.tick ||
      proposal.current_tick !== land.tick || world.read().tick !== land.tick) {
    throw new Error("City and focus/land snapshots do not share a current engine tick");
  }
  const input = validateHybridInput({ game_id: gameId, snapshot_tick: land.tick,
    land: land.observation, building: proposal, plan: null,
    city_mechanics: { troop_capacity_gain_display: world.config.cityTroopIncrease() / 10,
      construction_ticks: world.config.unitInfo(world.UnitType.City).constructionDuration } });
  const request = buildHybridRequest(input);
  return { input, request, adapter, view, queued, world,
    claims: { stage: "city-only-worker-seam", model_calls: 0,
      boats_enabled: false, defense_posts_enabled: false,
      starting_gold_override: false, paused_during_inference: true } };
}

// Strictly reconstruct every normalized Choice against the SAME local request,
// including speculative answers, rather than trusting candidate_id alone.
export function validateCitySeamDecision(decision, seam) {
  if (!decision?.decisions || typeof decision.decisions !== "object")
    throw new Error("Missing hybrid Choice answers");
  const answers = Object.fromEntries(Object.entries(decision.decisions).map(([key, d]) => [key,
    { type: "choice", choice: d?.action, confidence: d?.confidence,
      probabilities: d?.probabilities }]));
  const parsed = parseHybridDecision({ answers, model: decision.model }, seam.request);
  for (const key of ["branch", "kind", "selected", "candidate_id", "fraction"])
    if (decision[key] !== parsed[key]) throw new Error("Contradictory or unoffered hybrid Choice");
  for (const [key, value] of Object.entries(parsed.context)) {
    if (decision.context?.[key] !== value) throw new Error("Stale hybrid context");
  }
  return parsed;
}

export function mockCitySeamDecision(seam) {
  // Explicit TEST choice only: choose the first City when actually offered;
  // otherwise wait. This is never used to replace a model-selected action.
  const city = Boolean(seam.request.questions.branch.criteria.city_build);
  const choices = Object.fromEntries(Object.entries(seam.request.questions).map(([name, q]) => {
    const choice = name === "branch" ? city ? "city_build" : "wait" :
      name === "city_site" ? Object.keys(q.criteria).find((key) => key !== "save_gold") ?? "save_gold" :
        "wait";
    return [name, { type: "choice", choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === choice ? 1 : 0])) }];
  }));
  return parseHybridDecision({ answers: choices, model: "explicit-mock-city-seam" }, seam.request);
}

export async function submitCitySeamDecision(decision, seam, isCurrent = () => true) {
  const parsed = validateCitySeamDecision(decision, seam);
  if (!isCurrent() || seam.world.game.ticks() !== seam.input.snapshot_tick)
    throw new Error("Decision is not current; no intent submitted");
  if (parsed.kind === "wait") return { kind: "wait", submitted: false };
  // This first seam has no land/naval/Post executor: fail closed rather than
  // turn another offered family into a City action or silent scripted attack.
  if (parsed.kind !== "city") throw new Error("Only the narrow City seam executor is implemented");
  if (!await seam.adapter.canExecute(parsed.candidate_id) ||
      !await seam.adapter.execute(parsed.candidate_id, isCurrent))
    throw new Error("City failed fresh worker/ownership/gold validation; no substitute");
  if (seam.queued.length !== 1) throw new Error("Adapter success did not queue exactly one normal intent");
  return { kind: "city", submitted: true, candidate_id: parsed.candidate_id };
}

const cityInventory = (world) => world.human.units(world.UnitType.City).map((unit) => ({
  id: unit.id(), tile: unit.tile(), level: unit.level(), active: unit.isActive(),
  under_construction: unit.isUnderConstruction() }));

export async function runMockHybridCity(options, { worldFactory = createFocusedEuropeWorld,
  now = () => performance.now(), sleep } = {}) {
  if (options.mode !== "mock") throw new Error("No live mode in this first City seam");
  if (!Number.isInteger(options.maxTicks) || options.maxTicks < 1 || options.maxTicks > 100)
    throw new Error("First City seam is bounded to 1..100 post-setup ticks");
  const paceTick = createTickPacer({ now, ...(sleep ? { sleep } : {}) });
  const world = await worldFactory(options, { paceTick });
  const seam = await prepareCitySeam(world, { gameId: options.seed });
  const decision = mockCitySeamDecision(seam);
  const before = { tick: world.game.ticks(), gold: world.human.gold().toString(),
    troop_capacity_internal: world.config.maxTroops(world.human), cities: cityInventory(world) };
  const result = await submitCitySeamDecision(decision, seam);
  const submitted = [];
  const observed = [];
  for (let i = 0; i < options.maxTicks && world.events.winEvents === 0; i++) {
    const intents = i === 0 ? seam.queued.splice(0) : [];
    await world.step(intents);
    submitted.push(...intents.map((intent) => ({ ...intent, submitted_tick: world.game.ticks() })));
    const state = { tick: world.game.ticks(), gold: world.human.gold().toString(),
      troop_capacity_internal: world.config.maxTroops(world.human), cities: cityInventory(world) };
    observed.push(state);
    // One mock Choice only. Stop after completion if a City was submitted;
    // otherwise consume only the explicitly bounded empty native turns.
    if (submitted.length && state.cities.some((city) => city.active && !city.under_construction)) break;
  }
  const winner = world.events.winEvents === 1 ? world.game.getWinner() : null;
  return { schema_version: 1, policy: POLICY_VERSION, hybrid_policy: HYBRID_POLICY_VERSION,
    mode: "mock", stage: "narrow-city-only", metadata: world.metadata,
    config: { seed: options.seed, minutes: options.minutes, max_ticks: options.maxTicks,
      tick_spacing_ms: 100, one_mock_choice: true, no_provider_mode: true },
    claims: seam.claims, input: seam.input,
    mock_request: seam.request, mock_decision: decision, dispatch: result,
    before, submitted_normal_intents: submitted,
    observed_city_states: observed,
    worker_queries: seam.view.workerQueries,
    conquests: world.events.conquests, win_events: world.events.winEvents,
    complete: Boolean(winner), win: winner ? winner === world.human : null,
    status: winner ? "engine-win" : submitted.length ? "bounded-city-observation" : "bounded-no-city-intent",
    after: { tick: world.game.ticks(), gold: world.human.gold().toString(),
      cities: cityInventory(world), hash: world.game.hash() } };
}

async function main() {
  const options = parseHybridEuropeArgs(process.argv.slice(2));
  console.debug = () => {};
  const report = await runMockHybridCity(options);
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Offline City seam: ${report.input.building.candidates.length} worker-legal sites, ` +
    `${report.submitted_normal_intents.length} normal intents, ${report.after.cities.length} observed Cities; ` +
    `${report.status}; ${options.output}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
