// The default CLI remains the original offline City seam. Explicit --loop
// adds a bounded flat LAND + CITY benchmark; no navy/Post/decomposed executor.
// --live requires --loop and an explicit cap; never invoked by unit tests.
// No core mutation, fake gold, hidden action substitution or direct build.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleepMs } from "node:timers/promises";
import { createBuildingAdapter } from "../web/building-adapter.js";
import { createGameAdapter } from "../web/game-adapter.js";
import { buildActions } from "../web/observation.js";
import { projectTribeFocus, recoverSingleActiveTribe, recordTribeLandIntent,
  selectedTribeForFocus } from "../web/tribe-focus.js";
import { validateHybridInput } from "../web/hybrid-observation.js";
import { buildHybridRequest, parseHybridDecision, HYBRID_POLICY_VERSION,
} from "../src/hybrid-policy.mjs";
import { POLICY_VERSION } from "../src/policy.mjs";
import { createTickPacer, createPacedDecisionClient, timedWinCheckBoundary,
} from "./benchmark-jev-observation.mjs";
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
      if (prop === "units" && typeof target.units === "function")
        return (...types) => target.units(...types).map(unitView);
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
  const land = observeFocusedCore(game, human, focus, history, { gameId });
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

const BASE = "http://127.0.0.1:8788";

export function parseHybridLoopArgs(argv) {
  const filtered = [];
  let mockChoice = "first-offered", customized = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--loop") continue;
    if (argv[i] === "--mock-choice") {
      if (customized || !["first-offered", "wait-city"].includes(argv[i + 1]))
        throw new Error("--mock-choice must be first-offered or wait-city, once");
      mockChoice = argv[++i]; customized = true;
    } else filtered.push(argv[i]);
  }
  const options = parseFocusedEuropeArgs(filtered);
  if (options.mode === "live" && customized)
    throw new Error("Mock action controls are forbidden in live mode");
  return { ...options, mockChoice, output: filtered.includes("--output") ? options.output :
    "logs/benchmark-hybrid-europe-loop.json" };
}

function createLandCityEnvelope(world, gameId) {
  const view = createHybridEuropeFacade(world, gameId);
  const queued = [];
  let dispatchGuard = () => true;
  const canQueue = () => world.read().ready && !world.read().ended &&
    queued.length === 0 && dispatchGuard();
  const city = createBuildingAdapter({ game: view.game, read: world.read,
    cityUnit: world.UnitType.City, sendBuild: (unit, tile) => {
      if (!canQueue() || unit !== world.UnitType.City || !world.game.isValidRef(tile)) return false;
      queued.push({ type: "build_unit", clientID: world.clientID, unit, tile });
      return true;
    } });
  const land = createGameAdapter({ game: view.game, read: world.read,
    sendAttack: (targetID, troops) => {
      if (!canQueue() || !Number.isSafeInteger(troops) || troops < 1) return false;
      queued.push({ type: "attack", clientID: world.clientID, targetID, troops });
      return true;
    } });
  return { view, queued, city, land,
    setDispatchGuard: (guard) => { dispatchGuard = guard; } };
}

function mockLoopReply(request, control) {
  const hasCity = Boolean(request.questions.branch.criteria.city_build);
  const branch = hasCity ? "city_build" : control === "first-offered" &&
    request.questions.branch.criteria.land_attack ? "land_attack" : "wait";
  const answers = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => {
    const choice = name === "branch" ? branch : name === "city_site" ?
      Object.keys(q.criteria).find((key) => key !== "save_gold") ?? "save_gold" :
      Object.keys(q.criteria).find((key) => key !== "wait") ?? "wait";
    return [name, { type: "choice", choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === choice ? 1 : 0])) }];
  }));
  return parseHybridDecision({ answers, model: `explicit-mock-${control}` }, request);
}

// Explicit bounded flat loop: every offered land/City/wait branch is supported.
// Transport/Post/upgrades/diplomacy are absent, not silently mishandled.
export async function runHybridEuropeLoop(options, {
  worldFactory = createFocusedEuropeWorld, fetchImpl = fetch,
  now = () => performance.now(), sleep = sleepMs, isCurrent = () => true,
} = {}) {
  if (!["mock", "live"].includes(options.mode) ||
      !Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 300 ||
      !Number.isInteger(options.maxTicks) || options.maxTicks < 1 || options.maxTicks > 73000)
    throw new Error("Invalid bounded hybrid loop options");
  if (options.mode === "live") {
    const response = await fetchImpl(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error("Local health check failed");
    const health = await response.json();
    if (health.policy !== POLICY_VERSION || health.hybridPolicy !== HYBRID_POLICY_VERSION ||
        health.keyConfigured !== true || health.hybridEnabled !== true ||
        health.requiresStart !== true || health.sessionActive !== false ||
        health.plannerEnabled !== false) throw new Error("Sidecar version/idle/hybrid/Start state mismatch");
  }
  const paceTick = createTickPacer({ now, sleep });
  const world = await worldFactory(options, { paceTick });
  const { game, human, config, events } = world;
  const envelope = createLandCityEnvelope(world, options.seed);
  let token = null, started = false, revoked = false, stopError = null;
  let attempts = 0, responses = 0, ticks = 0, lastSecond = -1;
  let focus = null, history = null, proposal = null, proposalAt = -Infinity;
  let proposalCapturedAt = -Infinity;
  let nextScanTick = -Infinity, wasAffordable = false;
  let status = "censored-tick-cap", phase = "start", error = null;
  const records = [], submitted = [], cityEvents = [], scans = [], requestStarts = [];
  const before = { tick: game.ticks(), gold: human.gold().toString(),
    troops_internal: human.troops(), tiles: human.numTilesOwned(),
    troop_capacity_internal: config.maxTroops(human), cities: cityInventory(world) };
  const knownCityStates = new Map(before.cities.map((city) => [city.id, JSON.stringify(city)]));
  try {
    if (options.mode === "live") {
      const response = await fetchImpl(`${BASE}/session`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "hybrid", limit: options.maxCalls }),
        signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error("Local Start failed");
      const start = await response.json();
      if (typeof start.token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(start.token))
        throw new Error("Invalid Start token; cannot authenticate Stop");
      token = start.token;
      if (start.mode !== "hybrid" || start.limit !== options.maxCalls || start.plan_limit !== 0)
        throw new Error("Invalid hybrid Start contract");
      started = true;
    }
    const transport = async (_url, init) => {
      // Reuse the shared one-second, single-flight request client, adapting
      // ONLY its land endpoint/response envelope to the flat hybrid protocol.
      const input = JSON.parse(init.body);
      if (options.mode === "mock") {
        const d = mockLoopReply(buildHybridRequest(input), options.mockChoice ?? "first-offered");
        return { ok: true, json: async () => ({ action: d.selected, hybrid_response: d }) };
      }
      const response = await fetchImpl(`${BASE}/hybrid-decision`, init);
      if (!response.ok) return response;
      const d = await response.json();
      return { ok: true, json: async () => ({ action: d?.selected, hybrid_response: d }) };
    };
    const ask = createPacedDecisionClient({ fetchImpl: transport, baseUrl: BASE,
      now, sleep, sessionHeaders: () => options.mode === "live" ? { "X-Agent-Session": token } : {} });
    while (ticks < options.maxTicks && events.winEvents === 0) {
      if (!isCurrent()) { status = "canceled"; break; }
      if (!human.isAlive()) { status = "human-eliminated-before-win-event"; break; }
      const second = Math.floor(game.elapsedGameSeconds());
      let landCommit = null;
      if (!timedWinCheckBoundary(game.elapsedGameSeconds(), options.minutes) && second !== lastSecond) {
        lastSecond = second;
        // Start BEFORE preparation/scans/worker observation, not after pacing
        // or inference. Paused engine ticks do not waive the wall-age bound.
        const capturedAt = now();
        phase = "scan";
        const cost = config.unitInfo(world.UnitType.City).cost(game, human);
        if (typeof cost !== "bigint" || cost < 0n) throw new Error("Current City cost unavailable");
        const affordable = human.gold() >= cost;
        if (!affordable) {
          proposal = null;
          wasAffordable = false;
        } else if (!wasAffordable || game.ticks() >= nextScanTick) {
          proposalCapturedAt = capturedAt;
          proposal = await envelope.city.propose({ mapId: "europe-compact", maxCandidates: 4,
            maxExamined: 256, maxWorkerChecks: 8, coverageRadius: 6 });
          proposalAt = now();
          nextScanTick = game.ticks() + (proposal.candidates.length ? 150 : 50);
          scans.push({ tick: game.ticks(), proposal });
          wasAffordable = true;
        }
        phase = "observe";
        let snapshot = await envelope.land.observe({ focusId: focus?.id ?? null });
        if (!focus) {
          const recovered = recoverSingleActiveTribe(snapshot.observation);
          if (recovered !== null) {
            focus = { id: recovered, player_id: game.playerBySmallID(recovered).id() };
            snapshot = await envelope.land.observe({ focusId: recovered });
          }
        }
        if (focus && snapshot.focus_status?.player_id &&
            snapshot.focus_status.player_id !== focus.player_id) {
          status = "censored-focus-unavailable"; break;
        }
        const projected = projectTribeFocus(snapshot, focus?.id ?? null, history);
        if (projected.kind === "unavailable") {
          records.push({ tick: snapshot.tick, call: "not-sent", reason: "focus-unavailable",
            focus_status: snapshot.focus_status });
        } else {
          if (projected.kind === "conquered") focus = null;
          history = projected.history;
          const currentCity = proposal && now() - proposalAt <= 1500 &&
            game.ticks() - proposal.source_tick <= 20 &&
            proposal.available_gold === human.gold().toString() ? proposal : null;
          const input = validateHybridInput({ game_id: options.seed, snapshot_tick: snapshot.tick,
            land: projected.observation, building: currentCity, plan: null,
            city_mechanics: { troop_capacity_gain_display: config.cityTroopIncrease() / 10,
              construction_ticks: config.unitInfo(world.UnitType.City).constructionDuration } });
          const request = buildHybridRequest(input);
          const payloadCapturedAt = currentCity ? Math.min(capturedAt, proposalCapturedAt) : capturedAt;
          const dispatchFresh = () => {
            const state = world.read();
            const age = now() - payloadCapturedAt;
            return age >= 0 && age <= 2000 && state.ready && !state.ended &&
              state.tick === input.snapshot_tick && game.ticks() === input.snapshot_tick &&
              (!currentCity || input.snapshot_tick - currentCity.source_tick <= 20);
          };
          const canDispatch = () => isCurrent() && dispatchFresh();
          envelope.setDispatchGuard(canDispatch);
          const landIdentities = new Map(input.land.neighbors.map((p) =>
            [p.id, game.playerBySmallID(p.id).id()]));
          const record = { tick: snapshot.tick, captured_at_ms: payloadCapturedAt,
            input, offered_request: request,
            city_scan: !affordable ? "unaffordable-real-core-preflight" :
              currentCity ? "current-worker-proposal" : "proposal-expired-no-current-city-option" };
          if (Object.keys(request.questions.branch.criteria).length === 1) {
            record.call = "wait-only-no-request";
            records.push(record);
          } else {
            if (attempts >= options.maxCalls) { status = "censored-call-cap"; break; }
            attempts++;
            phase = "decision";
            let response;
            try {
              response = await ask(input);
              responses++;
              requestStarts.push(response.startedAtMs);
              record.request_started_at_ms = response.startedAtMs;
              record.latency_ms = response.latencyMs;
            } catch {
              status = "censored-decision-error";
              records.push({ ...record, call: options.mode, error: "Decision failed/timed out; no retry" });
              break;
            }
            // Retain the normalized local reply BEFORE revalidation or
            // dispatch. A returned City choice must not be relabeled as an
            // accepted build if the subsequent worker/tick/gold check fails.
            record.call = options.mode;
            record.model_reply = response.decision.hybrid_response;
            record.normal_intent_queued = false;
            records.push(record);
            phase = "validate-choice";
            const decision = validateCitySeamDecision(record.model_reply, { request });
            record.validated_choice = decision;
            if (!isCurrent()) { status = "canceled-or-stale"; break; }
            if (!dispatchFresh()) {
              record.age_at_dispatch_ms = now() - payloadCapturedAt;
              status = "censored-stale"; break;
            }
            phase = "execute";
            if (decision.kind === "city") {
              const legal = await envelope.city.canExecute(decision.candidate_id);
              record.age_at_dispatch_ms = now() - payloadCapturedAt;
              if (!canDispatch()) { status = isCurrent() ? "censored-stale" : "canceled-or-stale"; break; }
              const sent = legal && await envelope.city.execute(decision.candidate_id, canDispatch);
              record.age_at_dispatch_ms = now() - payloadCapturedAt;
              if (!canDispatch()) { status = isCurrent() ? "censored-stale" : "canceled-or-stale"; break; }
              if (!sent) throw new Error("Selected City failed fresh legality; no substitute");
            } else if (decision.kind === "land") {
              const action = buildActions(input.land)[decision.selected];
              if (action?.target_id !== null && action?.target_id !== undefined) {
                const target = game.playerBySmallID(action.target_id);
                const expected = input.land.neighbors.find((p) => p.id === action.target_id);
                const kind = { BOT: "tribe", NATION: "nation", HUMAN: "human" }[target.type()];
                if (!expected || expected.type !== kind ||
                    target.id() !== landIdentities.get(action.target_id))
                  throw new Error("Selected land target identity/type changed");
              }
              if (!action || action.kind !== "attack") throw new Error("Unoffered land choice");
              const legal = await envelope.land.canExecute(action);
              record.age_at_dispatch_ms = now() - payloadCapturedAt;
              if (!canDispatch()) { status = isCurrent() ? "censored-stale" : "canceled-or-stale"; break; }
              if (!legal || !envelope.land.execute(action))
                throw new Error("Selected land action failed fresh legality; no substitute");
              landCommit = { action, observation: input.land, tick: snapshot.tick };
            } else if (decision.kind !== "wait") {
              throw new Error("Unimplemented branch was not offered");
            }
            record.age_at_dispatch_ms = now() - payloadCapturedAt;
            record.normal_intent_queued = envelope.queued.length === 1;
          }
        }
      }
      phase = "tick";
      const intents = envelope.queued.splice(0);
      await world.step(intents);
      ticks++;
      submitted.push(...intents.map((intent) => ({ ...intent, submitted_tick: game.ticks() })));
      // Counts are promoted ONLY after normal turn submission succeeds. The
      // reference tick/tiles remain that choice's pre-inference observation.
      if (landCommit && intents.some((i) => i.type === "attack")) {
        const id = selectedTribeForFocus(landCommit.action, landCommit.observation);
        if (id !== null) {
          if (!focus || focus.id !== id) history = null;
          focus = { id, player_id: game.playerBySmallID(id).id() };
          history = recordTribeLandIntent(history, landCommit.observation, id,
            landCommit.action.fraction, landCommit.tick);
        }
      }
      const owned = cityInventory(world);
      for (const city of owned) {
        const state = JSON.stringify(city);
        if (knownCityStates.get(city.id) !== state) {
          const matching = submitted.findLast((i) => i.type === "build_unit" && i.tile === city.tile);
          cityEvents.push({ tick: game.ticks(), city,
            stage: !knownCityStates.has(city.id) ? "first-observed-owned-city" :
              city.under_construction ? "observed-under-construction" : "observed-completed-city",
            matches_submitted_tile: Boolean(matching),
            gold: human.gold().toString(), troop_capacity_internal: config.maxTroops(human) });
          knownCityStates.set(city.id, state);
        }
      }
      for (const id of [...knownCityStates.keys()]) if (!owned.some((city) => city.id === id)) {
        cityEvents.push({ tick: game.ticks(), unit_id: id, stage: "no-longer-in-owned-city-inventory" });
        knownCityStates.delete(id);
      }
    }
    if (events.winEvents > 1 || (events.winEvents === 1 && !game.getWinner()))
      throw new Error("Inconsistent engine Win event");
    if (events.winEvents === 1) status = "engine-win";
  } catch {
    error = { phase, message: "Hybrid run failed closed; no retry or substitute" };
    status = phase === "decision" ? "censored-decision-error" :
      ["validate-choice", "execute"].includes(phase) ? "censored-invalid-choice" : "censored-runtime-error";
  } finally {
    if (token) {
      try {
        const response = await fetchImpl(`${BASE}/session`, { method: "DELETE",
          headers: { "X-Agent-Session": token }, signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error("Stop failed");
        revoked = true;
      } catch { stopError = "Local Stop failed; no retry"; }
      token = null;
    }
  }
  const complete = events.winEvents === 1 && Boolean(game.getWinner());
  const winner = complete ? game.getWinner() : null;
  const tribes = new Set(world.metadata.roster.filter((p) => p.type === "BOT").map((p) => p.id));
  const conquests = events.conquests.filter((e) => e.conquerorId === human.id() && tribes.has(e.conqueredId));
  const standings = (game.allPlayers?.() ?? []).map((p) => ({ id: p.id(), name: p.name(),
    type: p.type(), alive: p.isAlive(), tiles: p.numTilesOwned(),
    troops_internal: p.troops(), gold: p.gold().toString(),
    troop_capacity_internal: config.maxTroops(p) })).sort((a, b) => b.tiles - a.tiles);
  return { schema_version: 1, stage: "flat-land-city-loop", mode: options.mode,
    policy: POLICY_VERSION, hybrid_policy: HYBRID_POLICY_VERSION, metadata: world.metadata,
    config: { seed: options.seed, max_calls: options.maxCalls, max_ticks: options.maxTicks,
      timer_minutes: options.minutes, tick_spacing_ms: 100, request_spacing_ms: 1000,
      game_paused_during_inference: true, dispatch_max_wall_age_ms: 2000,
      dispatch_max_tick_age: 20, dispatch_requires_same_tick: true,
      city_heavy_scan_ticks: 150, city_absent_scan_ticks: 50,
      actual_core_cost_preflight: true, custom_starting_gold: false,
      mock_choice: options.mode === "mock" ? options.mockChoice ?? "first-offered" : null,
      navy_enabled: false, posts_enabled: false, planner_enabled: false },
    status, error, complete, win: winner ? winner === human : null,
    human_eliminated_before_win: !human.isAlive() && !complete,
    winner: winner ? { id: winner.id(), name: winner.name(), wire: events.wireWinner } : null,
    win_rule: { source: "native WinCheckExecution FFA, every tenth tick",
      conditions: "largest alive territory; strict non-fallout land-share threshold OR configured timer OR 170-minute hard limit",
      timer_minutes: options.minutes,
      final_share_threshold_percent: config.percentageTilesOwnedToWin?.(game.elapsedGameSeconds()) ?? null,
      non_fallout_land_tiles: typeof game.numLandTiles === "function" ?
        game.numLandTiles() - game.numTilesWithFallout() : null },
    counts: { mock_requests: options.mode === "mock" ? attempts : 0,
      local_decision_attempts: options.mode === "live" ? attempts : 0,
      successful_local_responses: options.mode === "live" ? responses : 0,
      paid_calls_not_verified_here: true, human_tribe_conquests: conquests.length },
    session: { started, revoked, stop_error: stopError }, before,
    after: { tick: game.ticks(), seconds: game.elapsedGameSeconds(), live_ticks: ticks,
      alive: human.isAlive(), tiles: human.numTilesOwned(), gold: human.gold().toString(),
      troops_internal: human.troops(), troop_capacity_internal: config.maxTroops(human),
      cities: cityInventory(world), hash: game.hash() },
    decisions: records, submitted_normal_intents: submitted, observed_city_events: cityEvents,
    city_scans: scans, conquests: events.conquests, conquest_gold:
      conquests.reduce((sum, e) => sum + BigInt(e.gold), 0n).toString(),
    win_events: events.winEvents, standings,
    timing: { tick_starts_ms: world.tickStarts, request_starts_ms: requestStarts } };
}

async function main() {
  const argv = process.argv.slice(2);
  const loop = argv.includes("--loop");
  const options = loop ? parseHybridLoopArgs(argv) : parseHybridEuropeArgs(argv);
  console.debug = () => {};
  let running = true;
  const stop = () => { running = false; };
  process.on("SIGINT", stop);
  let report;
  try {
    report = loop ? await runHybridEuropeLoop(options, { isCurrent: () => running }) :
      await runMockHybridCity(options);
  } finally { process.off("SIGINT", stop); }
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + "\n");
  console.log(`${loop ? `${options.mode} flat land+City loop` : "Offline City seam"}: ` +
    `${report.submitted_normal_intents.length} normal intents, ` +
    `${report.after.cities.length} observed owned Cities; ${report.status}; ${options.output}`);
  if (report.session?.stop_error || report.status.includes("error") ||
      report.status === "censored-invalid-choice" || report.status === "censored-stale" ||
      (loop && options.mode === "live" && !report.complete)) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
