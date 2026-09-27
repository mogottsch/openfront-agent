import test from "node:test";
import assert from "node:assert/strict";
import { observation } from "./fixtures/land.mjs";
import {
  buildNavalDecomposedRequest,
  parseNavalDecomposedDecision,
} from "../src/naval-decomposed-policy.mjs";

function input(type = "wilderness") {
  const snapshot_id = "island/onion@649#2";
  const land = observation(18891, 48813, "nation");
  land.self.territory_tiles = 6505;
  land.border = {
    total_edges: 992,
    wilderness_edges: 0,
    player_edges: 0,
    water_edges: 992,
    blocked_edges: 0,
  };
  land.neighbors = [];
  land.incoming_attacks = [];
  land.outgoing_attacks = [];
  return {
    game_id: "island",
    snapshot_tick: 649,
    land,
    building: null,
    plan: null,
    city_mechanics: {
      troop_capacity_gain_display: 25000,
      construction_ticks: 20,
    },
    naval: {
      snapshot_id,
      source_tick: 649,
      current_tick: 649,
      map_id: "island/onion",
      available_troops_internal: 188910,
      boats: { cap: 3, active_count: 0, active_transports: [] },
      candidates: [
        {
          id: `${snapshot_id}:boat1`,
          kind: "boat",
          source_region_id: `${snapshot_id}:r1`,
          target_region_id: `${snapshot_id}:nr1`,
          target_owner_id: type === "wilderness" ? 0 : 2,
          target_type: type,
          target_region_tiles: 7203,
          water_component_id: `${snapshot_id}:w1`,
          water_ocean_status: "ocean",
          source_shore_tiles: 100,
          target_shore_tiles: 100,
          water_span_estimate_tiles: 18,
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
          eligible_coast_contacts: 100,
          sample_budget: 16,
          shore_source: "isShore_and_water_adjacency",
        },
        certainty:
          "Engine worker verified spawn, route and landing not guaranteed",
      },
      omissions: {
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
      },
    },
  };
}
function answer(request, selected) {
  return {
    model: "jev-test",
    usage: { input_tokens: 123, output_tokens: 15 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => [
        key,
        {
          type: "choice",
          choice: selected[key] ?? "wait",
          confidence: 0.8,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((option) => [
              option,
              option === (selected[key] ?? "wait") ? 1 : 0,
            ]),
          ),
        },
      ]),
    ),
  };
}

test("decomposed boat questions do not erase an offered Defense Post branch", () => {
  const raw = input();
  const snapshot_id = "island/onion@649#3";
  raw.defense_post = {
    snapshot_id,
    source_tick: 649,
    current_tick: 649,
    map_id: "island/onion",
    available_gold: "100000",
    mechanics: {
      range_tiles: 30,
      construction_ticks: 50,
      coverage_model:
        "Potential Euclidean front contact, not guaranteed combat protection",
    },
    posts: {
      active_completed: 0,
      under_construction: 0,
      status_unknown: 0,
      pending_unconfirmed: 0,
    },
    incoming: {
      observed_attacker_ids: [],
      non_retreating_attacker_ids: [],
      ids_without_land_contact: [],
      contact_is_only_potential: true,
    },
    candidates: [
      {
        id: `${snapshot_id}:dp1`,
        kind: "build_defense_post",
        region_id: `${snapshot_id}:r1`,
        front_id: null,
        water_ids: [],
        distance_to_land_border: -1,
        distance_to_player_border: -1,
        marginal_owned_territory_tiles: 200,
        marginal_hostile_front_contacts: 0,
        marginal_potential_incoming_front_contacts: 0,
        potential_incoming_contact_ids: [],
        cost_gold: "50000",
        gold_after_estimate: "50000",
      },
    ],
    save_gold: { id: `${snapshot_id}:save_gold`, kind: "save_gold" },
    coverage: {
      total_eligible: 1,
      total_examined: 1,
      worker_checked: 1,
      offered_count: 1,
      omitted_count: 0,
      uncovered_hostile_front_contacts: 0,
      uncovered_potential_incoming_front_contacts: 0,
    },
    omissions: {
      not_examined: 0,
      geometry_shortlist_limit: 0,
      worker_unchecked: 0,
      shortlist_limit: 0,
      pending_intent: 0,
      occupied_post: 0,
      not_buildable: 0,
      relocated: 0,
      upgrade_not_build: 0,
      unaffordable: 0,
      unaffordable_after_check: 0,
      invalid_worker_result: 0,
      invalid_gold: 0,
    },
  };
  const req = buildNavalDecomposedRequest(raw);
  assert.ok(req.questions.branch.criteria.defense_post_build);
  assert.ok(req.questions.post_site.criteria.build_defense_post_1);
  const picks = {
    branch: "defense_post_build",
    post_site: "build_defense_post_1",
  };
  const chosen = parseNavalDecomposedDecision(answer(req, picks), req);
  assert.equal(chosen.kind, "defense_post");
  assert.equal(chosen.candidate_id, raw.defense_post.candidates[0].id);
  assert.equal(chosen.context.defense_post_snapshot_id, snapshot_id);
  picks.post_site = "save_gold";
  const skipped = parseNavalDecomposedDecision(answer(req, picks), req);
  assert.equal(skipped.kind, "wait");
  assert.equal(skipped.candidate_id, null);
});

test("one request decomposes branch, target and target-specific size without replacing Jev wait", () => {
  const raw = input();
  const req = buildNavalDecomposedRequest(raw);
  assert.deepEqual(Object.keys(req.questions), [
    "branch",
    "boat_size_1",
    "boat_target",
  ]);
  assert.deepEqual(Object.keys(req.questions.boat_target.criteria), [
    "wait",
    "boat_target_1",
  ]);
  assert.deepEqual(Object.keys(req.questions.boat_size_1.criteria), [
    "wait",
    "send_10",
    "send_20",
    "send_30",
    "send_40",
    "send_50",
  ]);
  assert.ok(!JSON.stringify(req).includes("target_shore_tile"));
  for (const [choice, kind, selected, fraction] of [
    [
      { branch: "wait", boat_target: "boat_target_1", boat_size_1: "send_10" },
      "wait",
      "wait",
      null,
    ],
    [
      { branch: "boat_attack", boat_target: "wait", boat_size_1: "send_10" },
      "wait",
      "wait",
      null,
    ],
    [
      {
        branch: "boat_attack",
        boat_target: "boat_target_1",
        boat_size_1: "wait",
      },
      "wait",
      "wait",
      null,
    ],
    [
      {
        branch: "boat_attack",
        boat_target: "boat_target_1",
        boat_size_1: "send_10",
      },
      "boat",
      "boat_1_10",
      0.1,
    ],
  ]) {
    const out = parseNavalDecomposedDecision(answer(req, choice), req);
    assert.equal(out.kind, kind);
    assert.equal(out.selected, selected);
    assert.equal(out.fraction, fraction);
    assert.equal(
      out.candidate_id,
      kind === "boat" ? raw.naval.candidates[0].id : null,
    );
    assert.equal(out.context.naval_snapshot_id, raw.naval.snapshot_id);
  }
});

test("tribe target has no >20% size and wrong/missing speculative answers fail closed", () => {
  const req = buildNavalDecomposedRequest(input("tribe"));
  assert.deepEqual(Object.keys(req.questions.boat_size_1.criteria), [
    "wait",
    "send_10",
    "send_20",
  ]);
  const chosen = {
    branch: "boat_attack",
    boat_target: "boat_target_1",
    boat_size_1: "send_20",
  };
  const accepted = parseNavalDecomposedDecision(answer(req, chosen), req);
  assert.equal(accepted.fraction, 0.2);
  const madeUp = answer(req, { ...chosen, boat_size_1: "send_50" });
  assert.throws(() => parseNavalDecomposedDecision(madeUp, req));
  const omitted = answer(req, chosen);
  delete omitted.answers.boat_size_1;
  assert.throws(() => parseNavalDecomposedDecision(omitted, req));
});

test("selected size must belong to chosen target; 16 targets stay bounded", () => {
  const raw = input();
  for (let i = 2; i <= 16; i++)
    raw.naval.candidates.push({
      ...raw.naval.candidates[0],
      id: `${raw.naval.snapshot_id}:boat${i}`,
      target_region_id: `${raw.naval.snapshot_id}:nr${i}`,
    });
  raw.naval.coverage.total_eligible = 16;
  raw.naval.coverage.worker_checked = 16;
  raw.naval.coverage.offered_count = 16;
  const req = buildNavalDecomposedRequest(raw);
  assert.equal(Object.keys(req.questions).length, 18);
  assert.equal(Object.keys(req.questions.boat_target.criteria).length, 17);
  assert.equal(Object.keys(req.questions.boat_size_16.criteria).length, 6);
  assert.ok(JSON.stringify(req).length < 150000);
  const picks = {
    branch: "boat_attack",
    boat_target: "boat_target_8",
    boat_size_8: "send_10",
  };
  const out = parseNavalDecomposedDecision(answer(req, picks), req);
  assert.equal(out.kind, "boat");
  assert.equal(out.selected, "boat_8_10");
  assert.equal(out.candidate_id, raw.naval.candidates[7].id);
  req.questions.boat_size_8.criteria.send_10.candidate_id =
    raw.naval.candidates[0].id;
  assert.throws(
    () => parseNavalDecomposedDecision(answer(req, picks), req),
    /not offered for the selected target/,
  );
});
