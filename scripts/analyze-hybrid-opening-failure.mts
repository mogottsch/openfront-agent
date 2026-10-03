// OFFLINE fresh local Solo / GameType.Singleplayer reconstruction of the
// recorded failed opening's ONE normal human intent. Not OpenFront Replay
// mode/bridge execution/current model inference, not a new policy outcome.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFocusedEuropeWorld } from "./benchmark-focused-europe.mts";
import { observeCore } from "./benchmark-jev-observation.mjs";
const INPUT = "logs/jev-hybrid-europe-easy-v452-first160.json";
const OUTPUT = "logs/hybrid-opening-failure.json";
const SHA = "daf19393f192cd33c289d1954a7524e421420210deca8c51702958ebbe6fdeee";
const EXPECTED_TICK = 384, EXPECTED_HASH = 610006234975374;
const digest = (b: any) => createHash("sha256").update(b).digest("hex");

export async function reconstructOpeningFailure() {
  const bytes = await readFile(INPUT);
  assert.equal(digest(bytes), SHA, "Recorded input changed; no reconstruction authorized");
  const tape = JSON.parse(bytes.toString("utf8"));
  assert.equal(tape.mode, "live");
  assert.equal(tape.stage, "flat-land-city-loop");
  assert.equal(tape.config.seed, "europe-focus-001");
  assert.equal(tape.config.timer_minutes, 5);
  assert.equal(tape.decisions.length, 39);
  assert.equal(tape.status, "human-eliminated-before-win-event");
  assert.equal(tape.complete, false); assert.equal(tape.win, null);
  assert.equal(tape.after.tick, EXPECTED_TICK); assert.equal(tape.after.hash, EXPECTED_HASH);
  assert.deepEqual(tape.submitted_normal_intents, [{ type: "attack", clientID: "human-client",
    targetID: "k62i96c9", troops: 11690, submitted_tick: 382 }]);
  assert.equal(tape.decisions.filter((r: any) => r.validated_choice.kind === "wait").length, 38);
  const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  const { GameType, UnitType } = await load("src/core/game/Game.ts");
  const { AttackExecution } = await load("src/core/execution/AttackExecution.ts");
  const { PlayerExecution } = await load("src/core/execution/PlayerExecution.ts");
  const world = await createFocusedEuropeWorld({ seed: tape.config.seed,
    minutes: tape.config.timer_minutes }, { paceTick: async () => 0 });
  assert.equal(world.config.gameConfig().gameType, GameType.Singleplayer);
  assert.deepEqual(world.metadata, tape.metadata);
  const { game, human, config } = world;
  const tribe = game.player("k62i96c9");
  const humanExecution = game.executions().find((e: any) =>
    e instanceof PlayerExecution && e.player === human);
  assert.ok(humanExecution, "Actual human PlayerExecution missing");
  const cities = () => human.units(UnitType.City).map((u: any) => ({ id: u.id(),
    tile: u.tile(), level: u.level(), active: u.isActive(), under_construction: u.isUnderConstruction() }));
  const attack = (a: any) => ({ id: a.id(), attacker_id: a.attacker().id(),
    target_id: a.target().id(), troops: a.troops(), active: a.isActive(),
    retreating: a.retreating(), source_tile: a.sourceTile() });
  const player = (p: any) => ({ id: p.id(), small_id: p.smallID(), alive: p.isAlive(),
    tiles: p.numTilesOwned(), reserve_internal: p.troops(), gold: p.gold().toString(),
    last_tile_change: p.lastTileChange(),
    cluster_execution_last_calc: p === human ? humanExecution.lastCalc : null,
    incoming: p.incomingAttacks().map(attack), outgoing: p.outgoingAttacks().map(attack) });
  const scene = () => ({ human: player(human), tribe: player(tribe) });
  assert.deepEqual({ tick: game.ticks(), gold: human.gold().toString(),
    troops_internal: human.troops(), tiles: human.numTilesOwned(),
    troop_capacity_internal: config.maxTroops(human), cities: cities() }, tape.before);
  const trace: any[] = [];
  const transfers: any[] = [];
  const captures: any[] = [];
  const combat: any[] = [];
  let queuedEnemyAttacksAgainstHuman = 0;
  const stamp = () => ({ engine_tick_at_call: game.ticks(),
    submitted_or_update_tick: game.ticks() + 1 });
  for (const method of ["removeClusters", "surroundedBySamePlayer", "removeCluster",
    "isEnclosed", "getCapturingPlayer"]) {
    const original = humanExecution[method];
    humanExecution[method] = function (...args: any[]) {
      const before = scene();
      const result = original.apply(this, args); // unchanged actual calculation
      trace.push({ ...stamp(), event: `human-player-execution-${method}`,
        border_cluster_size: Array.isArray(args[0]) ? args[0].length : null,
        before, after: scene(), result: result?.id ? result.id() : result ?? null });
      return result;
    };
  }
  const watched = (e: any) => e instanceof AttackExecution &&
    (e.owner() === human || e.owner() === tribe || e.targetID() === human.id());
  const originalAdd = game.addExecution.bind(game);
  game.addExecution = (...executions: any[]) => {
    for (const e of executions) {
      if (!watched(e)) continue;
      const who = { owner: e.owner().id(), target: e.targetID() };
      if (e.owner() !== human && e.targetID() === human.id()) queuedEnemyAttacksAgainstHuman++;
      if (game.ticks() >= 380) trace.push({ ...stamp(), event: "attack-execution-queued", ...who,
        source_stack: new Error().stack?.split("\n").slice(2, 8) });
      for (const method of ["init", "tick"] as const) {
        const original = e[method];
        e[method] = function (...args: any[]) {
          const log = game.ticks() >= 380;
          const before = log ? scene() : null;
          const result = original.apply(this, args); // unmodified behavior/output
          if (log) trace.push({ ...stamp(), event: `attack-execution-${method}`, ...who,
            execution_tick_argument: args[method === "init" ? 1 : 0], before, after: scene(),
            attack_object: this.attack ? attack(this.attack) : null });
          return result;
        };
      }
    }
    return originalAdd(...executions);
  };
  const originalConquer = game.conquer.bind(game);
  game.conquer = (p: any, tile: number) => {
    const losingHumanTile = game.ownerID(tile) === human.smallID() && p !== human;
    const before = losingHumanTile ? scene() : null;
    const result = originalConquer(p, tile);
    if (losingHumanTile) captures.push({ ...stamp(), tile, x: game.x(tile), y: game.y(tile),
      new_owner: p.id(), before, after: scene() });
    return result;
  };
  const originalConquerPlayer = game.conquerPlayer.bind(game);
  game.conquerPlayer = (killer: any, victim: any) => {
    const before = { killer: player(killer), victim: player(victim) };
    const result = originalConquerPlayer(killer, victim);
    transfers.push({ ...stamp(), before, after: { killer: player(killer), victim: player(victim) },
      source_stack: new Error().stack?.split("\n").slice(2, 8) });
    return result;
  };
  const originalLogic = config.attackLogic.bind(config);
  config.attackLogic = (input: any) => {
    const result = originalLogic(input);
    if (input.defender?.type === "HUMAN") combat.push({ ...stamp(), input, result });
    return result;
  };
  const snapshots: any[] = [];
  let verifiedInputs = 0;
  const inputByTick = new Map(tape.decisions.map((r: any) => [r.tick, r]));
  const record = () => {
    const input = inputByTick.get(game.ticks()) as any;
    if (input) {
      const now = observeCore(game, human, { gameId: tape.config.seed }).observation;
      for (const field of ["self", "border", "neighbors", "incoming_attacks", "outgoing_attacks"])
        assert.deepEqual(now[field], input.input.land[field], `Physical input ${field} drift at ${game.ticks()}`);
      verifiedInputs++;
    }
    if ([381, 382, 383, 384].includes(game.ticks())) snapshots.push({ source_stamp: {
      game_id: tape.config.seed, game_type: config.gameConfig().gameType,
      snapshot_tick: game.ticks(), method: "recorded-normal-intent-Solo-reconstruction" },
      hash: game.hash(), ...scene() });
  };
  record();
  while (game.ticks() < EXPECTED_TICK) {
    // ONLY the recorded normal intent at its submitted_tick; no branch or
    // speculative land subanswer is executed for the other 38 recorded waits.
    const intents = game.ticks() + 1 === 382 ? [{ type: "attack", clientID: "human-client",
      targetID: "k62i96c9", troops: 11690 }] : [];
    await world.step(intents); record();
  }
  const after = { tick: game.ticks(), seconds: game.elapsedGameSeconds(),
    live_ticks: game.ticks() - tape.before.tick, alive: human.isAlive(),
    tiles: human.numTilesOwned(), gold: human.gold().toString(), troops_internal: human.troops(),
    troop_capacity_internal: config.maxTroops(human), cities: cities(), hash: game.hash() };
  assert.deepEqual(after, tape.after, "Recorded failure final hash/state drift");
  assert.deepEqual(world.events.conquests, tape.conquests);
  assert.equal(world.events.winEvents, tape.win_events);
  assert.equal(verifiedInputs, 39);
  assert.equal(captures.length, 63, "Enclosure cleanup transfers the transient 63-tile territory");
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].before.victim.id, human.id());
  assert.equal(transfers[0].before.victim.tiles, 63, "Conquest credit precedes any human tile loss");
  assert.ok(transfers[0].source_stack.some((line: string) => line.includes("PlayerExecution.removeCluster")));
  assert.equal(combat.length, 0, "This recorded failure has no combat formula call against the human");
  assert.equal(queuedEnemyAttacksAgainstHuman, 0, "No new enemy counterattack was queued in this reconstruction");
  assert.equal(snapshots.find((s) => s.source_stamp.snapshot_tick === 383).human.last_tile_change, 382);
  assert.equal(snapshots.find((s) => s.source_stamp.snapshot_tick === 383).human.cluster_execution_last_calc, 9);
  const output = { schema_version: 1,
    label: "fresh-Solo-Singleplayer-engine-reconstruction-of-recorded-failed-opening",
    input: { file: INPUT, sha256: SHA, policy: tape.policy, hybrid_policy: tape.hybrid_policy },
    execution_environment: { game_type: config.gameConfig().gameType,
      openfront_replay_mode: false, bridge_replay_execution: false,
      model_calls: 0, new_policy_choices: 0, heldout_seeds_used: 0 },
    reproduction: { metadata_roster_equal: true, physical_inputs_equal: verifiedInputs,
      normal_human_intents_replayed: 1, final: after, conquests_equal: true, win_events_equal: true },
    metadata: world.metadata,
    mechanism: { source: "PlayerExecution.removeClusters/removeCluster enclosure cleanup",
      queued_enemy_attack_executions_against_human_since_setup: queuedEnemyAttacksAgainstHuman,
      combat_formula_calls_against_human: combat.length,
      conquest_credit_human_tiles_before_cleanup: transfers[0].before.victim.tiles,
      transient_human_tile_gain: 11, cleanup_tile_transfers: captures.length,
      not_attack_execution_single_tile_threshold: true },
    snapshots, trace, human_tile_transfers: captures,
    conquer_player_transfers: transfers, combat_against_human: combat,
    caveats: ["Original human elimination, not a completed match Win or a fresh model outcome.",
      "Observation wrappers call unchanged engine methods; no substitute choices or attacks.",
      "Private scheduling fields/methods are read-only source diagnostics, not deployed model observations.",
      "Engine internal tick at call and the subsequent reported step/update tick are labeled separately.",
      "Actual path must distinguish PlayerExecution enclosure cleanup from AttackExecution combat threshold."] };
  await mkdir("logs", { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(output, null, 2) + "\n");
  console.log(`Solo recorded opening reproduced: tick ${after.tick}, hash ${after.hash}, ${verifiedInputs} physical inputs; ${captures.length} human tile transfers`);
  console.log(`Saved ignored ${OUTPUT}`);
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.deepEqual(process.argv.slice(2), ["--reconstruct"], "Explicit --reconstruct required; no provider/Replay mode");
  await reconstructOpeningFailure();
}
