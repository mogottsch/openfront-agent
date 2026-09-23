import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActions,
  modelState,
  validateObservation,
} from "../web/observation.js";
import { observation } from "./fixtures/land.mjs";

const incoming = (
  id,
  attacker_id,
  attacker_type,
  attacker_reserve_troops,
  troops,
  retreating = false,
) => ({
  id,
  attacker_id,
  attacker_type,
  attacker_reserve_troops,
  troops,
  retreating,
});

test("incoming force counts: 20k versus 12k reserve + 15k incoming is weaker", () => {
  const o = observation(20000, 60000, "human");
  Object.assign(o.neighbors[0], { troops: 12000, troop_capacity: 30000 });
  o.incoming_attacks = [
    incoming("a1", 2, "human", 12000, 5000),
    incoming("a2", 2, "human", 12000, 10000),
    incoming("retreat", 2, "human", 12000, 7000, true),
  ];
  o.outgoing_attacks = [
    { id: "ours", target_id: null, troops: 50000, retreating: false },
  ];
  let state = modelState(o);
  assert.equal(state.attackers.length, 1);
  assert.equal(state.attackers[0].total_force, 27000); // reserve counted once
  assert.equal(state.attackers[0].attacking_troops, 15000);
  assert.equal(state.attackers[0].our_reserve_is_stronger, false);
  assert.equal(state.attackers[0].our_reserve_to_total_force_ratio, 0.7407);
  assert.equal(state.self.committed_outgoing_troops, 50000); // not home defense
  o.self.troops = 27000;
  assert.equal(modelState(o).attackers[0].our_reserve_is_stronger, false);
  o.self.troops = 28000;
  assert.equal(modelState(o).attackers[0].our_reserve_is_stronger, true);
});

test("the strength of a non-neighbor attacker is still represented", () => {
  const o = observation(20000, 60000);
  o.incoming_attacks = [incoming("remote", 99, "nation", 18000, 5000)];
  const s = modelState(o);
  assert.equal(s.attackers[0].total_force, 23000);
  assert.equal(s.attackers[0].our_reserve_is_stronger, false);
});

for (const [label, attack, expected] of [
  ["other human", incoming("a", 3, "human", 3000, 500), true],
  ["other nation", incoming("a", 99, "nation", 4000, 500), true],
  ["other tribe", incoming("a", 99, "tribe", 4000, 500), false],
  ["ourselves", incoming("a", 1, "human", 2500, 500), false],
  ["retreating human", incoming("a", 3, "human", 3000, 500, true), false],
  ["zero force", incoming("a", 3, "human", 3000, 0), false],
])
  test(`gold-steal fact: ${label}`, () => {
    const o = observation(2500, 12000, "tribe");
    o.neighbors[0].incoming_attacks = [attack];
    assert.equal(
      modelState(o).neighbors[0].attacked_by_other_humans_or_nations,
      expected,
    );
  });

test("outgoing commitments are exposed and mapped to the correct target", () => {
  const o = observation();
  o.outgoing_attacks = [
    { id: "land", target_id: 2, troops: 500, retreating: false },
    { id: "return", target_id: 2, troops: 200, retreating: true },
    { id: "wild", target_id: null, troops: 300, retreating: false },
  ];
  const s = modelState(o);
  assert.equal(s.self.committed_outgoing_troops, 1000);
  assert.equal(s.self.wilderness_attack_active, true);
  assert.equal(s.self.active_wilderness_attack_troops, 300);
  assert.equal(s.neighbors[0].our_active_attack_troops, 500);
  assert.deepEqual(s.outgoing_attacks, o.outgoing_attacks);
});

test("wilderness commitments describe the actual post-send reserve", () => {
  const o = observation(565, 25646);
  o.outgoing_attacks = [
    { id: "expansion", target_id: null, troops: 1200, retreating: false },
  ];
  const actions = buildActions(o);
  assert.equal(actions.wait.reserve_percent_after_estimate, 2.2);
  assert.equal(actions.attack_wilderness_30.troops_remaining_estimate, 395.5);
  assert.equal(
    actions.attack_wilderness_30.reserve_percent_after_estimate,
    1.54,
  );
  assert.equal(modelState(o).self.wilderness_attack_active, true);
  o.outgoing_attacks[0].retreating = true;
  assert.equal(modelState(o).self.wilderness_attack_active, false);
});

test("tribes have a hard 20% ceiling; other targets retain 10 through 50", () => {
  for (const type of ["tribe", "nation", "human"]) {
    const actions = buildActions(observation(2500, 12000, type));
    const amounts = Object.keys(actions)
      .filter((k) => k.startsWith("attack_player_2_"))
      .map((k) => Number(k.split("_").at(-1)));
    assert.deepEqual(
      amounts,
      type === "tribe" ? [10, 20] : [10, 20, 30, 40, 50],
    );
    assert.equal(actions.attack_player_2_20.target_type, type);
    assert.ok(actions.attack_wilderness_50);
  }
});

test("inconsistent or missing attacker metadata is rejected rather than guessed", () => {
  const mutations = [
    (o) => {
      delete o.incoming_attacks[0].attacker_reserve_troops;
    },
    (o) => {
      o.incoming_attacks[0].attacker_reserve_troops = -1;
    },
    (o) => {
      o.incoming_attacks[0].attacker_type = "unknown";
    },
    (o) => {
      o.incoming_attacks.push({
        ...o.incoming_attacks[0],
        id: "different",
        attacker_reserve_troops: 999,
      });
    },
    (o) => {
      o.incoming_attacks[0].attacker_reserve_troops = 999;
    },
    (o) => {
      o.outgoing_attacks = [
        { id: "selfAttack", target_id: 1, troops: 5, retreating: false },
      ];
    },
    (o) => {
      o.neighbors[0].incoming_attacks = Array.from({ length: 256 }, (_, i) =>
        incoming(`a${i}`, 99, "human", 5000, 10),
      );
    },
  ];
  for (const mutate of mutations) {
    const o = observation();
    mutate(o);
    assert.throws(() => validateObservation(o));
  }
});
