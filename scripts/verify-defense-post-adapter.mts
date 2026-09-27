// Offline actual-engine DP adapter: two paired prepared worlds, one explicit
// MOCK build vs save Choice. No browser, model calls, upstream edits or AI.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDefensePostAdapter } from "../web/defense-post-adapter.js";
import { observeCore } from "./benchmark-jev-observation.mjs";
import { validateHybridInput } from "../web/hybrid-observation.js";
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { PlayerExecution } = await load("src/core/execution/PlayerExecution.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { PlayerInfo, PlayerType, GameMapType, GameMapSize, GameMode,
  GameType, Difficulty, UnitType } = await load("src/core/game/Game.ts");
const side = 256;
const gameID = "defense-post-adapter-synthetic-001";
const defenderClient = "defender-client";
const attackerClient = "attacker-client";

function world() {
  const config = new Config({ gameMap: GameMapType.Europe,
    gameMapSize: GameMapSize.Normal, gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer, difficulty: Difficulty.Medium,
    nations: "disabled", bots: 0, donateGold: false, donateTroops: false,
    infiniteGold: false, infiniteTroops: false, instantBuild: false,
    randomSpawn: false, startingGold: 100000, spawnImmunityDuration: 0,
  }, null, false);
  const infos = [new PlayerInfo("Passive defender", PlayerType.Human,
    defenderClient, "defender"),
    new PlayerInfo("Attacker", PlayerType.Human, attackerClient, "attacker")];
  const main = new GameMapImpl(side, side,
    new Uint8Array(side * side).fill(128), side * side);
  const mini = new GameMapImpl(side / 2, side / 2,
    new Uint8Array((side * side) / 4).fill(128), (side * side) / 4);
  const game = createGame(infos, [], main, mini, config);
  game.endSpawnPhase();
  const defender = game.player("defender"), attacker = game.player("attacker");
  for (let y = 75; y < 125; y++) {
    for (let x = 50; x < 100; x++) attacker.conquer(game.ref(x, y));
    for (let x = 100; x < 150; x++) defender.conquer(game.ref(x, y));
  }
  attacker.setSpawnTile(game.ref(75, 100));
  defender.setSpawnTile(game.ref(125, 100));
  attacker.setTroops(200000);
  defender.setTroops(50000);
  game.addExecution(new PlayerExecution(defender), new PlayerExecution(attacker));
  let fatal: string | null = null;
  const runner = new GameRunner(game, new Executor(game, gameID, undefined),
    (update: any) => { if ("errMsg" in update) fatal = update.errMsg; });
  runner.init();
  let turnNumber = 0;
  function step(intents: any[] = []) {
    runner.addTurn({ turnNumber: turnNumber++, intents });
    if (!runner.executeNextTick() || fatal) throw new Error(`Engine tick failure: ${fatal}`);
  }
  return { game, config, runner, defender, attacker, step };
}

function gameViewFacade(w: any) {
  const { game, runner, defender } = w;
  // PlayerView exposes AttackUpdate metadata rather than core Attack methods.
  // Map only those source-backed fields from the live core Attack objects;
  // buildables delegates to the real worker-facing GameRunner query.
  const me = new Proxy(defender, {
    get(target: any, prop: string | symbol) {
      if (prop === "buildables") return async (tile: number, types: string[]) => {
        if (!game.isValidRef(tile)) throw new Error("Invalid worker tile");
        return runner.playerBuildables(target.id(), game.x(tile), game.y(tile), types);
      };
      if (prop === "incomingAttacks") return () => target.incomingAttacks().map((a: any) => ({
        id: a.id(), attackerID: a.attacker().smallID(), targetID: a.target().smallID(),
        troops: a.troops(), retreating: a.retreating(),
      }));
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const view = new Proxy(game, {
    get(target: any, prop: string | symbol) {
      if (prop === "gameID") return () => gameID;
      if (prop === "myPlayer") return () => me;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { view, me };
}

async function run(kind: "build" | "save") {
  const w = world();
  const { game, defender, attacker, step, config } = w;
  step(); // initialize native PlayerExecution and WinCheck
  step([{ type: "attack", clientID: attackerClient,
    targetID: defender.id(), troops: 1000 }]);
  if (defender.incomingAttacks().length !== 1 ||
      defender.incomingAttacks()[0].attacker().smallID() !== attacker.smallID())
    throw new Error("Expected real non-retreating incoming attacker missing");
  const view = gameViewFacade(w);
  const state = () => ({ ready: !game.inSpawnPhase(), ended: game.getWinner() !== null,
    tick: game.ticks() });
  let queued: any = null;
  const adapter = createDefensePostAdapter({ game: view.view, read: state,
    defenseUnit: UnitType.DefensePost,
    sendBuild: (unit: string, tile: number) => {
      if (queued || !state().ready || state().ended || unit !== UnitType.DefensePost ||
          !game.isValidRef(tile)) return false;
      queued = { type: "build_unit", unit, tile, clientID: defenderClient };
      return true;
    },
  });
  const proposal = await adapter.propose({ mapId: "plain256",
    maxCandidates: 8, maxExamined: 512, maxWorkerChecks: 8 });
  const observed = observeCore(game, defender);
  if (proposal.source_tick !== observed.tick || proposal.current_tick !== observed.tick)
    throw new Error("DP and land observations differ in tick");
  const raw = validateHybridInput({ game_id: gameID, snapshot_tick: observed.tick,
    land: observed.observation, building: null, naval: null, plan: null,
    city_mechanics: { troop_capacity_gain_display: config.cityTroopIncrease() / 10,
      construction_ticks: config.unitInfo(UnitType.City).constructionDuration },
    defense_post: proposal });
  if (!observed.observation.incoming_attacks.some((a) =>
      a.attacker_id === attacker.smallID() && !a.retreating && a.troops > 0) ||
      !proposal.incoming.non_retreating_attacker_ids.includes(attacker.smallID()))
    throw new Error("Worker proposal lost the genuine observed attacker ID");
  const selected = proposal.candidates.find((c: any) =>
    c.potential_incoming_contact_ids.includes(attacker.smallID()) &&
    c.marginal_potential_incoming_front_contacts > 0);
  if (!selected || proposal.candidates.length !== 8)
    throw new Error("No worker-legal candidate covering potential observed pressure");
  const chosenID = kind === "build" ? selected.id : proposal.save_gold.id;
  if (!await adapter.canExecute(chosenID) || !await adapter.execute(chosenID))
    throw new Error("Explicit mock post choice failed same-tick adapter permit");
  if ((kind === "build") !== Boolean(queued))
    throw new Error("Save/build choice emitted an incorrect normal intent");
  const snapshot = { kind, tick: game.ticks(), raw, proposal,
    selected: { source: "explicit-mock", id: chosenID,
      potential_incoming_contact_ids: selected.potential_incoming_contact_ids },
    emitted: queued ? { type: queued.type, unit: queued.unit,
      tile: [game.x(queued.tile), game.y(queued.tile)] } : null,
    defenderGold: defender.gold().toString() };
  const incoming = defender.incomingAttacks()[0];
  const attackID = incoming.id();
  step([...(queued ? [queued] : []),
    { type: "cancel_attack", clientID: attackerClient, attackID }]);
  queued = null;
  let createdTick: number | null = null;
  let completedTick: number | null = null;
  let constructionVisible = false;
  let protectedWhileConstructing: boolean | null = null;
  for (let i = 0; i < 65; i++) {
    step();
    const post = defender.units(UnitType.DefensePost)[0];
    if (post && createdTick === null) createdTick = game.ticks();
    if (post?.isUnderConstruction()) {
      constructionVisible = true;
      if (protectedWhileConstructing === null) {
        const frontAtPostY = game.ref(100, Math.max(75, Math.min(124, game.y(post.tile()))));
        protectedWhileConstructing = game.hasUnitNearby(frontAtPostY,
          config.defensePostRange(), UnitType.DefensePost, defender.id());
      }
    }
    if (post && !post.isUnderConstruction() && completedTick === null)
      completedTick = game.ticks();
  }
  if (attacker.outgoingAttacks().length) throw new Error("Pressure attack still active");
  const post = defender.units(UnitType.DefensePost)[0];
  if (kind === "build" && (!post || !constructionVisible || completedTick === null ||
      protectedWhileConstructing !== false))
    throw new Error("Normal build did not progress from uncovered construction to completed post");
  if (kind === "save" && post) throw new Error("Control unexpectedly acquired a Post");
  const base = { tick: game.ticks(), attackerTiles: attacker.numTilesOwned(),
    defenderTiles: defender.numTilesOwned(), defenderGold: defender.gold().toString(),
    createdTick, completedTick, constructionVisible,
    protectedWhileConstructing,
    postSite: post ? [game.x(post.tile()), game.y(post.tile())] : null };
  const front = post ? game.ref(100, Math.max(75, Math.min(124, game.y(post.tile())))) : null;
  return { w, snapshot, base, front };
}

const control = await run("save");
const protectedRun = await run("build");
if (control.base.attackerTiles !== protectedRun.base.attackerTiles ||
    control.base.defenderTiles !== protectedRun.base.defenderTiles)
  throw new Error("Paired territorial state diverged before controlled attack");
const front = protectedRun.front;
if (front === null || !protectedRun.w.game.hasUnitNearby(front,
    protectedRun.w.config.defensePostRange(), UnitType.DefensePost,
    protectedRun.w.defender.id()))
  throw new Error("Completed worker-selected post does not cover measured front");
const observations: any[] = [];
for (const row of [control, protectedRun]) {
  const w = row.w, { attacker, defender, config, game, step } = w;
  attacker.setTroops(200000);
  defender.setTroops(50000);
  const inputs = { protected: 0, unprotected: 0 };
  const original = config.attackLogic.bind(config);
  config.attackLogic = (input: any) => {
    if (input.defenderHasDefensePost) inputs.protected++;
    else inputs.unprotected++;
    return original(input);
  };
  const before = { attackerTiles: attacker.numTilesOwned(),
    defenderTiles: defender.numTilesOwned(), attackerTroops: attacker.troops(),
    defenderTroops: defender.troops(),
    front: [game.x(front), game.y(front)],
    frontCovered: game.hasUnitNearby(front, config.defensePostRange(),
      UnitType.DefensePost, defender.id()) };
  step([{ type: "attack", clientID: attackerClient,
    targetID: defender.id(), troops: 60000 }]);
  const samples = [];
  for (let i = 1; i <= 120; i++) {
    step();
    if ([10, 30, 60, 120].includes(i)) samples.push({ afterAttackTicks: i,
      attackerTiles: attacker.numTilesOwned(), defenderTiles: defender.numTilesOwned(),
      attackerTroops: attacker.troops(), defenderTroops: defender.troops() });
  }
  observations.push({ kind: row.snapshot.kind, before, inputs, samples });
}
if (observations[0].before.frontCovered || !observations[1].before.frontCovered ||
    observations[0].inputs.protected !== 0 || observations[1].inputs.protected < 1)
  throw new Error("Actual controlled attack never exercised post coverage difference");
const result = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  modelCalls: 0, map: "synthetic-256x256-plains", activeAI: false,
  assumptions: [
    "Two independently fresh paired real GameRunner worlds with 2500-tile adjacent human rectangles, real PlayerExecution and worker-facing playerBuildables; no native AI or model calls.",
    "One 1000-internal-troop normal incoming attack creates an actual attacker ID in the raw land observation; both runs queue the same cancel intent after explicit mock build/save choice.",
    "The 65-tick construction interval has no active incoming attack. Arms reset to 200000/50000 immediately before the identical 60000-troop second land attack; previous territorial state must match.",
    "DP candidate geometric incoming-front coverage is potential, not a revealed future attack path. Actual completed post coverage uses Game.hasUnitNearby at the measured tile and actual AttackExecution flags.",
  ],
  cases: [{ snapshot: control.snapshot, base: control.base, combat: observations[0] },
    { snapshot: protectedRun.snapshot, base: protectedRun.base, combat: observations[1] }],
  comparison: {
    observedAttackerID: protectedRun.w.attacker.smallID(),
    workerCandidateCount: protectedRun.snapshot.proposal.candidates.length,
    postTile: protectedRun.base.postSite,
    frontTile: observations[1].before.front,
    protectedLogicCalls: observations[1].inputs.protected,
    defenderTilesAfter120: observations.map((r) => r.samples.at(-1).defenderTiles),
  },
};
await mkdir("logs", { recursive: true });
await writeFile("logs/defense-post-adapter.json", JSON.stringify(result, null, 2) + "\n");
console.log(`Mock DP adapter ${protectedRun.snapshot.selected.id} built at ` +
  `${protectedRun.base.postSite}; protected logic calls ${result.comparison.protectedLogicCalls}; ` +
  `defender tiles @120 ${result.comparison.defenderTilesAfter120.join("/")}; ` +
  `ignored logs/defense-post-adapter.json`);
