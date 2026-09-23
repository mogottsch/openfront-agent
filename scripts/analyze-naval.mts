// Headless OpenFront Onion transport experiment. No TypeSafe/sidecar requests.
// Run via the sibling checkout's tsx; output is an ignored logs/*.json file.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { PlayerInfo, PlayerType, GameMapType, GameMapSize, GameMode, GameType,
  Difficulty, UnitType } = await load("src/core/game/Game.ts");
const { targetTransportTile } = await load("src/core/game/TransportShipUtils.ts");
const { PathFinding } = await load("src/core/pathfinding/PathFinder.ts");

const dir = resolve(root, "resources/maps/onion");
const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
const terrain = await readFile(resolve(dir, "map.bin"));
const miniTerrain = await readFile(resolve(dir, "map4x.bin"));
const map = (meta: any, bytes: Uint8Array) => {
  if (bytes.length !== meta.width * meta.height) throw new Error("Invalid map binary");
  return new GameMapImpl(meta.width, meta.height, new Uint8Array(bytes), meta.num_land_tiles);
};
const gameID = "naval-onion-001";
const clientID = "naval-human";
const info = new PlayerInfo("Naval analysis", PlayerType.Human, clientID, "naval-player");
const config = new Config({
  gameMap: GameMapType.Onion, gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA, gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible, nations: "disabled", bots: 0,
  donateGold: false, donateTroops: false, infiniteGold: false,
  infiniteTroops: false, instantBuild: false, randomSpawn: false,
}, null, false);
const game = createGame([info], [], map(manifest.map, terrain),
  map(manifest.map4x, miniTerrain), config);
let fatal: string | null = null;
const runner = new GameRunner(game, new Executor(game, gameID, clientID), (update: any) => {
  if ("errMsg" in update) fatal = update.errMsg;
});
runner.init();
let turnNumber = 0;
function step(intents: any[] = []) {
  runner.addTurn({ turnNumber: turnNumber++, intents });
  if (!runner.executeNextTick() || fatal) throw new Error(`Engine tick ${game.ticks()}: ${fatal}`);
}
const player = game.player(info.id);
const ownSpawn = game.ref(400, 280);
const requested = game.ref(423, 276); // real Onion outer ring, across a water gap
if (!game.isLand(ownSpawn) || game.isImpassable(ownSpawn) ||
    !game.isLand(requested) || game.isImpassable(requested) ||
    !game.isShore(requested) || game.ownerID(requested) !== 0) {
  throw new Error("Pinned Onion test coordinates changed");
}
step([{ type: "spawn", clientID, tile: ownSpawn }]);
for (let i = 0; game.inSpawnPhase() && i < 10; i++) step();
if (game.inSpawnPhase() || !player.hasSpawned()) throw new Error("Human did not spawn");
const initial = {
  tick: game.ticks(), tiles: player.numTilesOwned(),
  ownedShore: [...player.borderTiles()].filter((t: number) => game.isShore(t)).length,
  canBuildSource: player.canBuild(UnitType.TransportShip, requested),
};
const expansion: any[] = [];
let firstEligible: any = null;
let landSends = 0;
// Give the human the whole initial 6,505-tile island using *normal* land
// intents. This is a controlled mechanical setup, not a strategy claim.
for (let tick = 0; tick < 1200 && player.numTilesOwned() < 6505; tick++) {
  const intents: any[] = [];
  if (tick % 10 === 0 && player.sharesBorderWith(game.terraNullius())) {
    intents.push({ type: "attack", clientID, targetID: null,
      troops: Math.floor(player.troops() * 0.2) });
    landSends++;
  }
  step(intents);
  if (firstEligible === null && (tick + 1) % 10 === 0) {
    const candidate = player.canBuild(UnitType.TransportShip, requested);
    if (candidate !== false) firstEligible = {
      liveTick: tick + 1, gameTick: game.ticks(), tiles: player.numTilesOwned(),
      ownedShore: [...player.borderTiles()].filter((t: number) => game.isShore(t)).length,
      source: { x: game.x(candidate), y: game.y(candidate) },
      ports: player.unitCount(UnitType.Port),
    };
  }
  if ([100, 300, 600, 900, 1200].includes(tick + 1))
    expansion.push({ tick: tick + 1, tiles: player.numTilesOwned(),
      ownedShore: [...player.borderTiles()].filter((t: number) => game.isShore(t)).length });
}
if (player.numTilesOwned() !== 6505 || firstEligible === null)
  throw new Error("Human did not gain a boat route from the starting island within 1200 ticks");
const landing = targetTransportTile(game, player, requested);
const source = player.canBuild(UnitType.TransportShip, requested);
const workerBuildable = runner.playerBuildables(info.id, 423, 276, [UnitType.TransportShip])[0];
const ownTileDenied = player.canBuild(UnitType.TransportShip, ownSpawn) === false;
const farInland = game.ref(500, 280);
const farInlandDenied = player.canBuild(UnitType.TransportShip, farInland) === false;
if (!ownTileDenied || !farInlandDenied ||
    source === false || landing === null ||
    workerBuildable.canBuild !== source ||
    !game.isShore(source) || !game.isShore(landing) ||
    game.ownerID(source) !== player.smallID() || game.ownerID(landing) !== 0) {
  throw new Error("Transport is not buildable from the owned Onion island to outer shore");
}
const path = PathFinding.Water(game).findPath(source, landing);
if (!path?.length) throw new Error("No real water path between chosen shores");
const beforeBoat = {
  tick: game.ticks(), tiles: player.numTilesOwned(),
  troops: player.troops(), gold: player.gold().toString(),
  ports: player.unitCount(UnitType.Port),
  activeBoats: player.unitCount(UnitType.TransportShip),
  source: { x: game.x(source), y: game.y(source) },
  requested: { x: 423, y: 276 },
  landing: { x: game.x(landing), y: game.y(landing) },
  shoreDistance: game.manhattanDist(source, landing),
  waterPathLength: path.length,
  ownTileDenied, farInlandDenied,
};
const troopsRequested = Math.floor(player.troops() * 0.2);
step([{ type: "boat", clientID, dst: requested, troops: troopsRequested }]);
const boat = player.units(UnitType.TransportShip)[0];
if (!boat || !boat.isActive() || boat.troops() !== troopsRequested ||
    boat.tile() !== source || boat.targetTile() !== landing) {
  throw new Error("Normal boat intent did not create the predicted transport");
}
const afterBoat = { tick: game.ticks(), troops: player.troops(),
  gold: player.gold().toString(), boatID: boat.id(),
  boatTroops: boat.troops(), boatTile: { x: game.x(boat.tile()), y: game.y(boat.tile()) } };
let arrivalTicks: number | null = null;
for (let i = 1; i <= 500; i++) {
  step();
  if (game.ownerID(landing) === player.smallID()) {
    arrivalTicks = i;
    break;
  }
}
if (arrivalTicks === null) throw new Error("Boat did not land within 500 ticks");
step(); // queued land AttackExecution starts on its next tick
const outcome = {
  arrivalTicks,
  boatActiveAtLanding: boat.isActive(),
  landingOwned: game.ownerID(landing) === player.smallID(),
  afterLandAttackTick: game.ticks(),
  tiles: player.numTilesOwned(),
  outgoingLandAttacks: player.outgoingAttacks().map((a: any) => ({
    target: a.target().id(), troops: a.troops(), sourceTile: a.sourceTile(),
  })),
};
if (outcome.boatActiveAtLanding || !outcome.landingOwned ||
    !outcome.outgoingLandAttacks.some((a: any) => a.target === null && a.sourceTile === landing)) {
  throw new Error("Landing did not create the expected land attack on wilderness");
}
const report = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  seed: gameID, map: "Onion", modelCalls: 0, opponents: 0,
  assumptions: [
    "Production Onion map and real Config/GameRunner/Executor; one human, no AI opponents.",
    "Human lands at (400,280), expands by fixed 20% wilderness attacks until the complete 6505-tile island is owned.",
    "One normal stamped boat intent to the unowned outer-ring shore (423,276) with 20% of available internal troops.",
    "Native water route, buildability and arrival; no port or model action. Troops are internal units (display /10).",
  ],
  initial, firstEligible, expansion, landSends, beforeBoat, troopsRequested, afterBoat, outcome,
};
await mkdir("logs", { recursive: true });
const output = "logs/naval-mechanics.json";
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Onion water crossing: source (${beforeBoat.source.x},${beforeBoat.source.y}) ` +
  `-> landing (${beforeBoat.landing.x},${beforeBoat.landing.y}), ` +
  `${arrivalTicks} ticks, requested ${troopsRequested} troops; saved ${output}`);
