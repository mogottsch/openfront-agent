// Explicit MOCK City choice against actual GameRunner/Executor and the real
// worker-facing buildables. No Jev/Copilot call, no browser, no upstream edits.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBuildingAdapter } from "../web/building-adapter.js";
import { observeCore } from "./benchmark-jev-observation.mjs";
import { validateHybridInput } from "../web/hybrid-observation.js";

if (process.argv.length !== 2) throw new Error("Run without flags; this verifier has no live-model mode");
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (file: string) => import(pathToFileURL(resolve(root, file)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { PlayerExecution } = await load("src/core/execution/PlayerExecution.ts");
const { PlayerInfo, PlayerType, GameMapType, GameMapSize, GameMode,
  GameType, Difficulty, UnitType } = await load("src/core/game/Game.ts");

const side = 256;
const startingGold = 400_000;
const clientID = "city-verifier-human";
const gameID = "city-adapter-fixed-001";
const mapID = "all-plains-256";
const info = new PlayerInfo("City adapter", PlayerType.Human, clientID, "city-player");
const config = new Config({
  gameMap: GameMapType.Europe, gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA, gameType: GameType.Singleplayer,
  difficulty: Difficulty.Medium, nations: "disabled", bots: 0,
  donateGold: false, donateTroops: false, infiniteGold: false,
  infiniteTroops: false, instantBuild: false, randomSpawn: false,
  startingGold,
}, null, false);
const main = new GameMapImpl(side, side, new Uint8Array(side * side).fill(128), side * side);
const mini = new GameMapImpl(side / 2, side / 2,
  new Uint8Array((side * side) / 4).fill(128), (side * side) / 4);
const game = createGame([info], [], main, mini, config);
game.endSpawnPhase();
const player = game.player(info.id);
for (let y = 75; y < 125; y++) {
  for (let x = 50; x < 100; x++) player.conquer(game.ref(x, y));
}
player.setSpawnTile(game.ref(75, 100));
player.setTroops(100_000);
game.addExecution(new PlayerExecution(player));
let fatal: string | null = null;
const runner = new GameRunner(game, new Executor(game, gameID, undefined), (update: any) => {
  if ("errMsg" in update) fatal = update.errMsg;
});
runner.init();
let turnNumber = 0;
function step(intents: any[] = []) {
  runner.addTurn({ turnNumber: turnNumber++, intents });
  if (!runner.executeNextTick() || fatal) throw new Error(`Engine failed: ${fatal}`);
}
// Let the first engine tick initialize PlayerExecution and the normal turn
// pipeline. The next intent is then processed at tick 2, as in the paired
// actual-engine structure test, not silently lost on the initialization tick.
step();
// Core Player is used only as a truthful PlayerView-shaped facade. Every
// buildables request reaches GameRunner.playerBuildables, never a fake rule.
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
const read = () => ({ tick: game.ticks(),
  ready: !game.inSpawnPhase() && player.isAlive() && player.hasSpawned(),
  ended: game.getWinner() !== null });
let queued: any = null;
const emittedIntents: any[] = [];
const adapter = createBuildingAdapter({ game: facade, read,
  cityUnit: UnitType.City,
  sendBuild: (unit: string, tile: number) => {
    if (!read().ready || read().ended || unit !== UnitType.City ||
        queued !== null || !game.isValidRef(tile)) return false;
    queued = { type: "build_unit", clientID, unit, tile };
    emittedIntents.push({ tick_queued: game.ticks(), ...queued,
      x: game.x(tile), y: game.y(tile) });
    return true;
  },
});
const beforeTick = game.ticks();
const proposal = await adapter.propose({ mapId: mapID, maxCandidates: 8,
  maxExamined: 512, maxWorkerChecks: 24, coverageRadius: 6 });
const land = observeCore(game, player);
if (game.ticks() !== beforeTick || proposal.source_tick !== land.tick ||
    proposal.current_tick !== land.tick || proposal.map_id !== `${gameID}/${mapID}` ||
    !proposal.candidates.length || proposal.available_gold !== player.gold().toString()) {
  throw new Error("City and raw land snapshots are not the same genuine engine tick");
}
const mechanics = { troop_capacity_gain_display: config.cityTroopIncrease() / 10,
  construction_ticks: config.unitInfo(UnitType.City).constructionDuration };
const hybridInput = validateHybridInput({ game_id: gameID,
  snapshot_tick: land.tick, land: land.observation, building: proposal,
  city_mechanics: mechanics, plan: null });
const candidate = proposal.candidates[0]; // explicit MOCK ID, not strategy/model
if (!await adapter.canExecute(candidate.id) || !await adapter.execute(candidate.id)) {
  throw new Error("Fresh worker-checked mock City candidate did not queue its normal intent");
}
if (!queued || emittedIntents.length !== 1 || game.ticks() !== land.tick ||
    queued.unit !== UnitType.City) {
  throw new Error("Adapter returned success without one same-tick City intent");
}
const worker = runner.playerBuildables(player.id(),
  game.x(queued.tile), game.y(queued.tile), [UnitType.City])[0];
if (worker?.canBuild !== queued.tile || worker.canUpgrade !== false ||
    worker.cost.toString() !== candidate.cost_gold) {
  throw new Error("Worker cost or exact City site changed before engine submission");
}
const before = { tick: game.ticks(), tiles: player.numTilesOwned(),
  gold: player.gold().toString(), troop_capacity_internal: config.maxTroops(player),
  troops_internal: player.troops(), city_units: player.units(UnitType.City).length };
step([queued]);
queued = null;
const postIntentTurn = { tick: game.ticks(), gold: player.gold().toString(),
  city_units: player.units(UnitType.City).length };
// The normal ConstructionExecution is scheduled through the engine turn
// pipeline. Observe one bounded additional empty tick if it has not built yet;
// do not emit a second intent or pretend an emitted intent is an outcome.
if (postIntentTurn.city_units === 0) step();
const built = player.units(UnitType.City);
if (built.length !== 1 || built[0].tile() !== emittedIntents[0].tile ||
    !built[0].isUnderConstruction()) {
  throw new Error(`Normal intent did not create one under-construction City: ` +
    JSON.stringify({ queued: emittedIntents[0], observed: built.map((unit: any) => ({
      tile: unit.tile(), id: unit.id(), underConstruction: unit.isUnderConstruction(),
    })), gold: player.gold().toString(), tick: game.ticks() }));
}
const underConstruction = { tick: game.ticks(), unit_id: built[0].id(),
  under_construction: built[0].isUnderConstruction(),
  gold: player.gold().toString(), troop_capacity_internal: config.maxTroops(player) };
if (underConstruction.troop_capacity_internal !== before.troop_capacity_internal) {
  throw new Error("Under-construction City unexpectedly increased troop capacity");
}
let completion: any = null;
for (let i = 0; i < mechanics.construction_ticks + 10; i++) {
  step(); // explicitly bounded empty turns; no new action or model request
  const city = player.units(UnitType.City)[0];
  if (city && !city.isUnderConstruction()) {
    completion = { tick: game.ticks(), elapsed_engine_ticks: game.ticks() - before.tick,
      unit_id: city.id(), level: city.level(), under_construction: city.isUnderConstruction(),
      gold: player.gold().toString(), troop_capacity_internal: config.maxTroops(player),
      troops_internal: player.troops(), tiles: player.numTilesOwned() };
    break;
  }
}
if (!completion || completion.level !== 1 ||
    completion.troop_capacity_internal - before.troop_capacity_internal !==
      config.cityTroopIncrease() || completion.tiles !== before.tiles) {
  throw new Error("City did not finish and raise capacity by configured amount");
}
const workerGoldPerTick = config.goldAdditionRate(player);
const creationGoldDelta = BigInt(underConstruction.gold) - BigInt(before.gold);
const completionGoldDelta = BigInt(completion.gold) - BigInt(before.gold);
if (creationGoldDelta !== -worker.cost +
      workerGoldPerTick * BigInt(underConstruction.tick - before.tick) ||
    completionGoldDelta !== -worker.cost +
      workerGoldPerTick * BigInt(completion.tick - before.tick)) {
  throw new Error("Observed gold did not reconcile to City spend plus normal worker income");
}
const result = {
  engine_commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"],
    { encoding: "utf8" }).trim(),
  scenario: { map: "256x256 all-plains", starting_gold_config: startingGold,
    owned_tiles_prepared: 2500, one_human: true, opponents: 0,
    real_worker: true, model_calls: 0, choice: "explicit-mock-first-offered-id" },
  snapshot: { proposal, raw_land: land,
    hybrid_input: hybridInput, mechanics },
  selection: { source: "explicit-mock", candidate_id: candidate.id,
    cost_gold: candidate.cost_gold, worker_can_build_tile: worker.canBuild,
    worker_source: "runner.playerBuildables" },
  emitted_intents: emittedIntents,
  observed: { before, post_intent_turn: postIntentTurn,
    under_construction: underConstruction, completion,
    configured_cost_gold: worker.cost.toString(),
    worker_gold_per_tick: workerGoldPerTick.toString(),
    observed_gold_delta_to_creation: creationGoldDelta.toString(),
    observed_gold_delta_to_completion: completionGoldDelta.toString(),
    troop_capacity_gain_internal: completion.troop_capacity_internal -
      before.troop_capacity_internal },
};
await mkdir("logs", { recursive: true });
await writeFile("logs/city-adapter-engine.json", JSON.stringify(result, null, 2) + "\n");
console.log(`Mock City ${candidate.id}: worker cost ${worker.cost} gold, normal intent ` +
  `queued @tick${before.tick}; under construction @tick${underConstruction.tick}, ` +
  `completed @tick${completion.tick}, capacity +${result.observed.troop_capacity_gain_internal} ` +
  `internal. Ignored logs/city-adapter-engine.json; zero model calls.`);
