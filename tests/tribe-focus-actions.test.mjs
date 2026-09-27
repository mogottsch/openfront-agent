import test from "node:test";
import assert from "node:assert/strict";
import { observation } from "./fixtures/land.mjs";
import {
  buildActions,
  landStrategy,
  modelState,
  validateObservation,
} from "../web/observation.js";
import { navalChoices } from "../web/naval-observation.js";

function withTribes() {
  const o = observation(20000, 60000, "tribe");
  o.incoming_attacks[0].attacker_type = "tribe";
  const nation = structuredClone(o.neighbors[0]);
  Object.assign(nation, {
    id: 7,
    type: "nation",
    troops: 28000,
    territory_tiles: 10000,
    shared_border_edges: 3,
    incoming_attacks: [],
  });
  o.neighbors.push(nation);
  o.border.player_edges += 3;
  o.border.total_edges += 3;
  return o;
}
const active = (id, troops = 1000, retreating = false) => ({
  id: `own${id}`,
  target_id: id,
  troops,
  retreating,
});
const focus = (id = 2, adjacent = true) => ({
  id,
  alive: true,
  type: "tribe",
  troops: 1700,
  territory_tiles: 500,
  adjacent,
  can_attack: adjacent,
});

test("Moritz-authored priority gate: finish our active tribe before opening another land front", () => {
  const o = withTribes();
  o.outgoing_attacks = [active(2, 1985)];
  const actions = buildActions(o);
  assert.deepEqual(Object.keys(actions), [
    "wait",
    "attack_player_2_10",
    "attack_player_2_20",
  ]);
  const policy = landStrategy(o);
  assert.equal(policy.mode, "finish_current_tribe_attacks");
  assert.deepEqual(policy.active_tribe_target_ids, [2]);
  assert.deepEqual(policy.bordering_tribe_ids, [2]);
  assert.deepEqual(
    policy.blocked_targets.map((x) => [x.target_id, x.reason]),
    [
      [null, "finish_current_tribe_attacks_before_wilderness"],
      [7, "finish_current_tribe_attacks_before_new_target"],
    ],
  );
  assert.deepEqual(
    modelState(o).strategy.blocked_targets,
    policy.blocked_targets,
  );
  // Reverse attacks and zero-strength tails do not count as funded conquests.
  o.outgoing_attacks = [active(2, 0), active(7, 200, true)];
  assert.ok(buildActions(o).attack_wilderness_10);
  assert.ok(buildActions(o).attack_player_2_10);
  assert.equal(buildActions(o).attack_player_7_10, undefined);
});

test("authoritative still-alive focus stays locked after the outgoing stack disappears", () => {
  const o = withTribes();
  o.outgoing_attacks = [];
  o.tribe_focus = focus();
  assert.deepEqual(Object.keys(buildActions(o)), [
    "wait",
    "attack_player_2_10",
    "attack_player_2_20",
  ]);
  assert.equal(modelState(o).strategy.focus_tribe_id, 2);
  assert.equal(modelState(o).tribe_focus.alive, true);
  assert.equal(modelState(o).tribe_focus.our_active_attack_troops, 0);
  assert.equal(
    modelState(o).tribe_focus.our_reserve_to_defender_reserve_ratio,
    11.7647,
  );
  o.tribe_focus.territory_tiles = 0;
  o.tribe_focus.can_attack = false;
  o.tribe_focus.adjacent = false;
  o.neighbors = o.neighbors.filter((n) => n.id !== 2);
  o.border.player_edges -= 5;
  o.border.total_edges -= 5;
  o.incoming_attacks = [];
  assert.equal(validateObservation(o).tribe_focus.territory_tiles, 0);
  assert.ok(buildActions(o).attack_wilderness_10);
  assert.equal(buildActions(o).attack_player_7_10, undefined);
});

test("focused tribe may be temporarily unattackable without unlocking new targets", () => {
  const o = withTribes();
  o.tribe_focus = { ...focus(), can_attack: false };
  assert.deepEqual(Object.keys(buildActions(o)), ["wait"]);
  assert.ok(
    modelState(o).strategy.blocked_targets.some(
      (x) =>
        x.target_id === 2 &&
        x.reason === "focused_tribe_not_currently_attackable",
    ),
  );
});

test("lost border does not silently declare the focused tribe dead or allow nation attack", () => {
  const o = withTribes();
  o.neighbors = o.neighbors.filter((n) => n.id !== 2);
  o.border.player_edges -= 5;
  o.border.total_edges -= 5;
  o.incoming_attacks = [];
  o.tribe_focus = focus(2, false);
  assert.deepEqual(Object.keys(buildActions(o)), [
    "wait",
    "attack_wilderness_10",
    "attack_wilderness_20",
    "attack_wilderness_30",
    "attack_wilderness_40",
    "attack_wilderness_50",
  ]);
  assert.equal(modelState(o).strategy.mode, "finish_focused_tribe");
  assert.equal(modelState(o).strategy.focus_tribe_id, 2);
  assert.ok(
    modelState(o).strategy.blocked_targets.some((x) => x.target_id === 7),
  );
});

test("all bordering tribes precede nation attacks; only nations are suppressed in this phase", () => {
  const o = withTribes();
  const human = {
    ...structuredClone(o.neighbors[0]),
    id: 9,
    type: "human",
    shared_border_edges: 1,
    incoming_attacks: [],
  };
  o.neighbors.push(human);
  o.border.player_edges += 1;
  o.border.total_edges += 1;
  const actions = buildActions(o);
  assert.ok(actions.attack_wilderness_10);
  assert.ok(actions.attack_player_2_10);
  assert.equal(actions.attack_player_7_50, undefined);
  assert.ok(actions.attack_player_9_10); // user mentioned nations, not other humans
  assert.equal(landStrategy(o).mode, "bordering_tribes_before_nations");
  assert.ok(
    landStrategy(o).blocked_targets.some(
      (x) =>
        x.target_id === 7 &&
        x.reason === "conquer_bordering_tribes_before_nations",
    ),
  );
  o.neighbors = o.neighbors.filter((n) => n.id !== 2);
  o.border.player_edges -= 5;
  o.border.total_edges -= 5;
  o.incoming_attacks = [];
  assert.ok(buildActions(o).attack_player_7_10);
});

test("optional decimal gold is exact and cannot be forged with invalid shapes", () => {
  const o = observation();
  o.self.gold = "0";
  assert.equal(modelState(o).self.gold, "0");
  o.self.gold = "9007199254740995";
  assert.equal(validateObservation(o).self.gold, o.self.gold);
  for (const invalid of ["01", "-1", "1.2", "", 3, NaN]) {
    o.self.gold = invalid;
    assert.throws(() => validateObservation(o));
  }
  o.self.gold = "1";
  o.tribe_focus = { ...focus(), foo: "untrusted" };
  assert.throws(() => validateObservation(o));
  o.tribe_focus = focus(2, false);
  assert.throws(() => validateObservation(o)); // neighbor2 still borders us
});

test("focus history is bounded, source-labelled and its progress arithmetic belongs to code", () => {
  const o = withTribes();
  o.tribe_focus = {
    ...focus(),
    progress: {
      reference_kind: "first_emitted_land_intent",
      reference_tick: 100,
      reference_tiles: 900,
      elapsed_ticks: 30,
      land_intents_emitted: 2,
      last_land_send_percent: 10,
    },
  };
  const p = modelState(o).tribe_focus.progress;
  assert.equal(p.territory_delta_since_reference, -400);
  assert.equal(p.elapsed_seconds, 3);
  for (const mutation of [
    (x) => {
      x.reference_kind = "fabricated";
    },
    (x) => {
      x.reference_tiles = -1;
    },
    (x) => {
      x.elapsed_ticks = -1;
    },
    (x) => {
      x.last_land_send_percent = 50;
    },
    (x) => {
      x.land_intents_emitted = null;
    },
    (x) => {
      x.extra = "not observed";
    },
  ]) {
    const changed = structuredClone(o);
    mutation(changed.tribe_focus.progress);
    assert.throws(() => validateObservation(changed));
  }
});

test("naval branch cannot sneak new coasts around an unfinished tribe", () => {
  const o = withTribes();
  o.outgoing_attacks = [active(2, 1500)];
  const candidates = [
    { id: "boat1", target_type: "wilderness", target_owner_id: 0 },
    { id: "boat2", target_type: "tribe", target_owner_id: 2 },
    { id: "boat3", target_type: "nation", target_owner_id: 7 },
  ];
  const proposal = { available_troops_internal: 200000, candidates };
  assert.deepEqual(Object.keys(navalChoices(proposal, o)), [
    "wait",
    "boat_2_10",
    "boat_2_20",
  ]);
  o.outgoing_attacks = [];
  assert.equal(navalChoices(proposal, o).boat_3_10, undefined); // tribes still border
  o.tribe_focus = focus();
  assert.deepEqual(Object.keys(navalChoices(proposal, o)), [
    "wait",
    "boat_2_10",
    "boat_2_20",
  ]);
});
