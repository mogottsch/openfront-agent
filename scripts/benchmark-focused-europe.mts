// Import-safe, explicitly bounded actual-engine Europe/Compact benchmark.
// --mock is network-free and labels every fake Choice. --live is opt-in and
// only contacts the already-running loopback sidecar. Never reads credentials.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { actionCriteria, buildActions } from "../web/observation.js";
import { POLICY_VERSION } from "../src/policy.mjs";
import { projectTribeFocus, recoverSingleActiveTribe, recordTribeLandIntent,
  selectedTribeForFocus } from "../web/tribe-focus.js";
import { createPacedDecisionClient, createTickPacer, observeCore,
  recheckCoreAction, startBenchmarkSession, timedWinCheckBoundary,
} from "./benchmark-jev-observation.mjs";

const NATION_NAMES = ["England", "Spain", "Switzerland"];
const HUMAN_SPAWN = [543, 491];
const BASE_URL = "http://127.0.0.1:8788";

export class StaleSubmissionError extends Error {
  constructor() { super("Captured intent stale at native turn submission"); this.name = "StaleSubmissionError"; }
}

// The optional guard is checked AFTER pacing and BEFORE addTurn. Historical
// one-argument callers and empty native-AI/wait turns retain their behavior.
export function createFocusedCoreStepper(runner, { paceTick, tickStarts, tickError = () => null }) {
  let turnNumber = 0;
  return async (intents = [], submitGuard) => {
    const started = await paceTick();
    if (intents.length && submitGuard !== undefined &&
        (typeof submitGuard !== "function" || submitGuard() !== true)) throw new StaleSubmissionError();
    runner.addTurn({ turnNumber: turnNumber++, intents });
    const executed = runner.executeNextTick(), fatal = tickError();
    if (!executed || fatal) throw new Error(`Engine tick failed: ${fatal}`);
    tickStarts.push(started);
  };
}

export function parseFocusedEuropeArgs(argv) {
  const result = { mode: null, seed: "europe-focus-001", maxCalls: 3,
    maxTicks: 60, minutes: 5, output: "logs/benchmark-focused-europe.json" };
  let explicitCap = false;
  const seen = new Set();
  const positive = (text, flag, max) => {
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      throw new Error(`${flag} requires 1..${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`Duplicate flag ${flag}`);
    seen.add(flag);
    if (flag === "--mock" || flag === "--live") {
      if (result.mode !== null) throw new Error("Choose exactly one of --mock or --live");
      result.mode = flag.slice(2);
      continue;
    }
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--seed") {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("Invalid seed");
      result.seed = value;
    } else if (flag === "--max-calls") {
      result.maxCalls = positive(value, flag, 300);
      explicitCap = true;
    } else if (flag === "--max-ticks") result.maxTicks = positive(value, flag, 73000);
    else if (flag === "--minutes") result.minutes = positive(value, flag, 120);
    else if (flag === "--output") {
      const path = resolve(value);
      const logs = resolve("logs") + "/";
      if (!path.startsWith(logs) || !path.endsWith(".json"))
        throw new Error("Output must be an ignored logs/*.json path");
      result.output = value;
    } else throw new Error(`Unknown flag ${flag}`);
  }
  if (result.mode === null) throw new Error("Explicit --mock or --live required; no default network calls");
  if (result.mode === "live" && !explicitCap)
    throw new Error("--live requires explicit --max-calls before local Start");
  return result;
}

// Exact fresh map/config/roster setup from D's benchmark-europe-tribes.mts.
// Native tribe/nation behavior continues on every real engine tick.
export async function createFocusedEuropeWorld(options, { paceTick } = {}) {
  const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
  const load = (file) => import(pathToFileURL(resolve(root, file)).href);
  const { Config } = await load("src/core/configuration/Config.ts");
  const { Executor } = await load("src/core/execution/ExecutionManager.ts");
  const { GameRunner } = await load("src/core/GameRunner.ts");
  const { createGame } = await load("src/core/game/GameImpl.ts");
  const { GameMapImpl } = await load("src/core/game/GameMap.ts");
  const { createNationsForGame } = await load("src/core/game/NationCreation.ts");
  const { GameUpdateType } = await load("src/core/game/GameUpdates.ts");
  const { PseudoRandom } = await load("src/core/PseudoRandom.ts");
  const { simpleHash } = await load("src/core/Util.ts");
  const { PlayerInfo, PlayerType, GameMapType, GameMapSize, GameMode,
    GameType, Difficulty, UnitType } = await load("src/core/game/Game.ts");
  const dir = resolve(root, "resources/maps/europe");
  const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
  const terrain = await readFile(resolve(dir, "map4x.bin"));
  const mini = await readFile(resolve(dir, "map16x.bin"));
  const fresh = (meta, data) => {
    if (data.length !== meta.width * meta.height) throw new Error("Invalid Europe map binary");
    return new GameMapImpl(meta.width, meta.height, new Uint8Array(data), meta.num_land_tiles);
  };
  const nationManifest = NATION_NAMES.map((name) => {
    const nation = manifest.nations.find((n) => n.name === name);
    if (!nation?.coordinates) throw new Error(`Missing Europe nation ${name}`);
    return { ...nation, coordinates: nation.coordinates.map((n) => Math.floor(n / 2)) };
  });
  const setup = { gameMap: GameMapType.Europe, gameMapSize: GameMapSize.Compact,
    gameMode: GameMode.FFA, gameType: GameType.Singleplayer, difficulty: Difficulty.Easy,
    nations: 3, bots: 12, donateGold: false, donateTroops: false,
    infiniteGold: false, infiniteTroops: false, instantBuild: false,
    randomSpawn: false, maxTimerValue: options.minutes };
  const config = new Config(setup, null, false);
  const random = new PseudoRandom(simpleHash(options.seed));
  const clientID = "human-client";
  const info = new PlayerInfo("Bench", PlayerType.Human, clientID, random.nextID());
  const nations = createNationsForGame({ gameID: options.seed, lobbyCreatedAt: 0,
    config: setup, players: [{ username: "Bench", clientID }] }, nationManifest, [], 1, random);
  const game = createGame([info], nations, fresh(manifest.map4x, terrain),
    fresh(manifest.map16x, mini), config);
  if (!game.isValidCoord(...HUMAN_SPAWN) || !game.isLand(game.ref(...HUMAN_SPAWN)) ||
      game.isImpassable(game.ref(...HUMAN_SPAWN))) throw new Error("Invalid Compact human spawn");
  let fatal = null;
  const events = { conquests: [], winEvents: 0, wireWinner: null };
  const runner = new GameRunner(game, new Executor(game, options.seed, clientID), (u) => {
    if ("errMsg" in u) { fatal = u.errMsg; return; }
    for (const e of u.updates[GameUpdateType.ConquestEvent] ?? []) {
      events.conquests.push({ tick: u.tick, conquerorId: e.conquerorId,
        conqueredId: e.conqueredId, gold: e.gold.toString() });
    }
    for (const e of u.updates[GameUpdateType.Win] ?? []) {
      events.winEvents++;
      events.wireWinner = e.winner ?? null;
    }
  });
  runner.init();
  const human = game.player(info.id);
  const tickStarts = [];
  const step = createFocusedCoreStepper(runner, { paceTick, tickStarts, tickError: () => fatal });
  await step([{ type: "spawn", clientID, tile: game.ref(...HUMAN_SPAWN) }]);
  for (let i = 0; i < 10 && game.inSpawnPhase(); i++) await step();
  if (game.inSpawnPhase() || !human.hasSpawned()) throw new Error("Human spawn failed");
  for (let i = 0; i < 8 && game.allPlayers().filter((p) => p.hasSpawned()).length < 16; i++) await step();
  const opponents = game.allPlayers().filter((p) => p !== human);
  if (opponents.filter((p) => p.type() === PlayerType.Bot).length !== 12 ||
      opponents.filter((p) => p.type() === PlayerType.Nation).length !== 3 ||
      opponents.some((p) => !p.hasSpawned())) throw new Error("Native AI roster incomplete");
  return { game, human, clientID, events, step, tickStarts,
    // Read-only integration seam for future hybrid headless adapters; no
    // gameplay/config change, wrapper mutation, or automatic extra intent.
    runner, config, UnitType,
    read: () => ({ tick: game.ticks(),
      ready: !game.inSpawnPhase() && human.hasSpawned() && human.isAlive() &&
        game.getWinner() === null,
      ended: !human.isAlive() || game.getWinner() !== null }),
    metadata: { engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8" }).trim(), map: "Europe", mapSize: "Compact", difficulty: "Easy",
      width: game.width(), height: game.height(), humanSpawn: HUMAN_SPAWN,
      nativeNations: NATION_NAMES, bots: 12,
      roster: opponents.map((p) => ({ id: p.id(), smallID: p.smallID(), type: p.type(),
        name: p.name(), spawn: [game.x(p.spawnTile()), game.y(p.spawnTile())] })) } };
}

// Current core facts for an ALREADY selected/recovered tribe. Absence from the
// current neighbor list is never used as evidence of death or identity.
export function observeFocusedCore(game, human, focus, history, { gameId } = {}) {
  // Optional actual seed identity enables cheap source-stamped unit facts;
  // historical four-argument callers retain their original unknown/absent fields.
  const raw = gameId === undefined ? observeCore(game, human) :
    observeCore(game, human, { gameId });
  // Private live identities bind a Choice to the exact players observed,
  // rather than allowing smallID reuse to redirect an asynchronous answer.
  const targetIdentities = new Map(raw.observation.neighbors.map((p) =>
    [p.id, game.playerBySmallID(p.id).id()]));
  if (!focus) return { ...raw, targetIdentities, focusedId: null, history: null,
    focusStatus: null, focusKind: "none", identity: null };
  let other;
  try { other = game.playerBySmallID(focus.id); } catch { other = null; }
  let status = { status: "unavailable", id: focus.id, tick: raw.tick, reason: "player_unresolved" };
  if (other?.isPlayer?.() && other.smallID() === focus.id &&
      (!focus.player_id || focus.player_id === other.id())) {
    const kind = { BOT: "tribe", NATION: "nation", HUMAN: "human" }[other.type()];
    if (other.isAlive() === false) status = { status: "dead", id: focus.id, tick: raw.tick,
      alive: false, type: kind, game_id: focus.game_id, player_id: other.id() };
    else if (other.isAlive() === true) {
      const neighbor = raw.observation.neighbors.find((p) => p.id === focus.id);
      status = { status: "available", id: focus.id, tick: raw.tick,
        alive: true, type: kind, game_id: focus.game_id, player_id: other.id(),
        territory_tiles: other.numTilesOwned(),
        target_reserve_troops: Math.max(0, Math.floor(other.troops() / 10)),
        adjacent: Boolean(neighbor), worker_checked: Boolean(neighbor),
        can_attack: neighbor?.can_attack === true };
    }
  } else if (other?.isPlayer?.()) status.reason = "identity_changed";
  if (game.ticks() !== raw.tick) status = { status: "unavailable", id: focus.id,
    tick: raw.tick, reason: "stale_snapshot" };
  const projected = projectTribeFocus({ ...raw, focus_status: status }, focus.id, history);
  return { ...raw, targetIdentities, observation: projected.observation,
    actions: projected.observation ? buildActions(projected.observation) : {},
    focusedId: projected.focusedId, history: projected.history,
    focusKind: projected.kind, focusStatus: status,
    identity: status.player_id ?? null };
}

// Inject clock/fetch/world only for network-free unit tests. CLI live never
// supplies a fake and never contacts any provider except the loopback sidecar.
export async function runFocusedEurope(options, {
  worldFactory = createFocusedEuropeWorld, fetchImpl = fetch,
  now = () => performance.now(), sleep,
} = {}) {
  if (!["mock", "live"].includes(options.mode) ||
      !Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 300 ||
      !Number.isInteger(options.maxTicks) || options.maxTicks < 1 || options.maxTicks > 73000 ||
      !Number.isInteger(options.minutes) || options.minutes < 1 || options.minutes > 120)
    throw new Error("Invalid bounded focused-Europe run options");
  let session = null;
  // Retain an identifiable Start token only in this closure. Even a malformed
  // Start response with a known token must be revoked before failing closed.
  let startedToken = null;
  let revoked = false;
  let stopError = null;
  let report;
  if (options.mode === "live") {
    const response = await fetchImpl(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`Local sidecar health HTTP ${response.status}`);
    const health = await response.json();
    if (health.policy !== POLICY_VERSION || !health.keyConfigured ||
        health.requiresStart !== true || health.sessionActive !== false)
      throw new Error("Sidecar policy/key/Start state mismatch; no session started");
  }
  const paceTick = createTickPacer({ now, ...(sleep ? { sleep } : {}) });
  // Spawn/setup the isolated headless game before Start so provider budget
  // cannot be consumed by a map-loading/roster error.
  const world = await worldFactory(options, { paceTick });
  const { game, human, events } = world;
  let attempts = 0;
  let responses = 0;
  let liveTicks = 0;
  let focus = null;
  let history = null;
  let lastDecisionSecond = -1;
  let status = "censored-tick-cap";
  const decisions = [];
  const emitted = [];
  const focusEvents = [];
  const requestStarts = [];
  const snapshots = [];
  const mockFetch = async (_url, init) => {
    const o = JSON.parse(init.body);
    const offered = buildActions(o);
    const action = Object.keys(offered).find((id) => id !== "wait") ?? "wait";
    return { ok: true, json: async () => ({ action, model: "explicit-mock-first-offered" }) };
  };
  const before = { tick: game.ticks(), tiles: human.numTilesOwned(),
    troops_internal: human.troops(), gold: human.gold().toString() };
  try {
    if (options.mode === "live") session = await startBenchmarkSession({
      limit: options.maxCalls, baseUrl: BASE_URL,
      fetchImpl: async (url, init) => {
        const response = await fetchImpl(url, init);
        if (init?.method !== "POST" || !response.ok) return response;
        const data = await response.json();
        if (typeof data?.token === "string" && /^[A-Za-z0-9_-]{32}$/.test(data.token))
          startedToken = data.token;
        return { ok: response.ok, status: response.status, json: async () => data };
      },
    });
    const ask = createPacedDecisionClient({ fetchImpl: options.mode === "mock" ? mockFetch : fetchImpl,
      now, ...(sleep ? { sleep } : {}), sessionHeaders: session?.headers,
      baseUrl: BASE_URL });
    while (liveTicks < options.maxTicks && events.winEvents === 0) {
      if (!human.isAlive()) { status = "human-eliminated-before-win-event"; break; }
      const intents = [];
      const second = Math.floor(game.elapsedGameSeconds());
      // Timer WinCheck runs on a tick AFTER the exact timer boundary. Do not
      // buy a 301st decision; allow only its bounded empty-turn grace window.
      const atTimer = timedWinCheckBoundary(game.elapsedGameSeconds(), options.minutes);
      if (!atTimer && second !== lastDecisionSecond) {
        lastDecisionSecond = second;
        let snapshot = observeFocusedCore(game, human, focus, history, { gameId: options.seed });
        if (!focus) {
          const recovered = recoverSingleActiveTribe(snapshot.observation);
          if (recovered !== null) {
            const target = game.playerBySmallID(recovered);
            focus = { id: recovered, player_id: target.id(), game_id: options.seed };
            snapshot = observeFocusedCore(game, human, focus, null, { gameId: options.seed });
            focusEvents.push({ tick: snapshot.tick, event: "recovered_active_tribe", id: recovered });
          }
        }
        if (snapshot.focusKind === "unavailable") {
          // Retain focus, report it, advance with no new intent. Never spend a
          // model call on a fabricated focus or choose a replacement target.
          decisions.push({ tick: snapshot.tick, call: "not-sent", reason: "focus-unavailable",
            focus_status: snapshot.focusStatus });
        } else {
          if (snapshot.focusKind === "conquered") {
            focusEvents.push({ tick: snapshot.tick, event: "authoritative_dead",
              id: focus.id, player_id: focus.player_id });
            focus = null;
          }
          history = snapshot.history;
          const criteria = actionCriteria(snapshot.actions);
          const record = { tick: snapshot.tick, observation: snapshot.observation,
            candidates: criteria, focus_status: snapshot.focusStatus };
          let choice = "wait";
          if (Object.keys(snapshot.actions).length > 1) {
            if (attempts >= options.maxCalls) { status = "censored-call-cap"; break; }
            attempts++;
            try {
              const answer = await ask(snapshot.observation);
              responses++;
              requestStarts.push(answer.startedAtMs);
              choice = answer.decision.action;
              Object.assign(record, { call: options.mode, decision: answer.decision,
                request_started_at_ms: answer.startedAtMs, latency_ms: answer.latencyMs });
            } catch (error) {
              status = "censored-decision-error";
              Object.assign(record, { call: options.mode,
                error: /^Local decision HTTP \d+$/.test(error?.message) ? error.message :
                  "Decision failed or timed out; no retry" });
              decisions.push(record);
              break;
            }
          } else record.call = "wait-only-no-request";
          try {
            const action = recheckCoreAction(game, human, snapshot, choice);
            record.selected_id = choice;
            if (action.kind === "attack") {
              const target = action.target_id === null ? game.terraNullius() :
                game.playerBySmallID(action.target_id);
              if (target.isPlayer()) {
                const expected = snapshot.observation.neighbors.find((p) => p.id === action.target_id);
                const kind = { BOT: "tribe", NATION: "nation", HUMAN: "human" }[target.type()];
                if (!expected || expected.type !== kind ||
                    target.id() !== snapshot.targetIdentities.get(action.target_id) ||
                    (focus?.id === action.target_id && target.id() !== focus.player_id)) {
                  throw new Error("Chosen target changed identity/type during decision");
                }
              }
              const troops = Math.floor(human.troops() * action.fraction);
              // No alternate amount/target: insufficient current troops or
              // wrong live type is a failure, not permission to substitute.
              if (!Number.isSafeInteger(troops) || troops < 1)
                throw new Error("Selected intent has no valid integer troop payload");
              intents.push({ type: "attack", clientID: world.clientID,
                targetID: action.target_id === null ? null : target.id(), troops });
              const focused = selectedTribeForFocus(action, snapshot.observation);
              if (focused !== null) {
                if (focus && focus.id !== focused)
                  throw new Error("Offered action would unexpectedly change tribe focus");
                const targetPlayer = game.playerBySmallID(focused);
                focus = { id: focused, player_id: targetPlayer.id(), game_id: options.seed };
                history = recordTribeLandIntent(history, snapshot.observation,
                  focused, action.fraction, snapshot.tick);
              }
              record.selected = action;
            }
            decisions.push(record);
          } catch {
            status = "censored-illegal-choice";
            decisions.push({ ...record, selected_id: choice,
              error: "Returned ID or current intent outside offered legal envelope; no substitution" });
            break;
          }
        }
      }
      await world.step(intents);
      liveTicks++;
      for (const intent of intents) emitted.push({ submitted_tick: game.ticks(), ...intent });
      if (intents.some((i) => i.targetID === focus?.player_id) && focus)
        focusEvents.push({ tick: game.ticks(), event: "tribe_intent_submitted", id: focus.id, history });
      if (liveTicks % 100 === 0) snapshots.push({ tick: game.ticks(),
        seconds: game.elapsedGameSeconds(), tiles: human.numTilesOwned(),
        troops_internal: human.troops(), gold: human.gold().toString(), focus });
    }
    if (events.winEvents > 1 || (events.winEvents === 1 && !game.getWinner()))
      throw new Error("Inconsistent engine Win event");
    const complete = events.winEvents === 1;
    if (complete) status = "engine-win";
    const winner = complete ? game.getWinner() : null;
    const tribeIds = new Set(world.metadata.roster.filter((p) => p.type === "BOT").map((p) => p.id));
    const tribeConquests = events.conquests.filter((e) =>
      e.conquerorId === human.id() && tribeIds.has(e.conqueredId));
    report = { schema_version: 1, policy: POLICY_VERSION, mode: options.mode,
      metadata: world.metadata, config: { seed: options.seed, minutes: options.minutes,
        maxCalls: options.maxCalls, maxTicks: options.maxTicks,
        tick_min_spacing_ms: 100, request_min_spacing_ms: 1000,
        game_paused_during_inference: true, no_retries: true },
      status, complete, win: complete ? winner === human : null,
      winner: winner ? { id: winner.id(), name: winner.name(), wire: events.wireWinner } : null,
      counts: { mock_requests: options.mode === "mock" ? attempts : 0,
        local_decision_attempts: options.mode === "live" ? attempts : 0,
        successful_local_responses: options.mode === "live" ? responses : 0,
        paid_calls_not_verified_here: true, human_tribe_conquests: tribeConquests.length },
      before, after: { tick: game.ticks(), seconds: game.elapsedGameSeconds(), liveTicks,
        hash: game.hash(), alive: human.isAlive(), tiles: human.numTilesOwned(),
        troops_internal: human.troops(), gold: human.gold().toString() },
      conquest_gold: tribeConquests.reduce((sum, e) => sum + BigInt(e.gold), 0n).toString(),
      conquests: events.conquests, engine_win_events: events.winEvents,
      decisions, emitted_intents: emitted, focus_events: focusEvents, snapshots,
      timing: { tick_starts_ms: world.tickStarts, request_starts_ms: requestStarts },
    };
  } finally {
    if (session || startedToken) {
      try {
        if (session) await session.stop();
        else {
          const stopped = await fetchImpl(`${BASE_URL}/session`, { method: "DELETE",
            headers: { "X-Agent-Session": startedToken }, signal: AbortSignal.timeout(2000) });
          if (!stopped.ok) throw new Error("Stop failed");
        }
        revoked = true;
      } catch { stopError = "Local session Stop failed; no retry"; }
      startedToken = null;
    }
  }
  return { ...report, session: { started: Boolean(session), revoked,
    stop_error: stopError } };
}

async function main() {
  const options = parseFocusedEuropeArgs(process.argv.slice(2));
  console.debug = () => {};
  const report = await runFocusedEurope(options);
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + "\n");
  console.log(`${options.mode} Europe/Compact Easy: ${report.status}, ` +
    `${report.emitted_intents.length} intents, ${report.counts.human_tribe_conquests} actual ` +
    `tribe ConquestEvents, conquestGold=${report.conquest_gold}; ${options.output}`);
  if (report.session.stop_error || report.status === "censored-decision-error" ||
      report.status === "censored-illegal-choice") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
