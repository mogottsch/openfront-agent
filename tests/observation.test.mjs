import test from "node:test";
import assert from "node:assert/strict";
import {
  actionCriteria,
  buildActions,
  modelState,
  validateObservation,
} from "../web/observation.js";
import { observation } from "./fixtures/land.mjs";

test("optional same-snapshot win facts clone and derive without changing land offers",()=>{
  const raw=observation();const original=buildActions(raw);
  assert.equal(Object.hasOwn(modelState(raw),"win_context"),false);
  raw.win_context={game_id:"solo-win-test",source_tick:100,
    rule:"ffa_largest_alive_territory_at_timer_or_strict_share",elapsed_seconds:299,
    timer_seconds:300,share_threshold_percent:80,non_fallout_land_tiles:10000,
    eligible_alive_count:3,self_rank_by_tiles:3,leading_territory_tiles:300,
    tied_leader_count:1,leader:{id:3,type:"human"}};
  const clean=validateObservation(raw),state=modelState(raw);
  assert.equal(state.win_context.effective_deadline_remaining_seconds,1);
  assert.equal(state.win_context.territory_tiles_behind_leader,248);
  assert.deepEqual(buildActions(raw),original);
  raw.win_context.leader.type="tribe";
  assert.equal(clean.win_context.leader.type,"human");
  assert.throws(()=>validateObservation(raw)); // known neighbor identity mismatch
  const mismatched=structuredClone(clean);mismatched.neighbors[0].structures={source_tick:101,
    city:{completed_count:0,constructing_count:0,completed_levels:0},
    defense_post:{completed_count:0,constructing_count:0,completed_levels:0}};
  assert.throws(()=>validateObservation(mismatched));
  const extra=structuredClone(clean);extra.win_context.effective_deadline_remaining_seconds=1;
  assert.throws(()=>validateObservation(extra)); // derived values not raw API
});

test("computes border shares, reserves, density, and incoming totals without asking Jev to divide", () => {
  const raw = observation();
  raw.incoming_attacks.push(
    {
      ...raw.incoming_attacks[0],
      id: "retreat",
      troops: 300,
      retreating: true,
    },
    {
      id: "distant",
      attacker_id: 99,
      attacker_type: "nation",
      attacker_reserve_troops: 4000,
      troops: 50,
      retreating: false,
    },
  );
  const state = modelState(raw);
  assert.equal(state.self.reserve_percent, 20.83);
  assert.equal(state.self.active_incoming_troops, 150);
  assert.equal(state.border.wilderness_share, 0.4);
  assert.equal(state.border.water_share, 0.1);
  assert.equal(state.neighbors[0].border_share, 0.25);
  assert.equal(state.neighbors[0].troops_attacking_us, 100);
  assert.equal(state.neighbors[0].troops_per_tile, 10);
  assert.equal(state.incoming_attacks.length, 3);
  assert.ok(!Object.hasOwn(raw.self, "reserve_percent"));
});

test("only offers adjacent legal targets and estimates the committed force, not the full army", () => {
  const actions = buildActions(observation());
  assert.deepEqual(Object.keys(actions), [
    "wait",
    "attack_wilderness_10",
    "attack_wilderness_20",
    "attack_wilderness_30",
    "attack_wilderness_40",
    "attack_wilderness_50",
    "attack_player_2_10",
    "attack_player_2_20",
    "attack_player_2_30",
    "attack_player_2_40",
    "attack_player_2_50",
  ]);
  for (const percentage of [10, 20, 30, 40, 50]) {
    const a = actions[`attack_player_2_${percentage}`];
    assert.equal(a.troops_committed_estimate, (2500 * percentage) / 100);
    assert.equal(
      a.troops_remaining_estimate,
      2500 - a.troops_committed_estimate,
    );
    assert.equal(
      a.committed_to_defender_ratio,
      a.troops_committed_estimate / 1000,
    );
  }
  assert.equal(actions.attack_player_2_20.troops_committed_estimate, 500);
  assert.equal(actions.attack_player_2_20.troops_remaining_estimate, 2000);
  assert.equal(actions.attack_player_2_20.committed_to_defender_ratio, 0.5);
  assert.equal(actions.attack_player_2_20.target_id, 2);
  assert.equal(actions.attack_wilderness_20.target_id, null);
  assert.equal(
    actionCriteria(actions).attack_player_2_20.percent_of_available_troops,
    20,
  );
});

test("capture-trigger buffer is derived only and never an attack-success/enclosure verdict",()=>{
  for(const [tiles,losses,one] of [[0,null,false],[1,1,true],[52,1,true],[99,1,true],
    [100,1,true],[101,2,false],[2000,1901,false]]){
    const raw=observation();raw.self.territory_tiles=tiles;
    raw.neighbors[0].territory_tiles=tiles;
    if(tiles===0)raw.neighbors[0].can_attack=false;
    const state=modelState(raw);
    for(const s of [state.self,state.neighbors[0]]){
      assert.equal(s.tile_losses_until_elimination_threshold,losses);
      assert.equal(s.one_successful_tile_loss_can_trigger_elimination,one);
      assert.equal(Object.hasOwn(s,"is_enclosed"),false);
    }
    assert.equal(Object.hasOwn(raw.self,"tile_losses_until_elimination_threshold"),false);
    assert.deepEqual(validateObservation(raw),raw);
  }
});

test("sole-player border cue describes observed contacts, not closure scheduling or safety",()=>{
  const raw=observation();raw.neighbors=[raw.neighbors[0]];
  raw.border={total_edges:5,player_edges:5,wilderness_edges:0,water_edges:0,blocked_edges:0};
  const state=modelState(raw);
  assert.equal(state.border.all_edges_touch_one_unallied_player,true);
  assert.equal(state.border.only_border_player_id,2);
  assert.equal(Object.hasOwn(state.border,"is_enclosed"),false);
  assert.equal(Object.hasOwn(state.border,"cleanup_scheduled"),false);
  for(const kind of ["wilderness_edges","water_edges","blocked_edges"]){
    const changed=structuredClone(raw);changed.border[kind]=1;changed.border.total_edges++;
    assert.equal(modelState(changed).border.all_edges_touch_one_unallied_player,false);
    assert.equal(modelState(changed).border.only_border_player_id,null);
  }
  raw.neighbors[0].relationship="ally";raw.neighbors[0].can_attack=false;
  assert.equal(modelState(raw).border.all_edges_touch_one_unallied_player,false);
  assert.equal(modelState(observation()).border.only_border_player_id,null);
  const empty=observation();empty.neighbors=[];empty.border={total_edges:0,
    player_edges:0,wilderness_edges:0,water_edges:0,blocked_edges:0};
  assert.equal(modelState(empty).border.only_border_player_id,null);
});

test("optional neighbor structures are cloned strict same-tick facts, not a menu gate",()=>{
  const raw=observation();
  const zero={completed_count:0,constructing_count:0,completed_levels:0};
  raw.neighbors[0].structures={source_tick:100,city:{completed_count:1,
    constructing_count:1,completed_levels:2},defense_post:{...zero}};
  const clean=validateObservation(raw);
  assert.deepEqual(modelState(raw).neighbors[0].structures,raw.neighbors[0].structures);
  assert.deepEqual(buildActions(raw),buildActions(observation()));
  raw.neighbors[0].structures.city.completed_count=3;
  assert.equal(clean.neighbors[0].structures.city.completed_count,1);
  assert.equal(Object.hasOwn(modelState(observation()).neighbors[0],"structures"),false);
  for(const mutate of [s=>{s.city.extra=true;},s=>{s.city.completed_levels=-1;},
    s=>{s.city.completed_count=1;},s=>{s.defense_post.constructing_count=0.5;},
    s=>{s.source_tick=-1;},s=>{s.frontier_protected=true;}]){
    const bad=observation();bad.neighbors[0].structures={source_tick:100,
      city:{...zero},defense_post:{...zero}};mutate(bad.neighbors[0].structures);
    assert.throws(()=>validateObservation(bad));
  }
  const mixed=observation();mixed.neighbors[1].type="nation";
  for(const n of mixed.neighbors)n.structures={source_tick:n.id===2?100:101,
    city:{...zero},defense_post:{...zero}};
  assert.throws(()=>validateObservation(mixed),/Invalid land observation/);
});

test("a player attack remains available without wilderness; immunity disables that target", () => {
  const raw = observation();
  raw.border.wilderness_edges = 0;
  raw.border.total_edges -= 8;
  assert.deepEqual(Object.keys(buildActions(raw)), [
    "wait",
    "attack_player_2_10",
    "attack_player_2_20",
    "attack_player_2_30",
    "attack_player_2_40",
    "attack_player_2_50",
  ]);
  raw.neighbors[0].can_attack = false;
  assert.deepEqual(Object.keys(buildActions(raw)), ["wait"]);
});

test("zero troops only offers wait; zero defenders produces an explicit null ratio", () => {
  assert.deepEqual(Object.keys(buildActions(observation(0))), ["wait"]);
  const raw = observation();
  raw.neighbors[0].troops = 0;
  raw.incoming_attacks[0].attacker_reserve_troops = 0;
  assert.equal(
    buildActions(raw).attack_player_2_10.committed_to_defender_ratio,
    null,
  );
  assert.doesNotThrow(() => validateObservation(observation(13000, 12000)));
});

test("rejects missing/extra state, inconsistent borders, duplicate IDs, and friendly attack permissions", () => {
  const mutations = [
    (o) => {
      o.self.troops = -1;
    },
    (o) => {
      o.self.troop_capacity = 0;
    },
    (o) => {
      o.self.troops = NaN;
    },
    (o) => {
      o.self.territory_tiles = 1.5;
    },
    (o) => {
      o.border.total_edges++;
    },
    (o) => {
      o.neighbors[0].shared_border_edges++;
    },
    (o) => {
      o.neighbors[1].id = 2;
    },
    (o) => {
      o.neighbors[1].can_attack = true;
    },
    (o) => {
      o.neighbors[0].id = 1;
    },
    (o) => {
      o.neighbors[0].can_attack = "true";
    },
    (o) => {
      o.neighbors[0].type = "anything";
    },
    (o) => {
      o.incoming_attacks[0].troops = Infinity;
    },
    (o) => {
      o.self.troop_capacity = Number.MIN_VALUE;
    },
    (o) => {
      o.neighbors[0].troops = 0.5;
    },
    (o) => {
      o.incoming_attacks[0].troops = 0.5;
    },
    (o) => {
      o.incoming_attacks.push({ ...o.incoming_attacks[0] });
    },
    (o) => {
      o.secret = "extra";
    },
    (o) => {
      o.self.reserve_percent = 30;
    },
  ];
  for (const mutate of mutations) {
    const o = observation();
    mutate(o);
    assert.throws(() => validateObservation(o));
  }
  for (const o of [null, [], {}, { troops: 1, troop_capacity: 2 }])
    assert.throws(() => validateObservation(o));
});

test("bounds actual action count without silently dropping neighbors", () => {
  const o = observation();
  const neighbor = { ...o.neighbors[0], shared_border_edges: 1 };
  o.neighbors = Array.from({ length: 49 }, (_, i) => ({
    ...neighbor,
    id: i + 2,
  }));
  o.border.player_edges = 49;
  o.border.total_edges = 61;
  assert.equal(Object.keys(buildActions(o)).length, 251);
  o.neighbors.push({ ...neighbor, id: 51 });
  o.border.player_edges++;
  o.border.total_edges++;
  assert.doesNotThrow(() => validateObservation(o));
  assert.throws(() => buildActions(o), /Too many legal land actions/);
  o.border.total_edges -= o.border.wilderness_edges;
  o.border.wilderness_edges = 0;
  assert.equal(Object.keys(buildActions(o)).length, 251);
  // The observation limit is independent: non-attackable neighbors still fit.
  o.neighbors = Array.from({ length: 126 }, (_, i) => ({
    ...neighbor,
    id: i + 2,
    can_attack: false,
  }));
  o.border.player_edges = 126;
  o.border.total_edges = 130;
  assert.deepEqual(Object.keys(buildActions(o)), ["wait"]);
  o.neighbors.push({ ...neighbor, id: 128 });
  assert.throws(() => validateObservation(o));
});
