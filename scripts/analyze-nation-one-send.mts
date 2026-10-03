// Deterministic real-engine nation one-send limits: no Jev, browser or API.
// Synthetic passable rectangles on impassable plains isolate land combat;
// actual Config, AttackExecution, ConstructionExecution, PlayerExecution and
// optionally native NationExecution run through GameRunner/Executor turns.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { AttackExecution } = await load("src/core/execution/AttackExecution.ts");
const { NationExecution } = await load("src/core/execution/NationExecution.ts");
const { ConstructionExecution } = await load("src/core/execution/ConstructionExecution.ts");
const { PlayerExecution } = await load("src/core/execution/PlayerExecution.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { GameUpdateType } = await load("src/core/game/GameUpdates.ts");
const { Nation, Cell, PlayerInfo, PlayerType, Difficulty, GameMapType,
  GameMapSize, GameMode, GameType, UnitType, Relation } = await load("src/core/game/Game.ts");
const side = 256;
const humanRect = { x: 50, y: 75, w: 50, h: 50 };
const targetRects: Record<number, { x: number; y: number; w: number; h: number }> = {
  80: { x: 100, y: 75, w: 2, h: 40 }, // intentionally already below 100
  100: { x: 100, y: 75, w: 2, h: 50 }, // one tile triggers elimination
  500: { x: 100, y: 75, w: 10, h: 50 },
  2000: { x: 100, y: 75, w: 40, h: 50 },
};
const fractions = [0.1, 0.2, 0.3, 0.4, 0.5];
const PLAYER_TROOPS = 300000;
const IMPASSABLE = 128 | 31;
const PLAINS = 128;
const seed = "nation-one-send-fixed-001";
type Case = { targetTiles: number; targetTroops: number; post: boolean;
  nativeAI: boolean; fraction: number; terrain: "plains" | "mountain" };
function fillTerrain(width: number, scale: number, nationRect: typeof humanRect,
  targetTerrain: Case["terrain"]) {
  const terrain = new Uint8Array(width * width).fill(IMPASSABLE);
  let passable = 0;
  for (const r of [humanRect, nationRect]) {
    const x0 = Math.floor(r.x / scale), y0 = Math.floor(r.y / scale);
    const x1 = Math.ceil((r.x + r.w) / scale), y1 = Math.ceil((r.y + r.h) / scale);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (terrain[y * width + x] === IMPASSABLE) passable++;
      terrain[y * width + x] = r === nationRect && targetTerrain === "mountain"
        ? PLAINS | 20 : PLAINS;
    }
  }
  return new GameMapImpl(width, width, terrain, passable);
}
function setup({ targetTiles, targetTroops, post, fraction, terrain }: Case) {
  const rect = targetRects[targetTiles];
  if (!rect || !fractions.includes(fraction) || ![50000, 150000, 300000].includes(targetTroops))
    throw new Error("Unsupported controlled nation case");
  const gameID = seed; // same IDs/RNG for every paired fraction/terrain/Post/AI case
  const config = new Config({ gameMap: GameMapType.Europe,
    gameMapSize: GameMapSize.Normal, gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer, difficulty: Difficulty.Impossible,
    nations: "disabled", bots: 0, donateGold: false, donateTroops: false,
    infiniteGold: false, infiniteTroops: false, instantBuild: false,
    randomSpawn: false, spawnImmunityDuration: 0 }, null, false);
  const humanInfo = new PlayerInfo("Human after tribe", PlayerType.Human,
    "human-client", "human");
  const nationInfo = new PlayerInfo("Native target", PlayerType.Nation, null, "nation");
  const nationSource = new Nation(new Cell(100, 100), nationInfo);
  const game = createGame([humanInfo], [nationSource],
    fillTerrain(side, 1, rect, terrain), fillTerrain(side / 2, 2, rect, terrain), config);
  game.endSpawnPhase();
  const human = game.player(humanInfo.id), nation = game.player(nationInfo.id);
  for (let y = humanRect.y; y < humanRect.y + humanRect.h; y++)
    for (let x = humanRect.x; x < humanRect.x + humanRect.w; x++)
      human.conquer(game.ref(x, y));
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++)
      nation.conquer(game.ref(x, y));
  human.setSpawnTile(game.ref(75, 100));
  nation.setSpawnTile(game.ref(100 + Math.floor(rect.w / 2),
    Math.min(100, rect.y + rect.h - 1)));
  game.addExecution(new PlayerExecution(human), new PlayerExecution(nation));
  // This harness intentionally does NOT call GameRunner.init(): a prepared
  // target with 80/100 tiles would trigger the real WinCheck immediately from
  // the human's >80% initial share, before the combat question is asked.
  // Executor still maps every normal turn to real game executions.
  let fatal: string | null = null;
  const conquests: any[] = [];
  const runner = new GameRunner(game, new Executor(game, gameID, undefined), (u: any) => {
    if ("errMsg" in u) { fatal = u.errMsg; return; }
    for (const e of u.updates[GameUpdateType.ConquestEvent])
      conquests.push({ tick: u.tick, winner: e.conquerorId,
        target: e.conqueredId, gold: e.gold.toString() });
  });
  let turnNumber = 0;
  const step = (intents: any[] = []) => {
    runner.addTurn({ turnNumber: turnNumber++, intents });
    if (!runner.executeNextTick() || fatal) throw new Error(`Engine tick failed: ${fatal}`);
  };
  step(); // PlayerExecution init
  const desiredSite = game.ref(100 + Math.min(5, rect.w - 1), 100);
  let postCreated: number | null = null, postCompleted: number | null = null;
  let postCost: string | null = null;
  if (post) {
    nation.addGold(50000n); // exact first-Post financing, spent before combat
    const legal = runner.playerBuildables(nation.id(), game.x(desiredSite),
      game.y(desiredSite), [UnitType.DefensePost])[0];
    if (!legal || legal.canBuild === false || legal.cost !== 50000n)
      throw new Error("Configured Defense Post is not worker legal at 50000");
    postCost = legal.cost.toString();
    // Nations have no clientID. Native NationStructureBehavior itself adds a
    // ConstructionExecution, so use exactly that trusted core path rather
    // than pretending a human intent can authorize a nation-owned Post.
    game.addExecution(new ConstructionExecution(nation, UnitType.DefensePost,
      desiredSite));
    step(); // initialize ConstructionExecution
  } else step();
  for (let i = 0; i < 64; i++) {
    step();
    const unit = nation.units(UnitType.DefensePost)[0];
    if (unit && postCreated === null) postCreated = game.ticks();
    if (unit && !unit.isUnderConstruction() && postCompleted === null)
      postCompleted = game.ticks();
  }
  return { game, config, runner, human, nation, step, conquests,
    postCost, postCreated, postCompleted, desiredSite, rect, nationSource, gameID };
}

function run(caseInfo: Case) {
  const s = setup(caseInfo);
  const { game, config, human, nation, step, conquests } = s;
  const postUnit = nation.units(UnitType.DefensePost)[0];
  if (caseInfo.post && (!postUnit || postUnit.isUnderConstruction() ||
      !game.hasUnitNearby(game.ref(100, 100), config.defensePostRange(),
        UnitType.DefensePost, nation.id())))
    throw new Error("Nation Post never completed over the target front");
  if (!caseInfo.post && postUnit) throw new Error("No-Post control gained a Post");
  const nativeQueued: any[] = [];
  if (caseInfo.nativeAI) {
    const add = game.addExecution.bind(game);
    game.addExecution = (...execs: any[]) => {
      for (const e of execs)
        if (e instanceof AttackExecution && e.owner() === nation &&
            e.targetID() === human.id())
          nativeQueued.push({ tick: game.ticks(), targetID: human.id() });
      add(...execs);
    };
    game.addExecution(new NationExecution(s.gameID, s.nationSource));
  }
  // Native AI first queues an unconditional wilderness attack on behavior
  // initialization. Allow that no-wilderness attempt to resolve BEFORE the
  // controlled armies are reset; don't halve the AI defender mid-trial as an
  // accidental initialization artifact. Passive controls advance equally.
  for (let i = 0; i < 3; i++) step();
  if (human.numTilesOwned() !== 2500 || nation.numTilesOwned() !== caseInfo.targetTiles ||
      nation.outgoingAttacks().length || nativeQueued.length)
    throw new Error("Native initialization changed the prepared paired combat state");
  human.setTroops(PLAYER_TROOPS);
  nation.setTroops(caseInfo.targetTroops);
  const targetGoldBefore = nation.gold().toString();
  const before = { tick: game.ticks(), humanTiles: human.numTilesOwned(),
    targetTiles: nation.numTilesOwned(), humanTroops: human.troops(),
    targetTroops: nation.troops(), targetGold: targetGoldBefore,
    relation: nation.relation(human),
    troopCapacity: config.maxTroops(nation),
    post: postUnit ? { site: [game.x(postUnit.tile()), game.y(postUnit.tile())],
      completedAt: s.postCompleted, cost: s.postCost } : null };
  if (before.relation !== Relation.Neutral || before.humanTroops !== PLAYER_TROOPS ||
      before.targetTroops !== caseInfo.targetTroops)
    throw new Error("Prepared armies/relation do not match requested trial");
  const amount = Math.floor(human.troops() * caseInfo.fraction);
  const transfers: any[] = [];
  const conquer = game.conquerPlayer.bind(game);
  game.conquerPlayer = (killer: any, victim: any) => {
    const before = { killer: killer.id(), victim: victim.id(),
      victimTiles: victim.numTilesOwned(), victimGold: victim.gold().toString(),
      killerGold: killer.gold().toString() };
    conquer(killer, victim); // observation only: use unchanged engine transfer
    transfers.push({ before, after: { victimGold: victim.gold().toString(),
      killerGold: killer.gold().toString() } });
  };
  const logic = { protectedTiles: 0, unprotectedTiles: 0 };
  const original = config.attackLogic.bind(config);
  config.attackLogic = (input: any) => {
    if (input.defenderHasDefensePost) logic.protectedTiles++;
    else logic.unprotectedTiles++;
    return original(input); // observe, never change combat output
  };
  step([{ type: "attack", clientID: "human-client",
    targetID: nation.id(), troops: amount }]);
  const afterInit = { tick: game.ticks(), relation: nation.relation(human),
    incoming: nation.incomingAttacks().map((a: any) => a.troops()),
    embargo: nation.hasEmbargoAgainst(human) };
  if (afterInit.relation !== Relation.Hostile || !afterInit.embargo ||
      afterInit.incoming.length !== 1 || afterInit.incoming[0] !== amount)
    throw new Error("Normal intent did not initialize exactly one correctly sized hostile attack");
  const checkpoints: any[] = [];
  const nativeStarted: any[] = [];
  const nativeAttackIDs = new Set<string>();
  let liveTicks = 0;
  let humanAttackEndedAt: number | null = null;
  for (let i = 1; i <= 400 && !conquests.length &&
       human.isAlive() && nation.isAlive(); i++) {
    step(); liveTicks++;
    for (const attack of nation.outgoingAttacks()) {
      if (attack.target() !== human || nativeAttackIDs.has(attack.id())) continue;
      nativeAttackIDs.add(attack.id());
      nativeStarted.push({ tick: game.ticks(), afterSendTicks: i,
        attackID: attack.id(), troops: attack.troops() });
    }
    if (humanAttackEndedAt === null &&
        !human.outgoingAttacks().some((a: any) => a.target() === nation))
      humanAttackEndedAt = i;
    if ([1, 10, 30, 60, 100, 200, 400].includes(i) || conquests.length)
      checkpoints.push({ afterSendTicks: i,
        humanTiles: human.numTilesOwned(), targetTiles: nation.numTilesOwned(),
        humanReserve: human.troops(), targetReserve: nation.troops(),
        remainingAttackTroops: human.outgoingAttacks()
          .filter((a: any) => a.target() === nation)
          .reduce((sum: number, a: any) => sum + a.troops(), 0),
        nationRelation: nation.relation(human),
        nativeAttacksQueued: nativeQueued.length,
        actualNativeIncomingTroops: human.incomingAttacks()
          .filter((a: any) => a.attacker() === nation && !a.retreating())
          .reduce((sum: number, a: any) => sum + a.troops(), 0),
        protectedLogicCalls: logic.protectedTiles });
  }
  const conquered = conquests.find((e) => e.winner === human.id() &&
    e.target === nation.id()) ?? null;
  const remainingStack = human.outgoingAttacks().filter((a: any) => a.target() === nation)
    .reduce((sum: number, a: any) => sum + a.troops(), 0);
  const outcome = conquered ? "nation-conquest" : !human.isAlive() ? "human-eliminated" :
    remainingStack <= 0 ? "one-send-ended-without-conquest" : "censored-tick-cap";
  if (conquered) {
    const transfer = transfers.find((t) => t.before.victim === nation.id());
    if (!transfer || transfer.before.victimTiles >= 100 ||
        transfer.before.victimGold !== conquered.gold || transfer.after.victimGold !== "0" ||
        BigInt(transfer.after.killerGold) - BigInt(transfer.before.killerGold) !== BigInt(conquered.gold))
      throw new Error("Nation bounty not attributed at actual elimination threshold");
  }
  return { ...caseInfo, before, sent: amount,
    sentVsTargetReserve: amount / caseInfo.targetTroops,
    humanAttackIntents: 1, afterInit, liveTicks, outcome, completeConquest: Boolean(conquered),
    event: conquered, allConquests: conquests, transfers, nativeQueued, nativeStarted,
    humanAttackEndedAt, logic, checkpoints,
    after: { humanTiles: human.numTilesOwned(), targetTiles: nation.numTilesOwned(),
      humanAlive: human.isAlive(), nationAlive: nation.isAlive(),
      humanGold: human.gold().toString(), targetGold: nation.gold().toString(),
      relation: nation.relation(human) } };
}
const results: any[] = [];
for (const terrain of ["plains", "mountain"] as const)
  for (const targetTiles of [80, 100, 500, 2000])
    for (const targetTroops of [50000, 150000])
      for (const post of [false, true])
        for (const fraction of fractions)
          results.push(run({ targetTiles, targetTroops, post,
            nativeAI: false, fraction, terrain }));
// A higher-reserve matched passive/native pair exposes actual retaliation
// without treating an impossible reserve ratio as a compulsory counterattack.
for (const nativeAI of [false, true]) for (const fraction of fractions)
  results.push(run({ targetTiles: 2000, targetTroops: 300000, post: false,
    fraction, terrain: "plains", nativeAI }));
// Smaller, separately labeled native-retaliation cohort with the same seed.
for (const info of [
  { targetTiles: 100, targetTroops: 150000, post: false },
  { targetTiles: 500, targetTroops: 150000, post: true },
  { targetTiles: 2000, targetTroops: 150000, post: false },
]) for (const fraction of fractions)
  results.push(run({ ...info, nativeAI: true, fraction, terrain: "plains" }));
const wins = results.filter((r) => r.completeConquest).length;
if (!results.some((r) => r.nativeAI && r.nativeQueued.length && r.nativeStarted.length))
  throw new Error("Native-retaliation cohort never actually queued and started an attack");
if (!results.some((r) => r.completeConquest && r.sent < r.targetTroops) ||
    !results.some((r) => r.outcome === "one-send-ended-without-conquest" && r.sent > r.targetTroops))
  throw new Error("Expected counterexamples to simple send/reserve cutoff missing");
const report = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  modelCalls: 0, seed, map: "prepared synthetic human plains / nation plains-or-mountain rectangles, impassable remainder",
  humanStartTroops: PLAYER_TROOPS, fractions,
  maxAfterSendTicks: 400,
  assumptions: [
    "PlayerExecution, normal stamped AttackExecution and optional trusted ConstructionExecution/NationExecution, no WinCheck: prepared 80/100-tile target would auto-declare human winner at start under real WinCheck 80% rule.",
    "Nation first-Post price 50000 is explicitly financed only in Post cases then spent before attack; armies reset to the same given values after equal setup ticks. This is a combat microbench, not a natural game or a funded strategic build.",
    "Native-retaliation variant runs actual NationExecution. All cases advance three equal initialization turns before troop reset so its initial pointless wilderness send/refund cannot accidentally change defense strength during trial.",
    "Nation full-wallet bounty is recorded from the unmodified Game.conquerPlayer transfer at <100 remaining tiles, not guessed from income or final gold.",
    "Attack initialization hostility is distinguished from conquest. A stopped one-send stack with an alive target is a one-send failure; a still-active stack at 400 ticks would be censored, not impossible forever.",
  ],
  results,
  summary: { cases: results.length, completeConquests: wins,
    smallerThanTargetReserveWins: results.filter((r) => r.completeConquest &&
      r.sent < r.targetTroops).length,
    largerThanTargetReserveFails: results.filter((r) => !r.completeConquest &&
      r.sent > r.targetTroops).length,
    nativeCases: results.filter((r) => r.nativeAI).length,
    nativeCasesWithQueuedHumanAttack: results.filter((r) => r.nativeAI && r.nativeQueued.length).length,
    nativeCasesWithObservedHumanAttack: results.filter((r) => r.nativeAI && r.nativeStarted.length).length,
    censored: results.filter((r) => r.outcome === "censored-tick-cap").length },
};
await mkdir("logs", { recursive: true });
await writeFile("logs/nation-one-send.json", JSON.stringify(report, null, 2) + "\n");
console.log(`Native nation one-send: ${wins}/${results.length} completed, ` +
  `smaller-than-reserve wins ${report.summary.smallerThanTargetReserveWins}, ` +
  `larger-than-reserve bounded failures ${report.summary.largerThanTargetReserveFails}; ` +
  `saved ignored logs/nation-one-send.json`);
