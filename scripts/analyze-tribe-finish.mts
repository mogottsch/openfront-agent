// Source-grounded, offline conquest-gold and nation-hostility microbench.
// Actual GameRunner/Executor; no browser, Jev, Copilot or upstream changes.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { AttackExecution } = await load("src/core/execution/AttackExecution.ts");
const { NationExecution } = await load("src/core/execution/NationExecution.ts");
const { TribeExecution } = await load("src/core/execution/TribeExecution.ts");
const { PlayerExecution } = await load("src/core/execution/PlayerExecution.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { GameUpdateType } = await load("src/core/game/GameUpdates.ts");
const { Nation, Cell, PlayerInfo, PlayerType,
  Difficulty, GameMapType, GameMapSize, GameMode, GameType } =
  await load("src/core/game/Game.ts");

function config(difficulty: string) {
  return new Config({ gameMap: GameMapType.Europe, gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA, gameType: GameType.Singleplayer,
    difficulty, nations: "disabled", bots: 0,
    donateGold: false, donateTroops: false, infiniteGold: false,
    infiniteTroops: false, instantBuild: false, randomSpawn: false,
    spawnImmunityDuration: 0 }, null, false);
}
function setup({ side, opponentType, gameID, difficulty = Difficulty.Impossible }:
  { side: number; opponentType: string; gameID: string; difficulty?: string }) {
  const meInfo = new PlayerInfo("Human", PlayerType.Human, "human-client", "human");
  const otherInfo = new PlayerInfo("Passive target", opponentType, null, "other");
  const cfg = config(difficulty);
  const main = new GameMapImpl(side, side, new Uint8Array(side * side).fill(128), side * side);
  const mini = new GameMapImpl(side / 2, side / 2,
    new Uint8Array((side * side) / 4).fill(128), (side * side) / 4);
  const nation = opponentType === PlayerType.Nation
    ? [new Nation(new Cell(Math.floor(side * 0.75), Math.floor(side / 2)), otherInfo)] : [];
  const humans = opponentType === PlayerType.Nation ? [meInfo] : [meInfo, otherInfo];
  const game = createGame(humans, nation, main, mini, cfg);
  game.endSpawnPhase();
  const human = game.player("human"), other = game.player("other");
  const events: any[] = [];
  let fatal: string | null = null;
  const runner = new GameRunner(game, new Executor(game, gameID, undefined), (u: any) => {
    if ("errMsg" in u) { fatal = u.errMsg; return; }
    for (const event of u.updates[GameUpdateType.ConquestEvent])
      events.push({ tick: u.tick, conquerorId: event.conquerorId,
        conqueredId: event.conqueredId, gold: event.gold.toString() });
  });
  runner.init();
  let turnNumber = 0;
  const step = (intents: any[] = []) => {
    runner.addTurn({ turnNumber: turnNumber++, intents });
    if (!runner.executeNextTick() || fatal) throw new Error(`Engine tick failed: ${fatal}`);
  };
  return { game, cfg, human, other, events, step };
}

function tribeFinish() {
  const s = setup({ side: 128, opponentType: PlayerType.Bot,
    gameID: "tribe-finish-mechanics" });
  const { game, human, other, step, events } = s;
  for (let y = 29; y < 79; y++) {
    for (let x = 20; x < 70; x++) human.conquer(game.ref(x, y));
    for (let x = 70; x < 90; x++) other.conquer(game.ref(x, y));
  }
  human.setSpawnTile(game.ref(45, 54));
  other.setSpawnTile(game.ref(80, 54));
  human.setTroops(200000);
  other.setTroops(50000);
  other.addGold(100000n); // explicit controlled stockpile, not a real tribe spawn bonus
  game.addExecution(new PlayerExecution(human), new PlayerExecution(other));
  let capturedAtElimination: any = null;
  const originalConquer = game.conquerPlayer.bind(game);
  game.conquerPlayer = (killer: any, victim: any) => {
    const before = { killerGold: killer.gold().toString(),
      victimGold: victim.gold().toString(), victimTiles: victim.numTilesOwned() };
    originalConquer(killer, victim); // observation-only wrapper, never change transfer
    capturedAtElimination = { before, after: { killerGold: killer.gold().toString(),
      victimGold: victim.gold().toString() } };
  };
  const initial = { tick: game.ticks(), humanGold: human.gold().toString(),
    tribeGold: other.gold().toString(), tribeTiles: other.numTilesOwned(),
    tribeTroops: other.troops() };
  step(); // initialize player executions
  step([{ type: "attack", clientID: "human-client", targetID: other.id(), troops: 8000 }]);
  const partial: any[] = [];
  for (let i = 0; i < 15; i++) {
    step();
    if ([1, 2, 5, 10, 15].includes(i + 1)) partial.push({ tick: game.ticks(),
      tribeTiles: other.numTilesOwned(), tribeTroops: other.troops(),
      tribeGold: other.gold().toString(), humanGold: human.gold().toString(),
      conquestEvents: events.length });
    if (events.length) break;
  }
  if (events.length || !other.isAlive() || other.numTilesOwned() >= initial.tribeTiles)
    throw new Error("Partial tribe trial unexpectedly eliminated target or took no tiles");
  // One normal additional send followed by bounded, explicit reinforcement if
  // necessary. This is mechanics isolation, not an approved bot strategy.
  let reinforcements = 0;
  for (let t = 0; t < 500 && !events.length; t++) {
    const intents = [];
    if (t % 10 === 0 && human.troops() > 10000) {
      intents.push({ type: "attack", clientID: "human-client",
        targetID: other.id(), troops: Math.floor(human.troops() * 0.5) });
      reinforcements++;
    }
    step(intents);
  }
  if (events.length !== 1 || other.numTilesOwned() >= 100 ||
      events[0].conquerorId !== human.id() || events[0].conqueredId !== other.id())
    throw new Error("Tribe did not yield exactly one normal conquest event");
  if (!capturedAtElimination ||
      BigInt(capturedAtElimination.before.victimGold) !== BigInt(events[0].gold) ||
      BigInt(capturedAtElimination.after.killerGold) -
        BigInt(capturedAtElimination.before.killerGold) !== BigInt(events[0].gold) ||
      capturedAtElimination.after.victimGold !== "0")
    throw new Error("Bot conquest transfer did not match its gold at elimination");
  const final = { tick: game.ticks(), tribeTiles: other.numTilesOwned(),
    tribeGold: other.gold().toString(), humanGold: human.gold().toString(),
    event: events[0], capturedAtElimination, reinforcements };
  return { initial, partial, final };
}

// Same native TribeExecution RNG, map, initial player strength and 10-second
// bot growth/expansion preparation for each branch. Every branch sends 10%
// first; follow-ups (if any) use 10% or 20% every fourth game second.
function activeTribeRun(follow: "wait" | "repeat10" | "repeat20",
  initialHumanTroops: number) {
  const s = setup({ side: 128, opponentType: PlayerType.Bot,
    gameID: "active-tribe-001", difficulty: Difficulty.Easy });
  const { game, human, other: tribe, step, events, cfg } = s;
  for (let y = 29; y < 79; y++) {
    for (let x = 20; x < 70; x++) human.conquer(game.ref(x, y));
    for (let x = 70; x < 90; x++) tribe.conquer(game.ref(x, y));
  }
  human.setSpawnTile(game.ref(45, 54));
  tribe.setSpawnTile(game.ref(80, 54));
  human.setTroops(initialHumanTroops); // controlled reserve cohort, not a live strategy
  tribe.setTroops(50000);
  game.addExecution(new PlayerExecution(human), new PlayerExecution(tribe),
    new TribeExecution(tribe));
  const nativeTribeAttacksQueued: any[] = [];
  const add = game.addExecution.bind(game);
  game.addExecution = (...executions: any[]) => {
    for (const e of executions)
      if (e instanceof AttackExecution && e.owner() === tribe)
        nativeTribeAttacksQueued.push({ tick: game.ticks(), targetID: e.targetID() });
    add(...executions); // observation only; preserve engine order/output
  };
  for (let i = 0; i < 100; i++) step(); // 10s native tribe growth/counters, no human intents
  if (!human.isAlive() || !tribe.isAlive() || events.length)
    throw new Error("Active tribe setup ended before first send");
  const initial = { tick: game.ticks(), humanTroops: human.troops(),
    humanCapacity: cfg.maxTroops(human), humanGold: human.gold().toString(),
    tribeTroops: tribe.troops(), tribeCapacity: cfg.maxTroops(tribe),
    tribeTiles: tribe.numTilesOwned(), tribeGold: tribe.gold().toString(),
    tribeOutgoing: tribe.outgoingAttacks().map((a: any) => ({
      target: a.target().id(), troops: a.troops() })) };
  const actions: any[] = [];
  const checkpoints: any[] = [];
  let liveTicks = 0;
  for (let i = 0; i < 1200 && !events.length && human.isAlive() && tribe.isAlive(); i++) {
    const intents: any[] = [];
    const fraction = i === 0 ? 0.1 : follow === "wait" ? 0 :
      i % 40 === 0 ? follow === "repeat10" ? 0.1 : 0.2 : 0;
    if (![0, 0.1, 0.2].includes(fraction)) throw new Error("Out-of-scope bot fraction");
    if (fraction > 0 && human.sharesBorderWith(tribe) && human.canAttackPlayer(tribe)) {
      const troops = Math.floor(human.troops() * fraction);
      if (troops > 0) {
        intents.push({ type: "attack", clientID: "human-client",
          targetID: tribe.id(), troops });
        actions.push({ afterFirstSendTicks: i, fraction,
          troops, reserveBefore: human.troops(),
          tribeTilesBefore: tribe.numTilesOwned(),
          tribeTroopsBefore: tribe.troops(), tribeGoldBefore: tribe.gold().toString() });
      }
    }
    step(intents);
    liveTicks++;
    if ([1, 20, 40, 80, 120, 200, 300, 450, 600, 900, 1200].includes(i + 1) ||
        events.length) checkpoints.push({ afterFirstSendTicks: i + 1,
      humanReserve: human.troops(), humanGold: human.gold().toString(),
      humanIncoming: human.incomingAttacks().length,
      activeHumanAttackOnTribe: human.outgoingAttacks()
        .filter((a: any) => a.target() === tribe && !a.retreating())
        .reduce((sum: number, a: any) => sum + a.troops(), 0),
      tribeTiles: tribe.numTilesOwned(), tribeTroops: tribe.troops(),
      tribeGold: tribe.gold().toString(),
      tribeOutgoing: tribe.outgoingAttacks().map((a: any) => ({
        target: a.target().id(), troops: a.troops() })),
      conquestEvents: events.length });
  }
  const conquest = events.find((e) => e.conquerorId === human.id() &&
    e.conqueredId === tribe.id()) ?? null;
  return { follow, initialHumanTroops, initial, actions, checkpoints, liveTicks,
    nativeTribeAttacksQueued,
    tribeEliminated: !tribe.isAlive(), conquest,
    final: { humanAlive: human.isAlive(), humanTiles: human.numTilesOwned(),
      humanReserve: human.troops(), humanGold: human.gold().toString(),
      tribeTiles: tribe.numTilesOwned(), tribeTroops: tribe.troops(),
      tribeGold: tribe.gold().toString() } };
}

function nationResponse(attacked: boolean) {
  const s = setup({ side: 64, opponentType: PlayerType.Nation,
    gameID: "nation-hostility-mechanics" });
  const { game, human, other: nation, step } = s;
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      (x < 32 ? human : nation).conquer(game.ref(x, y));
  human.setSpawnTile(game.ref(16, 32));
  nation.setSpawnTile(game.ref(48, 32));
  human.setTroops(250000);
  nation.setTroops(240000);
  game.addExecution(new PlayerExecution(human), new PlayerExecution(nation));
  const nativeQueued: any[] = [];
  const add = game.addExecution.bind(game);
  game.addExecution = (...executions: any[]) => {
    for (const e of executions)
      if (e instanceof AttackExecution && e.owner() === nation &&
          e.targetID() === human.id())
        nativeQueued.push({ tick: game.ticks(), targetID: human.id() });
    add(...executions); // observe only, never alter order/behavior
  };
  for (let i = 0; i < 55; i++) step();
  const nationAI = new NationExecution("nation-hostility-mechanics",
    new Nation(new Cell(48, 32), nation.info()));
  game.addExecution(nationAI);
  step(); // initialize native AI; the human attack (if any) is the next turn
  const before = { tick: game.ticks(), relation: nation.relation(human),
    nationGold: nation.gold().toString(), nationTroops: nation.troops() };
  if (attacked) step([{ type: "attack", clientID: "human-client",
    targetID: nation.id(), troops: 5000 }]);
  else step();
  const after = { tick: game.ticks(), relation: nation.relation(human),
    incoming: nation.incomingAttacks().map((a: any) => ({ id: a.id(), troops: a.troops() })),
    embargo: nation.hasEmbargoAgainst(human) };
  const checkpoints: any[] = [];
  let endedEarly: string | null = null;
  for (let i = 1; i <= 300; i++) {
    if (!human.isAlive() || !nation.isAlive() || game.getWinner() !== null) {
      endedEarly = !human.isAlive() ? "human-eliminated" :
        !nation.isAlive() ? "nation-eliminated" : "engine-winner";
      break;
    }
    step();
    if ([1, 10, 50, 100, 200, 300].includes(i)) checkpoints.push({
      afterAttackTicks: i, tick: game.ticks(), relation: nation.relation(human),
      incoming: nation.incomingAttacks().length,
      embargo: nation.hasEmbargoAgainst(human),
      nativeAttacksQueuedToHuman: nativeQueued.length,
      nationAlive: nation.isAlive(), humanAlive: human.isAlive(),
    });
  }
  return { attacked, before, after, checkpoints, nativeQueued, endedEarly,
    endTick: game.ticks(), winner: game.getWinner()?.name() ?? null,
    humanTiles: human.numTilesOwned(), nationTiles: nation.numTilesOwned() };
}
const tribe = tribeFinish();
const activeTribeSweep = [20000, 150000].flatMap((initialTroops) =>
  (["wait", "repeat10", "repeat20"] as const).map((follow) =>
    activeTribeRun(follow, initialTroops)));
const nations = [nationResponse(false), nationResponse(true)];
const report = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  modelCalls: 0, map: "synthetic prepared 128x128 tribe / 64x64 nation plains",
  caveats: [
    "Passive Bot has PlayerExecution growth but no TribeExecution AI; 100000 starting gold was manually added to isolate capture attribution.",
    "Nation pair has natural NationExecution attack logic enabled after 55 ticks; all land pre-owned to remove wilderness distraction. Native attack queue observation forwards unmodified Game.addExecution calls.",
    "Only one human attacker in gold trial; partial damage grants no gold until Game.conquerPlayer during target elimination below 100 tiles.",
    "Any AI retaliation depends on reserve ratio, attack timing, geometry, relative strength and other strategies; -100 relation alone does not guarantee a counterattack every tick.",
    "Active TribeExecution sweep has two separate matched Easy synthetic 128x128 reserve cohorts (initial human 20000 or 150000 internal troops) versus the same prepared native Bot: first 10% send then wait, repeat 10% every 40 ticks, or repeat 20% every 40 ticks; every control is hard-capped at 1200 ticks and <=20% per attack. No model judgment.",
  ], tribe, activeTribeSweep, nations,
};
await mkdir("logs", { recursive: true });
await writeFile("logs/tribe-gold-nation-hostility.json", JSON.stringify(report, null, 2) + "\n");
console.log(`Partial tribe gold ${tribe.partial.at(-1).humanGold}, ` +
  `conquest +${tribe.final.event.gold}; nation relation before/after ` +
  `${nations[1].before.relation}/${nations[1].after.relation}, ` +
  `active tribe kills (low/high × wait/10/20)=${activeTribeSweep.map((r) => Boolean(r.conquest)).join("/")}; ` +
  `native queued attacks ${nations[0].nativeQueued.length}/${nations[1].nativeQueued.length}. ` +
  `Saved ignored logs/tribe-gold-nation-hostility.json`);
