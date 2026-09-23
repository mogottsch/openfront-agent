// Deterministic, no-model actual-engine City/Defense Post microbenchmarks.
// Paired fresh all-plains worlds; no native AI, no upstream modifications.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { PlayerExecution } = await load("src/core/execution/PlayerExecution.ts");
const { PlayerInfo, PlayerType, GameMapType, GameMapSize, GameMode, GameType,
  Difficulty, UnitType, TerrainType } = await load("src/core/game/Game.ts");

const side = 256;
const configFor = (startingGold: number) => new Config({
  gameMap: GameMapType.Europe, gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA, gameType: GameType.Singleplayer,
  difficulty: Difficulty.Medium, nations: "disabled", bots: 0,
  donateGold: false, donateTroops: false, infiniteGold: false,
  infiniteTroops: false, instantBuild: false, randomSpawn: false,
  startingGold,
}, null, false);
function world(startingGold: number, twoPlayers = false) {
  const config = configFor(startingGold);
  const attackerInfo = new PlayerInfo("Attacker", PlayerType.Human, "attacker-client", "attacker");
  const defenderInfo = new PlayerInfo("Passive defender", PlayerType.Human, "defender-client", "defender");
  const humans = twoPlayers ? [attackerInfo, defenderInfo] : [attackerInfo];
  const main = new GameMapImpl(side, side, new Uint8Array(side * side).fill(128), side * side);
  const mini = new GameMapImpl(side / 2, side / 2,
    new Uint8Array((side * side) / 4).fill(128), (side * side) / 4);
  const game = createGame(humans, [], main, mini, config);
  game.endSpawnPhase();
  const attacker = game.player(attackerInfo.id);
  for (let y = 75; y < 125; y++)
    for (let x = 50; x < 100; x++) attacker.conquer(game.ref(x, y));
  attacker.setSpawnTile(game.ref(75, 100));
  attacker.setTroops(100000);
  game.addExecution(new PlayerExecution(attacker));
  let defender: any = null;
  if (twoPlayers) {
    defender = game.player(defenderInfo.id);
    for (let y = 75; y < 125; y++)
      for (let x = 100; x < 150; x++) defender.conquer(game.ref(x, y));
    defender.setSpawnTile(game.ref(125, 100));
    defender.setTroops(50000);
    game.addExecution(new PlayerExecution(defender));
  }
  let fatal: string | null = null;
  const runner = new GameRunner(game, new Executor(game, "structures-fixed-001", undefined),
    (u: any) => { if ("errMsg" in u) fatal = u.errMsg; });
  runner.init();
  let turnNumber = 0;
  function step(intents: any[] = []) {
    runner.addTurn({ turnNumber: turnNumber++, intents });
    if (!runner.executeNextTick() || fatal) throw new Error(`Engine failed: ${fatal}`);
  }
  return { game, config, runner, attacker, defender, step };
}
const state = (w: any, player: any, type: string) => {
  const units = player.units(type);
  return { tick: w.game.ticks(), troops: player.troops(),
    troopCapacity: w.config.maxTroops(player),
    troopIncreaseRate: w.config.troopIncreaseRate(player),
    tiles: player.numTilesOwned(), gold: player.gold().toString(),
    units: units.map((u: any) => ({ id: u.id(), tile: u.tile(),
      level: u.level(), underConstruction: u.isUnderConstruction() })) };
};

// Same territory/initial troops/ticks, with or without one worker-legal City.
function cityRun(build: boolean, upgrade: boolean) {
  const w = world(400000);
  const p = w.attacker;
  const tile = w.game.ref(75, 100);
  const available = w.runner.playerBuildables(p.id(), 75, 100, [UnitType.City])[0];
  if (available.type !== UnitType.City || available.canBuild === false ||
      available.cost !== 125000n || available.canUpgrade !== false)
    throw new Error("First City is not worker-legal at expected cost");
  const before = state(w, p, UnitType.City);
  let createdTick: number | null = null;
  let completedTick: number | null = null;
  let upgradedTick: number | null = null;
  let secondCost: string | null = null;
  const samples: any[] = [];
  for (let t = 0; t < 100; t++) {
    let intents: any[] = [];
    if (t === 0 && build)
      intents = [{ type: "build_unit", clientID: "attacker-client",
        unit: UnitType.City, tile }];
    const city = p.units(UnitType.City)[0];
    if (upgrade && completedTick !== null && upgradedTick === null && city) {
      secondCost = w.config.unitInfo(UnitType.City).cost(w.game, p).toString();
      if (secondCost !== "250000" || !p.canUpgradeUnit(city))
        throw new Error("City level-2 upgrade is not legal at 250000 gold");
      intents = [{ type: "upgrade_structure", clientID: "attacker-client",
        unit: UnitType.City, unitId: city.id(), amount: 1 }];
      upgradedTick = w.game.ticks() + 1;
    }
    w.step(intents);
    const current = p.units(UnitType.City)[0];
    if (current && createdTick === null) createdTick = w.game.ticks();
    if (current && !current.isUnderConstruction() && completedTick === null)
      completedTick = w.game.ticks();
    if ([1, 2, 20, 22, 24, 30, 60, 100].includes(t + 1))
      samples.push({ elapsedTicks: t + 1, ...state(w, p, UnitType.City) });
  }
  return { variant: !build ? "no-city" : upgrade ? "city-upgrade" : "one-city",
    before, createdTick, completedTick, upgradedTick, secondCost,
    after: state(w, p, UnitType.City), samples };
}
const city = [cityRun(false, false), cityRun(true, false), cityRun(true, true)];
const noCity = city[0], oneCity = city[1], upgradedCity = city[2];
if (!oneCity.completedTick || oneCity.after.units[0]?.level !== 1 ||
    oneCity.after.troopCapacity - noCity.after.troopCapacity !== 250000 ||
    upgradedCity.after.units[0]?.level !== 2 ||
    upgradedCity.after.troopCapacity - oneCity.after.troopCapacity !== 250000)
  throw new Error("Observed City capacity or upgrade did not match expected per-level increase");

// Zero starting gold, fixed tiles, no conquest/trade: observe actual first
// worker-only affordability, not a claim about a live expansion economy.
function workerAffordability(type: string) {
  const w = world(0);
  const p = w.attacker;
  const cost = w.config.unitInfo(type).cost(w.game, p);
  let turns = 0;
  while (p.gold() < cost && turns < 2000) { w.step(); turns++; }
  if (p.gold() < cost) throw new Error(`${type} not affordable by 2000 ticks`);
  return { type, firstCost: cost.toString(), workerGoldPerTick:
    w.config.goldAdditionRate(p).toString(),
    firstAffordableAfterTicks: turns, gold: p.gold().toString(),
    constructionTicks: w.config.unitInfo(type).constructionDuration };
}
const affordability = [workerAffordability(UnitType.DefensePost), workerAffordability(UnitType.City)];

// Pair identical prepared attacker/defender territory and starting armies.
// The only combat difference is one *completed*, worker-legal defender Post.
function combatRun(withPost: boolean) {
  const w = world(100000, true);
  const a = w.attacker, d = w.defender;
  const postTile = w.game.ref(110, 100);
  const candidate = w.runner.playerBuildables(d.id(), 110, 100, [UnitType.DefensePost])[0];
  if (candidate.type !== UnitType.DefensePost || candidate.canBuild === false ||
      candidate.cost !== 50000n) throw new Error("Defense Post is not worker-legal at expected cost");
  const postSource = candidate.canBuild;
  let firstPostTick: number | null = null;
  let postCompleteTick: number | null = null;
  for (let t = 0; t < 65; t++) {
    w.step(t === 0 && withPost ? [{ type: "build_unit", clientID: "defender-client",
      unit: UnitType.DefensePost, tile: postTile }] : []);
    const unit = d.units(UnitType.DefensePost)[0];
    if (unit && firstPostTick === null) firstPostTick = w.game.ticks();
    if (unit && !unit.isUnderConstruction() && postCompleteTick === null)
      postCompleteTick = w.game.ticks();
  }
  const post = d.units(UnitType.DefensePost)[0];
  if (withPost && (!post || post.isUnderConstruction() ||
      !w.game.hasUnitNearby(w.game.ref(100, 100), w.config.defensePostRange(),
        UnitType.DefensePost, d.id())))
    throw new Error("Completed Post does not cover the prepared front");
  if (!withPost && post) throw new Error("Control accidentally owns a Post");
  const postUpgradable = post ? d.canUpgradeUnit(post) : null;
  const nextPostCost = post ? w.config.unitInfo(UnitType.DefensePost).cost(w.game, d).toString() : null;
  if (withPost && (postUpgradable !== false || nextPostCost !== "100000"))
    throw new Error("Unexpected Defense Post upgrade/second-post cost");
  // Reset armies immediately before the same attack, after equal setup ticks.
  a.setTroops(200000);
  d.setTroops(50000);
  const inputs = { protected: 0, unprotected: 0, computedAttackerLoss: 0,
    computedTickFraction: 0 };
  const original = w.config.attackLogic.bind(w.config);
  w.config.attackLogic = (input: any) => {
    const result = original(input); // observation only, never modify output
    if (input.defenderHasDefensePost) inputs.protected++;
    else inputs.unprotected++;
    inputs.computedAttackerLoss += result.attackerTroopLoss;
    inputs.computedTickFraction += result.tickFraction;
    return result;
  };
  const front = w.game.ref(100, 100);
  const fixedInput = { terrain: TerrainType.Plains,
    attackTroops: 60000, attacker: { type: PlayerType.Human, numTiles: 2500 },
    defender: { type: PlayerType.Human, numTiles: 2500, troops: 50000,
      isTraitor: false, isDisconnectedTeammate: false },
    defenderHasDefensePost: false, falloutRatio: null, borderSize: 10 };
  const formulaBase = original(fixedInput);
  const formulaPost = original({ ...fixedInput, defenderHasDefensePost: true });
  const before = { attacker: state(w, a, UnitType.DefensePost),
    defender: state(w, d, UnitType.DefensePost),
    postSource: { x: w.game.x(postSource), y: w.game.y(postSource) },
    frontCovered: w.game.hasUnitNearby(front, w.config.defensePostRange(),
      UnitType.DefensePost, d.id()) };
  w.step([{ type: "attack", clientID: "attacker-client",
    targetID: d.id(), troops: 60000 }]);
  const snapshots: any[] = [];
  for (let i = 1; i <= 120; i++) {
    w.step();
    if ([10, 30, 60, 120].includes(i)) snapshots.push({ afterAttackTicks: i,
      attackerTiles: a.numTilesOwned(), defenderTiles: d.numTilesOwned(),
      attackerTroops: a.troops(), defenderTroops: d.troops(),
      activeAttacks: a.outgoingAttacks().length });
  }
  return { withPost, firstPostTick, postCompleteTick,
    postUpgradable, nextPostCost,
    postUnderConstructionAtEnd: post?.isUnderConstruction() ?? null,
    before, formulaBase, formulaPost, observedLogic: inputs,
    snapshots, after: { attacker: state(w, a, UnitType.DefensePost),
      defender: state(w, d, UnitType.DefensePost) } };
}
const combat = [combatRun(false), combatRun(true)];
const ratio = combat[1].formulaPost.attackerTroopLoss / combat[0].formulaBase.attackerTroopLoss;
const timeRatio = combat[1].formulaPost.tickFraction / combat[0].formulaBase.tickFraction;
if (Math.abs(ratio - 5) > 1e-9 || Math.abs(timeRatio - 3) > 1e-9 ||
    combat[0].before.frontCovered || !combat[1].before.frontCovered ||
    combat[1].observedLogic.protected === 0)
  throw new Error("Defense Post expected formula or actual coverage was not observed");
const report = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  modelCalls: 0, map: "synthetic-256x256-plains",
  assumptions: [
    "Real Config/PlayerExecution/ConstructionExecution/UpgradeStructureExecution/AttackExecution via GameRunner/Executor; fresh game per variant.",
    "Manually prepared 2500-tile rectangles to hold geography constant; passive defender has no AI/counters; no model calls or win-rate inference.",
    "Funded build tests start with 400000 gold (City) or 100000 (Post), non-instant construction; separate worker-only affordability test starts at zero gold.",
    "Combat armies reset to 200000/50000 internal troops immediately before identical 60000-troop normal land attack, after 65 setup ticks.",
    "Internal troops divided by 10 for display; observed reserve differences include ongoing growth, not just attack casualties.",
  ],
  city, affordability, combat,
  comparisons: {
    cityCapacityAddedPerLevel: 250000,
    cityOneLevelTroopsGainOverControlAt100Ticks: oneCity.after.troops - noCity.after.troops,
    cityTwoLevelsTroopsGainOverOneLevelAt100Ticks: upgradedCity.after.troops - oneCity.after.troops,
    postFormulaAttackerLossRatio: ratio,
    postFormulaTickFractionRatio: timeRatio,
    defenderTilesAt120Ticks: combat.map((r) => r.snapshots.at(-1).defenderTiles),
  },
};
await mkdir("logs", { recursive: true });
await writeFile("logs/structure-mechanics.json", JSON.stringify(report, null, 2) + "\n");
console.log(`City capacity +250000/level, first worker-only City ${affordability[1].firstAffordableAfterTicks} ticks; ` +
  `Post formula loss x${ratio.toFixed(1)} time x${timeRatio.toFixed(1)}; ` +
  `defender tiles at 120 ticks ${report.comparisons.defenderTilesAt120Ticks.join("/")}. ` +
  `Saved ignored logs/structure-mechanics.json`);
