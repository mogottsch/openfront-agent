// Offline adapter-to-engine integration: one explicit MOCK choice, no Jev.
// Exercises C's browser naval candidate ID / worker check / normal boat intent
// against the real core GameRunner on production Onion terrain.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNavalAdapter } from "../web/naval-adapter.js";

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
const adapter = createNavalAdapter({ game: facade, read: state,
  transportUnit: UnitType.TransportShip,
  sendBoat: (dst: number, troops: number) => {
    if (!state().ready || state().ended || queued !== null ||
        !game.isValidRef(dst) || !Number.isSafeInteger(troops) || troops < 1)
      return false;
    queued = { type: "boat", clientID, dst, troops };
    return true;
  },
});
const proposal = await adapter.propose({ mapId: "onion", maxCandidates: 24,
  maxCoastTiles: 512, maxPairs: 2048, maxWorkerChecks: 48 });
if (!proposal.candidates.length) throw new Error(
  `Real Onion adapter found no worker-checked candidates: ${JSON.stringify(proposal.coverage)}`);
// EXPLICIT MOCK Choice, not Jev: first worker-checked wilderness candidate.
const chosen = proposal.candidates.find((c: any) => c.target_type === "wilderness");
if (!chosen) throw new Error("No wilderness candidate in bounded real-engine proposal");
const fraction = 0.1;
if (!chosen.worker_source_confirmed || !await adapter.canExecute(chosen.id, fraction) ||
    !await adapter.execute(chosen.id, fraction))
  throw new Error("Mock-selected candidate failed adapter legality or intent submission");
if (queued === null) throw new Error("Adapter returned success without a normal boat intent");
const emitted = queued;
const predictedSource = runner.playerBuildables(player.id(),
  game.x(emitted.dst), game.y(emitted.dst), [UnitType.TransportShip])[0]?.canBuild;
if (predictedSource === false || predictedSource === undefined)
  throw new Error("Worker no longer reports the emitted destination buildable");
const before = { tick: game.ticks(), tiles: player.numTilesOwned(),
  troops: player.troops(), gold: player.gold().toString(),
  ports: player.unitCount(UnitType.Port),
  chosenCandidate: chosen,
  proposal: { snapshot_id: proposal.snapshot_id, source_tick: proposal.source_tick,
    offered: proposal.candidates.length, coverage: proposal.coverage,
    omissions: proposal.omissions },
  mockChoice: { source: "explicit-mock", candidate_id: chosen.id, fraction },
  workerSource: { x: game.x(predictedSource), y: game.y(predictedSource) },
  emitted: { type: emitted.type, dst: { x: game.x(emitted.dst), y: game.y(emitted.dst) },
    troops: emitted.troops } };
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
  throw new Error("Mock-chosen boat did not reach and own its shore within 500 ticks");
step();
const result = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scenario: "production Onion, one human, no opponents, fixed land expansion to 6505 island tiles",
  modelCalls: 0, landSends, before,
  after: { tick: game.ticks(), landingTicks,
    landingOwned: game.ownerID(emitted.dst) === player.smallID(),
    unitActive: boat.isActive(), tiles: player.numTilesOwned(),
    outgoingLandAttacks: player.outgoingAttacks().map((a: any) => ({
      target: a.target().id(), source: a.sourceTile(), troops: a.troops(),
    })) },
};
await mkdir("logs", { recursive: true });
await writeFile("logs/naval-adapter-engine.json", JSON.stringify(result, null, 2) + "\n");
console.log(`Mock naval candidate ${chosen.id}: worker source (${before.workerSource.x},${before.workerSource.y}), ` +
  `normal boat ${before.emitted.troops} troops landed in ${landingTicks} ticks; ignored logs/naval-adapter-engine.json`);
