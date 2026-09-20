import test from "node:test";
import assert from "node:assert/strict";
import {
  actionCriteria,
  buildActions,
  modelState,
  validateObservation,
} from "../web/observation.js";
import { observation } from "./fixtures/land.mjs";

test("computes border shares, reserves, density, and incoming totals without asking Jev to divide", () => {
  const raw = observation();
  raw.incoming_attacks.push(
    { id: "retreat", attacker_id: 2, troops: 300, retreating: true },
    { id: "distant", attacker_id: 99, troops: 50, retreating: false },
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
    "attack_player_2_10",
    "attack_player_2_20",
  ]);
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

test("a player attack remains available without wilderness; immunity disables that target", () => {
  const raw = observation();
  raw.border.wilderness_edges = 0;
  raw.border.total_edges -= 8;
  assert.deepEqual(Object.keys(buildActions(raw)), [
    "wait",
    "attack_player_2_10",
    "attack_player_2_20",
  ]);
  raw.neighbors[0].can_attack = false;
  assert.deepEqual(Object.keys(buildActions(raw)), ["wait"]);
});

test("zero troops only offers wait; zero defenders produces an explicit null ratio", () => {
  assert.deepEqual(Object.keys(buildActions(observation(0))), ["wait"]);
  const raw = observation();
  raw.neighbors[0].troops = 0;
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

test("bounds the candidate count to the TypeSafe limit without silently dropping neighbors", () => {
  const o = observation();
  o.neighbors = Array.from({ length: 126 }, (_, i) => ({
    ...o.neighbors[0],
    id: i + 2,
    shared_border_edges: 1,
  }));
  o.border.player_edges = 126;
  o.border.total_edges = 138;
  assert.equal(Object.keys(buildActions(o)).length, 255);
  o.neighbors.push({ ...o.neighbors[0], id: 128 });
  assert.throws(() => validateObservation(o));
});
