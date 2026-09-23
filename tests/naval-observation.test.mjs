import test from "node:test";
import assert from "node:assert/strict";
import {
  navalChoices,
  navalCriteria,
  navalModelState,
  validateNavalProposal,
} from "../web/naval-observation.js";
import { observation } from "./fixtures/land.mjs";

function sample(type = "nation") {
  const snapshot_id = "solo-1/map@100#1";
  const omissions = {
    coast_budget_unexamined: 0,
    pair_budget_unexamined: 0,
    geometry_shortlist_limit: 0,
    worker_unchecked: 0,
    shortlist_limit: 0,
    pending_intent: 0,
    cap_blocked: 0,
    invalid_target: 0,
    not_buildable: 0,
    invalid_worker_result: 0,
    invalid_source: 0,
    invalid_gold: 0,
    unaffordable: 0,
  };
  return {
    snapshot_id,
    source_tick: 100,
    current_tick: 100,
    map_id: "solo-1/map",
    available_troops_internal: 9624.8,
    boats: {
      cap: 3,
      active_count: 1,
      active_transports: [{ destination_tile: 73, troops_internal: 74.5 }],
    },
    candidates: [
      {
        id: `${snapshot_id}:boat1`,
        kind: "boat",
        source_region_id: `${snapshot_id}:r1`,
        target_region_id: `${snapshot_id}:nr1`,
        target_owner_id: type === "wilderness" ? 0 : 2,
        target_type: type,
        target_region_tiles: 120,
        water_component_id: `${snapshot_id}:w1`,
        water_ocean_status: "ocean",
        source_shore_tiles: 7,
        target_shore_tiles: 9,
        water_span_estimate_tiles: 19,
        water_span_method: "shore_manhattan_separation_not_water_path",
        status: "worker_checked_not_executed",
        geometry_status: "geometric_only_not_engine_legal",
        cost_gold: "0",
        worker_source_confirmed: true,
      },
    ],
    coverage: {
      total_eligible: 1,
      worker_checked: 1,
      offered_count: 1,
      omitted_count: 0,
      coast: {
        source_water_components: 1,
        eligible_target_owner_regions: 1,
        coast_budget_truncated_owner_regions: 0,
        eligible_region_component_coasts: 1,
        sampled_region_component_coasts: 1,
        eligible_coast_contacts: 9,
        sample_budget: 16,
        shore_source: "isShore_and_water_adjacency",
      },
      certainty:
        "Full-resolution geometry; worker-checked spawn; landing not guaranteed",
    },
    omissions,
  };
}

test("worker-checked naval options retain opaque identity and real-size estimates", () => {
  const p = sample();
  validateNavalProposal(p, { gameId: "solo-1", snapshotTick: 100 });
  const state = observation(962, 20000, "nation");
  const actions = navalChoices(p, state);
  assert.deepEqual(Object.keys(actions), [
    "wait",
    "boat_1_10",
    "boat_1_20",
    "boat_1_30",
    "boat_1_40",
    "boat_1_50",
  ]);
  assert.equal(actions.boat_1_10.candidate_id, p.candidates[0].id);
  assert.equal(actions.boat_1_10.fraction, 0.1);
  assert.equal(actions.boat_1_10.troops_committed_estimate, 96.2);
  assert.equal(actions.boat_1_10.troops_remaining_estimate, 865.8);
  const model = navalModelState(p);
  assert.deepEqual(model.fleet, {
    cap: 3,
    active_count: 1,
    known_active_troops_display: 7,
    unknown_active_troops_count: 0,
  });
  const criteria = navalCriteria(actions);
  assert.equal(criteria.boat_1_10.target_owner_id, 2);
  assert.ok(
    !JSON.stringify({ model, criteria }).includes('"destination_tile"'),
  );
  assert.ok(
    !JSON.stringify({ model, criteria }).includes('"target_shore_tile"'),
  );
});

test("tribe naval sends are hard capped at 20%; wait remains when no candidates", () => {
  const tribe = sample("tribe");
  assert.deepEqual(Object.keys(navalChoices(tribe, observation())), [
    "wait",
    "boat_1_10",
    "boat_1_20",
  ]);
  const none = sample();
  none.candidates = [];
  none.coverage.offered_count = 0;
  none.coverage.omitted_count = 1;
  none.omissions.not_buildable = 1;
  validateNavalProposal(none, { gameId: "solo-1", snapshotTick: 100 });
  assert.deepEqual(Object.keys(navalChoices(none, observation())), ["wait"]);
  assert.deepEqual(Object.keys(navalChoices(null, observation())), ["wait"]);
});

test("untrusted, stale, invented or inconsistent naval candidates fail closed", () => {
  const mutate = [
    (x) => {
      x.source_tick = 79;
    },
    (x) => {
      x.current_tick = 101;
    },
    (x) => {
      x.map_id = "wrong/map";
    },
    (x) => {
      x.candidates[0].target_shore_tile = 2;
    },
    (x) => {
      x.candidates[0].target_owner_id = 0;
    },
    (x) => {
      x.candidates[0].worker_source_confirmed = false;
    },
    (x) => {
      x.candidates[0].cost_gold = "01";
    },
    (x) => {
      x.candidates[0].status = "guaranteed_landing";
    },
    (x) => {
      x.candidates[0].water_span_method = "exact_path";
    },
    (x) => {
      x.boats.cap = 1;
    },
    (x) => {
      x.omissions.invented = 0;
    },
    (x) => {
      x.omissions.not_buildable = 2;
    },
    (x) => {
      x.coverage.worker_checked = 0;
    },
    (x) => {
      x.boats.active_transports[0].troops_internal = -1;
    },
  ];
  for (const change of mutate) {
    const p = sample();
    change(p);
    assert.throws(() =>
      validateNavalProposal(p, { gameId: "solo-1", snapshotTick: 100 }),
    );
  }
});
