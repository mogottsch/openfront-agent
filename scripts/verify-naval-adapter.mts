// Offline adapter-to-engine integration: one explicit MOCK choice, no Jev.
// Exercises C's browser naval candidate ID / worker check / normal boat intent
// against the real core GameRunner on production Onion terrain.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNavalAdapter } from "../web/naval-adapter.js";
import { observeCore } from "./benchmark-jev-observation.mjs";
import { validateHybridInput } from "../web/hybrid-observation.js";
import { oneGatedDecomposedDecision } from "./verify-naval-live-client.mjs";
import { buildNavalDecomposedRequest, parseNavalDecomposedDecision } from "../src/naval-decomposed-policy.mjs";
import { POLICY_VERSION } from "../src/policy.mjs";
import { HYBRID_POLICY_VERSION } from "../src/hybrid-policy.mjs";

const args = process.argv.slice(2);
const mode = args.length === 0 ? "offline" :
  args.length === 1 && args[0] === "--self-test-live" ? "self-test-live" :
    args.length === 2 && args.includes("--live-jev") &&
      args.includes("--max-requests=1") ? "live-jev" : null;
if (mode === null) throw new Error(
  "Use no flags for offline mock, --self-test-live for network-free gated test, or --live-jev --max-requests=1 for exactly one paid decision");
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { PlayerInfo, PlayerType, GameMapType, GameMapSize, GameMode,
  GameType, Difficulty, UnitType } = await load("src/core/game/Game.ts");
const dir = resolve(root, "resources/maps/onion");
const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
const terrain = await readFile(resolve(dir, "map.bin"));
const mini = await readFile(resolve(dir, "map4x.bin"));
const fresh = (meta: any, data: Uint8Array) => {
  if (data.length !== meta.width * meta.height) throw new Error("Onion map binary changed");
  return new GameMapImpl(meta.width, meta.height, new Uint8Array(data), meta.num_land_tiles);
};
const gameID = "naval-adapter-onion-001";
const clientID = "naval-human";
const info = new PlayerInfo("Naval adapter", PlayerType.Human, clientID, "naval-player");
const config = new Config({
  gameMap: GameMapType.Onion, gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA, gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible, nations: "disabled", bots: 0,
  donateGold: false, donateTroops: false, infiniteGold: false,
  infiniteTroops: false, instantBuild: false, randomSpawn: false,
}, null, false);
const game = createGame([info], [], fresh(manifest.map, terrain),
  fresh(manifest.map4x, mini), config);
let fatal: string | null = null;
const runner = new GameRunner(game, new Executor(game, gameID, clientID), (u: any) => {
  if ("errMsg" in u) fatal = u.errMsg;
});
runner.init();
const player = game.player(info.id);
let turnNumber = 0;
function step(intents: any[] = []) {
  runner.addTurn({ turnNumber: turnNumber++, intents });
  if (!runner.executeNextTick() || fatal) throw new Error(`Engine tick failed: ${fatal}`);
}
step([{ type: "spawn", clientID, tile: game.ref(400, 280) }]);
for (let i = 0; game.inSpawnPhase() && i < 10; i++) step();
if (game.inSpawnPhase() || !player.hasSpawned()) throw new Error("Human did not spawn");
let landSends = 0;
for (let tick = 0; tick < 1200 && player.numTilesOwned() < 6505; tick++) {
  const intents: any[] = [];
  if (tick % 10 === 0 && player.sharesBorderWith(game.terraNullius())) {
    intents.push({ type: "attack", clientID, targetID: null,
      troops: Math.floor(player.troops() * 0.2) });
    landSends++;
  }
  step(intents);
}
if (player.numTilesOwned() !== 6505) throw new Error("Starting Onion island was not filled");

// The facade delegates actual GameView read methods to the core Game with
// their original receiver; it supplies only the missing browser identity and
// async PlayerView.buildables method. That method goes through the real
// GameRunner worker-facing playerBuildables, not a guessed eligibility rule.
Object.defineProperty(player, "buildables", {
  configurable: true,
  value: async (tile: number, types: string[]) => {
    if (!game.isValidRef(tile)) throw new Error("Invalid worker tile ref");
    return runner.playerBuildables(player.id(), game.x(tile), game.y(tile), types);
  },
});
const facade = new Proxy(game, {
  get(target: any, prop: string | symbol) {
    if (prop === "gameID") return () => gameID;
    if (prop === "myPlayer") return () => player;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const state = () => ({ ready: !game.inSpawnPhase(), ended: game.getWinner() !== null,
  tick: game.ticks() });
let queued: any = null;
const sendBoat = (dst: number, troops: number) => {
    if (!state().ready || state().ended || queued !== null ||
        !game.isValidRef(dst) || !Number.isSafeInteger(troops) || troops < 1)
      return false;
    queued = { type: "boat", clientID, dst, troops };
    return true;
};
const adapter = createNavalAdapter({ game: facade, read: state,
  transportUnit: UnitType.TransportShip, sendBoat });
async function captureHybrid(navalAdapter = adapter, maxCandidates = 24) {
  const proposal = await navalAdapter.propose({ mapId: "onion", maxCandidates,
    maxCoastTiles: 512, maxPairs: 2048, maxWorkerChecks: 48 });
  if (!proposal.candidates.length) throw new Error(
    `Real Onion adapter found no worker-checked candidates: ${JSON.stringify(proposal.coverage)}`);
  // Genuine same-tick raw land state; no reconstructed enemy/attack metadata.
  const landSnapshot = observeCore(game, player);
  if (landSnapshot.tick !== proposal.source_tick || proposal.current_tick !== landSnapshot.tick)
    throw new Error("Naval and land observations did not share an engine tick");
  const hybridInput = validateHybridInput({
    game_id: gameID,
    snapshot_tick: landSnapshot.tick,
    land: landSnapshot.observation,
    building: null, // no City scan was performed in this isolated test
    city_mechanics: {
      troop_capacity_gain_display: config.cityTroopIncrease() / 10,
      construction_ticks: config.unitInfo(UnitType.City).constructionDuration,
    },
    plan: null,
    naval: proposal, // EXACT adapter.propose() result, no invented candidates
  });
  return { tick: game.ticks(), tiles: player.numTilesOwned(),
    troops: player.troops(), gold: player.gold().toString(),
    ports: player.unitCount(UnitType.Port),
    proposal, land_observation: landSnapshot.observation,
    hybrid_input: hybridInput };
}
const before = await captureHybrid(); // depleted island at tick 449
const regrowTicks = 200; // 20 simulated seconds, no new human intents
for (let i = 0; i < regrowTicks; i++) step();
if (game.ticks() !== before.tick + regrowTicks || player.units(UnitType.TransportShip).length)
  throw new Error("Regrowth did not preserve a boat-free advancing game");
const afterRegrow: any = { ...(await captureHybrid()), noNewHumanIntentTicks: regrowTicks };
if (afterRegrow.troops <= before.troops)
  throw new Error("No stronger reserve after the bounded no-intent regrowth interval");
// Independently scan at the SAME tick with the deployed-size eight-candidate
// bound. A separate adapter instance leaves the original full-11 proposal
// and its mock-choice permit identity untouched. No candidate truncation.
const boundedAdapter = createNavalAdapter({ game: facade, read: state,
  transportUnit: UnitType.TransportShip, sendBoat });
afterRegrow.bounded8 = await captureHybrid(boundedAdapter, 8);
if (afterRegrow.bounded8.tick !== afterRegrow.tick ||
    afterRegrow.bounded8.proposal.candidates.length !== 8 ||
    afterRegrow.bounded8.proposal.coverage.omitted_count !==
      afterRegrow.proposal.coverage.total_eligible - 8)
  throw new Error("Bounded naval proposal was not generated from the same real game state");
async function observeQueuedBoat(record: any) {
  if (queued === null) throw new Error("Adapter returned success without a normal boat intent");
  const emitted = queued;
  const predictedSource = runner.playerBuildables(player.id(),
    game.x(emitted.dst), game.y(emitted.dst), [UnitType.TransportShip])[0]?.canBuild;
  if (predictedSource === false || predictedSource === undefined)
    throw new Error("Worker no longer reports the emitted destination buildable");
  record.workerSource = { x: game.x(predictedSource), y: game.y(predictedSource) };
  record.emitted = { type: emitted.type,
    dst: { x: game.x(emitted.dst), y: game.y(emitted.dst) }, troops: emitted.troops };
  step([emitted]);
  queued = null;
  const boat = player.units(UnitType.TransportShip).find((u: any) =>
    u.isActive() && u.targetTile() === emitted.dst);
  if (!boat || boat.tile() !== predictedSource || boat.troops() !== emitted.troops)
    throw new Error("Normal adapter boat intent did not create expected unit/source/payload");
  let landingTicks: number | null = null;
  for (let i = 1; i <= 500; i++) {
    step();
    if (game.ownerID(emitted.dst) === player.smallID()) {
      landingTicks = i;
      break;
    }
  }
  if (landingTicks === null || boat.isActive())
    throw new Error("Chosen boat did not reach and own its shore within 500 ticks");
  step();
  return { tick: game.ticks(), landingTicks,
    landingOwned: game.ownerID(emitted.dst) === player.smallID(),
    unitActive: boat.isActive(), tiles: player.numTilesOwned(),
    outgoingLandAttacks: player.outgoingAttacks().map((a: any) => ({
      target: a.target().id(), source: a.sourceTile(), troops: a.troops(),
    })) };
}
const base = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scenario: "production Onion, one human, no opponents, fixed land expansion to 6505 island tiles",
  landSends, before, after_regrow: afterRegrow,
};
let result: any;
let output: string;
if (mode === "offline") {
  // Existing explicit MOCK Choice, not Jev. Use the original full-11 adapter
  // and its current @649#2 ID; the additional bounded8 scan does not alter it.
  const chosen = afterRegrow.proposal.candidates.find((c: any) => c.target_type === "wilderness");
  if (!chosen) throw new Error("No wilderness candidate in bounded real-engine proposal");
  const fraction = 0.1;
  if (!chosen.worker_source_confirmed || !await adapter.canExecute(chosen.id, fraction) ||
      !await adapter.execute(chosen.id, fraction))
    throw new Error("Mock-selected candidate failed adapter legality or intent submission");
  afterRegrow.chosenCandidate = chosen;
  afterRegrow.mockChoice = { source: "explicit-mock", candidate_id: chosen.id, fraction };
  const after = await observeQueuedBoat(afterRegrow);
  result = { ...base, modelCalls: 0, after };
  output = "logs/naval-adapter-engine.json";
  console.log(`Island reserve ${before.land_observation.self.troops} -> ` +
    `${afterRegrow.land_observation.self.troops} displayed after ${regrowTicks} no-intent ticks. ` +
    `Mock naval candidate ${chosen.id}: worker source ` +
    `(${afterRegrow.workerSource.x},${afterRegrow.workerSource.y}), ` +
    `normal boat ${afterRegrow.emitted.troops} troops landed in ${after.landingTicks} ticks`);
} else {
  // One paused decision only. Self-test uses a local in-process fake transport;
  // --live-jev is the sole path that may contact the loopback sidecar.
  const input = afterRegrow.bounded8.hybrid_input;
  const fakeFetch = mode === "self-test-live" ? makeOfflineFakeFetch(input) : fetch;
  let live: any;
  let receivedDecision: any = null;
  try {
    const response = await oneGatedDecomposedDecision(input, { fetchImpl: fakeFetch });
    const decision = response.decision;
    receivedDecision = decision;
    live = { status: "decision-received", mode, decision,
      requestCount: response.requestCount, sessionRevoked: response.sessionRevoked,
      policy: response.policy, emitted: null, after: null };
    if (game.ticks() !== input.snapshot_tick || queued !== null)
      throw new Error("Paused engine tick changed during decision");
    if (decision.kind === "boat") {
      const candidate = afterRegrow.bounded8.proposal.candidates.find((c: any) =>
        c.id === decision.candidate_id);
      if (!candidate || !await boundedAdapter.canExecute(decision.candidate_id, decision.fraction) ||
          !await boundedAdapter.execute(decision.candidate_id, decision.fraction))
        throw new Error("Model-selected boat failed fresh adapter legality");
      live.selectedCandidate = candidate;
      live.after = await observeQueuedBoat(live);
      live.status = mode === "live-jev" ? "jev-boat-landed" : "mock-boat-landed";
    } else if (decision.kind === "wait") {
      if (queued !== null) throw new Error("Wait unexpectedly queued an intent");
      step(); // one empty turn; existing game executions may still progress
      live.status = mode === "live-jev" ? "jev-wait-no-intent" : "mock-wait-no-intent";
      live.after = { tick: game.ticks(), boats: player.units(UnitType.TransportShip).length,
        tiles: player.numTilesOwned() };
    } else {
      // This narrow naval study cannot execute land/City choices. No substitute
      // attack is sent and the unsupported branch remains visible in the report.
      live.status = "unsupported-choice-kind-no-intent";
    }
  } catch (error: any) {
    const emitted = queued !== null || Boolean(live?.emitted);
    live = { status: emitted ? "failed-after-intent" : "failed-no-intent", mode,
      decision: receivedDecision,
      error: /^Local decomposed decision HTTP \d+$/.test(error?.message)
        ? error.message : "Paused decomposed test failed or timed out",
      intentEmitted: emitted };
    process.exitCode = 2;
  }
  result = { ...base, mode: "paused-single-decision-not-live-paced-play",
    actualModelResponses: mode === "live-jev" && receivedDecision ? 1 : 0,
    paidCallsVerified: null, live_jev: live };
  output = mode === "live-jev" ? "logs/naval-adapter-live-jev.json" :
    "logs/naval-adapter-live-selftest.json";
  console.log(`${mode}: ${live.status}; ` +
    `${live.emitted ? `boat ${live.emitted.troops} internal troops` : "no emitted boat"}`);
}
await mkdir("logs", { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(`Saved ignored ${output}`);

function makeOfflineFakeFetch(input: any) {
  const token = "M".repeat(32); // fake test-only token, never sent to a service
  return async (url: string, init: any) => {
    if (url.endsWith("/health")) return { ok: true, json: async () => ({
      keyConfigured: true, requiresStart: true, sessionActive: false,
      hybridEnabled: true, navalEnabled: true, decomposedNavalLiveEnabled: true,
      plannerEnabled: false, policy: POLICY_VERSION,
      hybridPolicy: HYBRID_POLICY_VERSION,
    }) };
    if (url.endsWith("/session") && init.method === "POST") {
      if (JSON.parse(init.body).mode !== "hybrid" || JSON.parse(init.body).limit !== 1)
        throw new Error("Fake Start contract mismatch");
      return { ok: true, json: async () => ({ token, mode: "hybrid",
        limit: 1, plan_limit: 0 }) };
    }
    if (url.endsWith("/session") && init.method === "DELETE") {
      if (init.headers["X-Agent-Session"] !== token) throw new Error("Fake Stop token mismatch");
      return { ok: true };
    }
    if (url.endsWith("/hybrid-decision-decomposed")) {
      if (init.headers["X-Agent-Session"] !== token ||
          JSON.stringify(JSON.parse(init.body)) !== JSON.stringify(input))
        throw new Error("Fake decision request mismatch");
      const request = buildNavalDecomposedRequest(input);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, q]: any) => {
        const choice = name === "branch" ? "boat_attack" :
          name === "boat_target" ? "boat_target_1" :
            name === "boat_size_1" ? "send_10" : "wait";
        return [name, { type: "choice", choice, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(q.criteria).map((id) =>
            [id, id === choice ? 1 : 0])) }];
      }));
      return { ok: true, json: async () => ({
        ...parseNavalDecomposedDecision({ answers, model: "explicit-test-only", usage: {} }, request),
        latencyMs: 1,
      }) };
    }
    throw new Error("Unexpected fake local route");
  };
}
