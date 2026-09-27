// Native Impossible NationExecution pilot in the human's Onion opening slot.
// Actual headless GameRunner/Executor; no model or scripted pilot decisions.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runBenchmarkMatch, type Options } from "./benchmark-baseline.mts";
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { SpawnExecution } = await load("src/core/execution/SpawnExecution.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { createNationsForGame } = await load("src/core/game/NationCreation.ts");
const { GameUpdateType } = await load("src/core/game/GameUpdates.ts");
const { PseudoRandom } = await load("src/core/PseudoRandom.ts");
const { simpleHash } = await load("src/core/Util.ts");
const { PlayerInfo, PlayerType, Nation, Cell, GameMapType, GameMapSize,
  GameMode, GameType, Difficulty, UnitType } = await load("src/core/game/Game.ts");
const dir = resolve(root, "resources/maps/onion");
const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
const main = await readFile(resolve(dir, "map.bin"));
const mini = await readFile(resolve(dir, "map4x.bin"));
function fresh(metadata: any, bytes: Uint8Array) {
  if (bytes.length !== metadata.width * metadata.height) throw new Error("Invalid Onion binary");
  return new GameMapImpl(metadata.width, metadata.height,
    new Uint8Array(bytes), metadata.num_land_tiles);
}
const argv = process.argv.slice(2);
let seeds = ["bench-001", "bench-002", "bench-003"];
let smoke = false;
let output = "logs/benchmark-native-pilot.json";
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--smoke") { smoke = true; continue; }
  if (!["--seeds", "--output"].includes(arg)) throw new Error(`Unknown option ${arg}`);
  const value = argv[++i];
  if (!value) throw new Error(`Missing value for ${arg}`);
  if (arg === "--seeds") {
    seeds = value.split(",");
    if (!seeds.length || new Set(seeds).size !== seeds.length ||
        seeds.some((s) => !/^[A-Za-z0-9_-]{1,64}$/.test(s)))
      throw new Error("Invalid seed set");
  } else {
    if (!value.endsWith(".json")) throw new Error("Output must be JSON");
    output = value;
  }
}
if (smoke && !argv.includes("--seeds")) seeds = ["bench-001"];
console.debug = () => {};
const opts: Options = { smoke, seeds, minutes: 5, maxTicks: smoke ? 650 : 3050,
  spawn: [400, 280], output };
const structTypes = [UnitType.City, UnitType.DefensePost, UnitType.Factory,
  UnitType.Port, UnitType.MissileSilo, UnitType.SAMLauncher];

function snapshot(game: any, pilot: any, seconds: number) {
  return { seconds, tick: game.ticks(), tiles: pilot.numTilesOwned(),
    troopReserve: pilot.troops(), gold: pilot.gold().toString(),
    alive: pilot.isAlive(),
    structures: Object.fromEntries(structTypes.map((type: string) => [type,
      pilot.units(type).map((u: any) => ({ id: u.id(), level: u.level(),
        underConstruction: u.isUnderConstruction(), tile: [game.x(u.tile()), game.y(u.tile())] }))])) };
}

async function runPilot(seed: string) {
  const gameStart = {
    gameID: seed, lobbyCreatedAt: 0,
    config: { gameMap: GameMapType.Onion, gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA, gameType: GameType.Singleplayer,
      difficulty: Difficulty.Impossible, nations: "default" as const, bots: 0,
      donateGold: false, donateTroops: false, infiniteGold: false,
      infiniteTroops: false, instantBuild: false, randomSpawn: false,
      maxTimerValue: opts.minutes },
    players: [],
  };
  const random = new PseudoRandom(simpleHash(seed));
  const humanSlotID = random.nextID(); // consume the exact human roster RNG ID
  const opponents = createNationsForGame(gameStart, manifest.nations,
    manifest.additionalNations ?? [], 1, random);
  const pilotInfo = new PlayerInfo("Native pilot", PlayerType.Nation, null, humanSlotID);
  const pilotNation = new Nation(new Cell(400, 280), pilotInfo);
  // In FFA the human slot was smallID 1 and manifest nations follow it;
  // preserve that order as well as the seeded string IDs.
  const game = createGame([], [pilotNation, ...opponents],
    fresh(manifest.map, main), fresh(manifest.map4x, mini),
    new Config(gameStart.config, null, false), manifest.teamGameSpawnAreas);
  let fatal: string | null = null;
  let winUpdates = 0;
  let wireWinner: any = null;
  const runner = new GameRunner(game, new Executor(game, seed, undefined), (update: any) => {
    if ("errMsg" in update) { fatal = update.errMsg; return; }
    for (const u of update.updates[GameUpdateType.Win]) {
      winUpdates++; wireWinner = u.winner ?? null;
    }
  });
  runner.init();
  const pilot = game.player(pilotInfo.id);
  if (pilot.smallID() !== 1) throw new Error("Native pilot did not occupy the original smallID slot");
  const otherPlayers = opponents.map((n: any) => game.player(n.playerInfo.id));
  let turnNumber = 0;
  function step() {
    runner.addTurn({ turnNumber: turnNumber++, intents: [] });
    if (!runner.executeNextTick() || fatal) throw new Error(`Native pilot engine error: ${fatal}`);
  }
  // Let all four NationExecutions take their genuine seeded spawn turns.
  // Singleplayer normally ends its spawn phase on a HUMAN click, so with no
  // human we explicitly relocate the already-spawned pilot by one trusted
  // SpawnExecution to the human's exact opening tile, then end the phase.
  // Native AI remains engine-owned throughout the live game; no heuristic
  // replaces an attack, structure, naval, or diplomacy decision.
  for (let i = 0; i < 12 && (!pilot.hasSpawned() ||
      otherPlayers.some((p: any) => !p.hasSpawned())); i++) step();
  if (!pilot.hasSpawned() || otherPlayers.some((p: any) => !p.hasSpawned()))
    throw new Error("Native pilot or original nations did not spawn");
  const naturalPilotSpawn = [game.x(pilot.spawnTile()), game.y(pilot.spawnTile())];
  game.addExecution(new SpawnExecution(seed, pilotInfo, game.ref(400, 280)));
  step(); // init trusted relocation
  step(); // execute relocation
  game.endSpawnPhase();
  const actualPilotSpawn = [game.x(pilot.spawnTile()), game.y(pilot.spawnTile())];
  if (actualPilotSpawn[0] !== 400 || actualPilotSpawn[1] !== 280)
    throw new Error(`Native pilot did not retain exact human-slot spawn: ${actualPilotSpawn}`);
  const opponentSpawns = otherPlayers.map((p: any) => ({
    name: p.name(), id: p.id(), x: game.x(p.spawnTile()), y: game.y(p.spawnTile()) }));
  const initial = snapshot(game, pilot, 0);
  const structuresBuilt: any[] = [];
  const structuresCompleted: any[] = [];
  const boatsBuilt: any[] = [];
  const boatsLanded: any[] = [];
  const landAttacksStarted: any[] = [];
  const knownStructureIDs = new Set<number>();
  const completedStructureIDs = new Set<number>();
  const knownBoatIDs = new Set<number>();
  const boatUnits = new Map<number, any>();
  const seenLandings = new Set<number>();
  const knownAttackIDs = new Set<string>();
  const checkpoints: any[] = [];
  let liveTicks = 0;
  for (let i = 0; i < opts.maxTicks && winUpdates === 0; i++) {
    step(); liveTicks++;
    for (const type of structTypes) {
      for (const unit of pilot.units(type)) {
        if (!knownStructureIDs.has(unit.id())) {
          knownStructureIDs.add(unit.id());
          structuresBuilt.push({ tick: game.ticks(), seconds: game.elapsedGameSeconds(),
            type, unitID: unit.id(), tile: [game.x(unit.tile()), game.y(unit.tile())],
            goldAfter: pilot.gold().toString() });
        }
        if (!unit.isUnderConstruction() && !completedStructureIDs.has(unit.id())) {
          completedStructureIDs.add(unit.id());
          structuresCompleted.push({ tick: game.ticks(), seconds: game.elapsedGameSeconds(),
            unitID: unit.id(), type, levelAtCompletion: unit.level() });
        }
      }
    }
    for (const attack of pilot.outgoingAttacks()) {
      if (knownAttackIDs.has(attack.id())) continue;
      knownAttackIDs.add(attack.id());
      landAttacksStarted.push({ tick: game.ticks(), seconds: game.elapsedGameSeconds(),
        attackID: attack.id(), targetID: attack.target().id(),
        troops: attack.troops(), sourceTile: attack.sourceTile() });
    }
    for (const unit of pilot.units(UnitType.TransportShip)) {
      if (knownBoatIDs.has(unit.id())) continue;
      knownBoatIDs.add(unit.id());
      boatUnits.set(unit.id(), unit);
      const target = unit.targetTile();
      boatsBuilt.push({ tick: game.ticks(), seconds: game.elapsedGameSeconds(),
        unitID: unit.id(), source: [game.x(unit.tile()), game.y(unit.tile())],
        target: target === undefined ? null : [game.x(target), game.y(target)],
        targetRef: target ?? null, troops: unit.troops(),
        reserveAfter: pilot.troops() });
    }
    for (const boat of boatsBuilt) {
      if (seenLandings.has(boat.unitID) || boat.targetRef === null) continue;
      const unit = boatUnits.get(boat.unitID);
      // A tile held by the pilot while its boat is still en route is NOT a
      // landing. Require unit inactive, target owned, and not enemy-destroyed.
      if (unit && !unit.isActive() && !unit.wasDestroyedByEnemy() &&
          game.ownerID(boat.targetRef) === pilot.smallID()) {
        seenLandings.add(boat.unitID);
        boatsLanded.push({ unitID: boat.unitID, tick: game.ticks(),
          seconds: game.elapsedGameSeconds(), target: boat.target,
          evidence: "transport inactive, not enemy-destroyed, target pilot-owned" });
      }
    }
    if (Math.round(game.elapsedGameSeconds() * 10) % 300 === 0)
      checkpoints.push(snapshot(game, pilot, game.elapsedGameSeconds()));
  }
  if (winUpdates > 1) throw new Error("Duplicate native Win update");
  const winner = game.getWinner();
  if (winUpdates === 1 && !winner) throw new Error("Winnerless native Win update");
  const complete = winUpdates === 1;
  const denominator = game.numLandTiles() - game.numTilesWithFallout();
  return { seed, policy: "native-NationExecution-Impossible", complete,
    status: complete ? "engine-win" : "censored-tick-cap",
    win: complete ? winner === pilot : null,
    winner: complete ? { id: winner.id(), name: winner.name(), wire: wireWinner } : null,
    elapsedSeconds: game.elapsedGameSeconds(), liveTicks, finalHash: game.hash(),
    winRule: complete ? game.elapsedGameSeconds() >= opts.minutes * 60
      ? "timer-leader" : "land-share" : null,
    winnerShare: complete ? winner.numTilesOwned() / denominator : null,
    pilotSpawn: actualPilotSpawn, naturalPilotSpawn,
    pilotSmallID: pilot.smallID(), opponentSpawns, initial,
    final: { ...snapshot(game, pilot, game.elapsedGameSeconds()),
      landShare: pilot.numTilesOwned() / denominator },
    structuresBuilt, structuresCompleted,
    boatsBuilt: boatsBuilt.map(({targetRef: _, ...fields}) => fields),
    boatsLanded, landAttacksStarted, checkpoints,
    standings: game.allPlayers().map((p: any) => ({ id: p.id(), name: p.name(),
      type: p.type(), alive: p.isAlive(), tiles: p.numTilesOwned(),
      landShare: p.numTilesOwned() / denominator,
      troops: p.troops(), gold: p.gold().toString(),
      structures: Object.fromEntries(structTypes.map((type: string) =>
        [type, p.units(type).length])) })),
  };
}

const pairs: any[] = [];
for (const seed of seeds) {
  const baseline = await runBenchmarkMatch(seed, "fixed20-wilderness", opts);
  const pilot = await runPilot(seed);
  const matched = JSON.stringify(baseline.opponentSpawns) === JSON.stringify(pilot.opponentSpawns);
  if (!matched) throw new Error(`Native opponents not paired: ${seed}`);
  pairs.push({ seed, baseline, pilot, complete: baseline.completed && pilot.complete,
    baselineWin: baseline.win, pilotWin: pilot.win,
    pilotTileDelta: pilot.final.tiles - baseline.human.tiles });
  console.log(`${seed}: human fixed20 ${baseline.status}/${baseline.human.tiles} tiles, ` +
    `native pilot ${pilot.status}/${pilot.final.tiles} tiles, ` +
    `native boats ${pilot.boatsBuilt.length}, win=${pilot.win}`);
}
const completePairs = pairs.filter((p) => p.complete);
const report = { schemaVersion: 1,
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  map: "Onion", difficulty: "Impossible", timerMinutes: 5,
  maxLiveTicks: opts.maxTicks, noModelCalls: true,
  assumptions: [
    "Original human slot string ID consumed from seeded roster RNG and reused by a native Nation player (smallID 1) at exact human spawn (400,280).",
    "Three original manifest Nation opponents retained the same IDs and spawn coordinates; pairing checked per seed.",
    "The native pilot gets Nation difficulty capacity/growth and native AI actions (boats/builds/diplomacy); the human fixed20 control gets neither. This is not a policy-only A/B comparison, a mathematical upper bound, or a Jev win.",
    "Singleplayer normally ends spawn on human click. Four native NationExecutions first spawn naturally, then one trusted pilot relocation moves the pilot to exact human tile (400,280); spawn phase ends manually. Opponent coordinates are checked. Engine WinCheck decides the timed FFA winner.",
    "All troop counts are internal units (display /10); structures and boat snapshots are observable engine state, not emitted human intents.",
  ], pairs,
  summary: { completePairs: completePairs.length, totalPairs: pairs.length,
    baselineWins: completePairs.filter((p) => p.baselineWin === true).length,
    pilotWins: completePairs.filter((p) => p.pilotWin === true).length },
};
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${pairs.length} native pilot comparisons to ${output}`);
if (!smoke && completePairs.length !== pairs.length) process.exitCode = 2;
