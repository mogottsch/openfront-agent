import test from "node:test";
import assert from "node:assert/strict";
import { observation } from "./fixtures/land.mjs";
import {
  buildHybridRequest,
  parseHybridDecision,
} from "../src/hybrid-policy.mjs";
import {
  hybridChoices,
  validateHybridInput,
} from "../web/hybrid-observation.js";

const base = () => ({
  game_id: "solo-1",
  snapshot_tick: 110,
  land: observation(8000, 20000, "tribe"),
  city_mechanics: {
    troop_capacity_gain_display: 25000,
    construction_ticks: 20,
  },
  plan: {
    game_id: "solo-1",
    plan_version: 3,
    source_tick: 100,
    expires_tick: 400,
    objective: "Expand safely and invest gold in a defensible city if useful.",
  },
  building: {
    snapshot_id: "solo-1/map@100#2",
    source_tick: 100,
    current_tick: 105,
    map_id: "solo-1/map",
    available_gold: "1000",
    city_counts: { owned: 2, pending: 0 },
    candidates: [
      {
        id: "solo-1/map@100#2:c1",
        kind: "build_city",
        region_id: "solo-1/map@100#2:r1",
        front_id: "solo-1/map@100#2:f1",
        water_ids: [],
        distance_to_land_border: 6,
        distance_to_player_border: 12,
        marginal_coverage_tiles: 90,
        cost_gold: "300",
        gold_after_estimate: "700",
      },
      {
        id: "solo-1/map@100#2:c2",
        kind: "build_city",
        region_id: "solo-1/map@100#2:r1",
        front_id: null,
        water_ids: ["solo-1/map@100#2:w3"],
        distance_to_land_border: -1,
        distance_to_player_border: 3,
        marginal_coverage_tiles: 120,
        cost_gold: "450",
        gold_after_estimate: "550",
      },
    ],
    save_gold: { id: "solo-1/map@100#2:save_gold", kind: "save_gold" },
    coverage: {
      total_eligible: 100,
      total_examined: 30,
      worker_checked: 20,
      offered_count: 2,
      omitted_count: 98,
      model: "Euclidean tile disc over owned land; geometric only",
    },
    omissions: {
      not_examined: 70,
      prefilter_limit: 10,
      worker_unchecked: 10,
      pending_intent: 0,
      occupied_city: 0,
      not_buildable: 4,
      relocated: 1,
      upgrade_not_city_build: 0,
      unaffordable: 2,
      unaffordable_after_check: 0,
      invalid_worker_result: 0,
      invalid_gold: 0,
      shortlist_limit: 1,
    },
  },
});
function withBoat(type = "wilderness") {
  const o = base(),
    snapshot_id = "solo-1/map@109#9";
  o.naval = {
    snapshot_id,
    source_tick: 109,
    current_tick: 109,
    map_id: "solo-1/map",
    available_troops_internal: 80000,
    boats: { cap: 3, active_count: 0, active_transports: [] },
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
      certainty: "Geometry + worker spawn verified; landing not guaranteed",
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
  };
  return o;
}

function withDefensePost() {
  const o = withBoat();
  const snapshot_id = "solo-1/map@109#10";
  o.defense_post = {
    snapshot_id, source_tick: 109, current_tick: 109,
    map_id: "solo-1/map", available_gold: "1000",
    mechanics: { range_tiles: 30, construction_ticks: 50,
      coverage_model: "Euclidean radius; geometric front potential only" },
    posts: { active_completed: 1, under_construction: 1,
      status_unknown: 0, pending_unconfirmed: 0 },
    incoming: { observed_attacker_ids: [2],
      non_retreating_attacker_ids: [2], ids_without_land_contact: [],
      contact_is_only_potential: true },
    candidates: [{ id: `${snapshot_id}:dp1`, kind: "build_defense_post",
      region_id: `${snapshot_id}:r1`, front_id: `${snapshot_id}:f1`,
      water_ids: [], distance_to_land_border: 1,
      distance_to_player_border: 1,
      marginal_owned_territory_tiles: 42,
      marginal_hostile_front_contacts: 3,
      marginal_potential_incoming_front_contacts: 2,
      potential_incoming_contact_ids: [2], cost_gold: "300",
      gold_after_estimate: "700" }],
    save_gold: { id: `${snapshot_id}:save_gold`, kind: "save_gold" },
    coverage: { total_eligible: 1, total_examined: 1,
      worker_checked: 1, offered_count: 1, omitted_count: 0,
      uncovered_hostile_front_contacts: 3,
      uncovered_potential_incoming_front_contacts: 2 },
    omissions: Object.fromEntries([
      "not_examined", "geometry_shortlist_limit", "worker_unchecked",
      "shortlist_limit", "pending_intent", "occupied_post", "not_buildable",
      "relocated", "upgrade_not_build", "unaffordable",
      "unaffordable_after_check", "invalid_worker_result", "invalid_gold",
    ].map((name) => [name, 0])),
  };
  return o;
}

function answer(request, choices) {
  return {
    model: "jev-test",
    usage: { input_tokens: 200, output_tokens: 40 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([name, q]) => [
        name,
        {
          type: "choice",
          choice: choices[name],
          confidence: 0.75,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((k) => [
              k,
              k === choices[name] ? 1 : 0,
            ]),
          ),
        },
      ]),
    ),
  };
}

test("boat action is a separate bounded Choice in the same request; Jev branch decides whether it executes", () => {
  const input = withBoat();
  const req = buildHybridRequest(input);
  assert.deepEqual(Object.keys(req.questions), [
    "branch",
    "land_action",
    "city_site",
    "boat_action",
  ]);
  assert.deepEqual(Object.keys(req.questions.boat_action.criteria), [
    "wait",
    "boat_1_10",
    "boat_1_20",
    "boat_1_30",
    "boat_1_40",
    "boat_1_50",
  ]);
  assert.ok(req.questions.branch.criteria.boat_attack);
  assert.equal(req.state.naval.offered_destinations, 1);
  assert.ok(!JSON.stringify(req).includes("destination_tile"));
  assert.ok(!JSON.stringify(req).includes("target_shore_tile"));
  const choice = {
    branch: "boat_attack",
    land_action: "wait",
    city_site: "save_gold",
    boat_action: "boat_1_20",
  };
  const result = parseHybridDecision(answer(req, choice), req);
  assert.equal(result.kind, "boat");
  assert.equal(result.selected, "boat_1_20");
  assert.equal(result.candidate_id, input.naval.candidates[0].id);
  assert.equal(result.fraction, 0.2);
  assert.equal(result.context.naval_snapshot_id, input.naval.snapshot_id);
  choice.branch = "city_build";
  assert.equal(parseHybridDecision(answer(req, choice), req).kind, "wait"); // save_gold, no hidden boat send
  const tribe = buildHybridRequest(withBoat("tribe"));
  assert.deepEqual(Object.keys(tribe.questions.boat_action.criteria), [
    "wait",
    "boat_1_10",
    "boat_1_20",
  ]);
});

test("own current gold remains visible when no City scan is available",()=>{
  const input=base();input.building=null;
  input.land.self.gold="47300";
  const request=buildHybridRequest(input);
  assert.equal(request.state.self.gold,"47300");
  assert.equal(request.state.economy.available_gold,"47300");
  assert.equal(request.state.economy.building_snapshot_id,null);
  assert.equal(request.questions.city_site,undefined);
});

test("branch and independent land/site choices share one bounded Jev request", () => {
  const input = base();
  const request = buildHybridRequest(input);
  assert.deepEqual(Object.keys(request.questions), [
    "branch",
    "land_action",
    "city_site",
  ]);
  assert.deepEqual(Object.keys(request.questions.branch.criteria), [
    "wait",
    "land_attack",
    "city_build",
  ]);
  assert.deepEqual(
    Object.keys(request.questions.land_action.criteria).filter((k) =>
      k.startsWith("attack_player_2_"),
    ),
    ["attack_player_2_10", "attack_player_2_20"],
  );
  assert.deepEqual(Object.keys(request.questions.city_site.criteria), [
    "save_gold",
    "build_city_1",
    "build_city_2",
  ]);
  assert.equal(
    request.questions.city_site.criteria.build_city_1.candidate_id,
    input.building.candidates[0].id,
  );
  assert.equal(
    request.questions.city_site.criteria.build_city_1.gold_spend_percent,
    30,
  );
  assert.equal(request.state.economy.available_gold, "1000");
  assert.deepEqual(request.state.economy.cities, { owned: 2, pending: 0 });
  assert.equal(request.state.economy.city_sites_checked, 20);
  assert.equal(request.state.economy.city_sites_offered, 2);
  assert.equal(request.state.economy.city_sites_omitted, 98);
  assert.equal(
    request.state.economy.building_snapshot_id,
    input.building.snapshot_id,
  );
  assert.equal(request.state.economy.offered_city_sites.length, 2);
  assert.equal(request.state.objective.text, input.plan.objective);
  assert.equal(
    request.questions.city_site.criteria.build_city_1
      .troop_capacity_gain_display,
    25000,
  );
  assert.equal(
    request.questions.city_site.criteria.build_city_1.capacity_after_estimate,
    45000,
  );
  assert.ok(!JSON.stringify(request).includes('"tile":'));
});

test("branch determines which speculative answer to execute; no heuristic replacement", () => {
  const request = buildHybridRequest(base());
  for (const [branch, land_action, city_site, kind, selected] of [
    ["wait", "attack_player_2_10", "build_city_1", "wait", "wait"],
    [
      "land_attack",
      "attack_player_2_10",
      "build_city_2",
      "land",
      "attack_player_2_10",
    ],
    [
      "city_build",
      "attack_wilderness_10",
      "build_city_2",
      "city",
      "build_city_2",
    ],
    ["land_attack", "wait", "build_city_1", "wait", "wait"],
    ["city_build", "attack_wilderness_10", "save_gold", "wait", "save_gold"],
  ]) {
    const parsed = parseHybridDecision(
      answer(request, { branch, land_action, city_site }),
      request,
    );
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.selected, selected);
    assert.equal(parsed.branch, branch);
    assert.equal(parsed.decisions.land_action.action, land_action);
    assert.equal(parsed.decisions.city_site.action, city_site);
    assert.equal(parsed.context.game_id, "solo-1");
    assert.equal(parsed.context.snapshot_tick, 110);
    assert.equal(parsed.context.building_snapshot_id, "solo-1/map@100#2");
    assert.equal(parsed.context.plan_version, 3);
    assert.equal(
      parsed.candidate_id,
      kind === "city"
        ? request.questions.city_site.criteria[city_site].candidate_id
        : null,
    );
  }
});

test("missing or invented model choices are rejected, even on unused branches", () => {
  const request = buildHybridRequest(base());
  const choices = {
    branch: "wait",
    land_action: "wait",
    city_site: "save_gold",
  };
  const good = answer(request, choices);
  delete good.answers.city_site;
  assert.throws(() => parseHybridDecision(good, request));
  const invalid = answer(request, choices);
  invalid.answers.city_site.choice = "build_city_999";
  assert.throws(() => parseHybridDecision(invalid, request));
  const probabilities = answer(request, choices);
  probabilities.answers.branch.probabilities.city_build = -1;
  assert.throws(() => parseHybridDecision(probabilities, request));
});

test("no unoffered action branch: site and land-only cases", () => {
  const noCity = base();
  noCity.building.candidates = [];
  noCity.building.coverage.offered_count = 0;
  noCity.building.coverage.omitted_count = 100;
  noCity.building.omissions.not_buildable += 2;
  assert.deepEqual(Object.keys(buildHybridRequest(noCity).questions), [
    "branch",
    "land_action",
  ]);
  assert.deepEqual(Object.keys(hybridChoices(noCity).branch), [
    "wait",
    "land_attack",
  ]);
  const noLand = base();
  noLand.land.border.player_edges = 0;
  noLand.land.border.wilderness_edges = 0;
  noLand.land.border.water_edges += 16;
  noLand.land.neighbors = [];
  assert.deepEqual(Object.keys(buildHybridRequest(noLand).questions), [
    "branch",
    "city_site",
  ]);
});

test("Defense Post adds an independent bounded site Choice with exact snapshot context and no forced build", () => {
  const input = withDefensePost();
  const req = buildHybridRequest(input);
  assert.deepEqual(Object.keys(req.questions), [
    "branch", "land_action", "city_site", "boat_action", "post_site",
  ]);
  assert.deepEqual(Object.keys(req.questions.post_site.criteria), [
    "save_gold", "build_defense_post_1",
  ]);
  assert.ok(req.questions.branch.criteria.defense_post_build);
  assert.equal(req.state.defense_posts.posts.active_completed, 1);
  assert.equal(req.state.defense_posts.posts.under_construction, 1);
  assert.equal(req.state.defense_posts.offered_post_sites[0].marginal_potential_incoming_front_contacts, 2);
  assert.match(req.questions.post_site.instructions.join(" "), /NOT total casualties or guaranteed survival/);
  assert.ok(!JSON.stringify(req).includes('"tile":'));
  assert.ok(!JSON.stringify(req).includes('"attackerID"'));
  const picks = { branch: "defense_post_build", land_action: "wait",
    city_site: "save_gold", boat_action: "wait", post_site: "build_defense_post_1" };
  const choice = parseHybridDecision(answer(req, picks), req);
  assert.equal(choice.kind, "defense_post");
  assert.equal(choice.selected, "build_defense_post_1");
  assert.equal(choice.candidate_id, input.defense_post.candidates[0].id);
  assert.equal(choice.context.defense_post_snapshot_id, input.defense_post.snapshot_id);
  assert.equal(choice.context.plan_version, 3);
  assert.equal(choice.decisions.post_site.action, "build_defense_post_1");
  assert.equal(parseHybridDecision(answer(req, { ...picks, branch: "wait" }), req).kind, "wait");
  assert.equal(parseHybridDecision(answer(req, { ...picks, post_site: "save_gold" }), req).kind, "wait");
  assert.equal(parseHybridDecision(answer(req, { ...picks, branch: "boat_attack" }), req).kind, "wait");
  const missing = answer(req, picks);
  delete missing.answers.post_site;
  assert.throws(() => parseHybridDecision(missing, req));
  const invented = answer(req, { ...picks, post_site: "build_defense_post_99" });
  assert.throws(() => parseHybridDecision(invented, req));
});

test("missing/null Defense Post keeps legacy contract; stale DP alone does not hide City/boat", () => {
  const legacy = base();
  assert.equal(Object.hasOwn(validateHybridInput(legacy), "defense_post"), false);
  assert.deepEqual(Object.keys(buildHybridRequest(legacy).questions), [
    "branch", "land_action", "city_site",
  ]);
  const nil = { ...legacy, defense_post: null };
  assert.equal(validateHybridInput(nil).defense_post, null);
  assert.equal(buildHybridRequest(nil).state.defense_posts.status, "not_currently_scanned");
  const stale = withDefensePost();
  stale.defense_post.source_tick = 80;
  assert.throws(() => validateHybridInput(stale));
  const removed = withDefensePost();
  removed.defense_post = null;
  const req = buildHybridRequest(removed);
  assert.equal(req.questions.post_site, undefined);
  assert.ok(req.questions.city_site);
  assert.ok(req.questions.boat_action);
});

test("rejects unsupported, stale, inconsistent, or ambiguous city choices", () => {
  const changes = [
    (x) => {
      x.building.source_tick = 89;
    },
    (x) => {
      x.building.current_tick = 111;
    },
    (x) => {
      x.building.map_id = "unrelated/map";
    },
    (x) => {
      x.building.available_gold = "01000";
    },
    (x) => {
      x.building.candidates[1].id = x.building.candidates[0].id;
    },
    (x) => {
      x.building.candidates[0].gold_after_estimate = "999";
    },
    (x) => {
      x.building.candidates[0].cost_gold = "1001";
    },
    (x) => {
      x.building.candidates[0].tile = 72;
    },
    (x) => {
      x.building.coverage.omitted_count = 0;
    },
    (x) => {
      x.building.omissions.relocated = -1;
    },
    (x) => {
      x.building.omissions.hidden = 0;
    },
    (x) => {
      x.building.coverage.worker_checked = 31;
    },
    (x) => {
      x.building.save_gold.id = "invented:save_gold";
    },
    (x) => {
      x.building.snapshot_id = "another/map@100#2";
    },
    (x) => {
      x.building.candidates[0].region_id = "other-map:r2";
    },
    (x) => {
      x.plan.source_tick = 120;
    },
    (x) => {
      x.city_mechanics.troop_capacity_gain_display = -1;
    },
    (x) => {
      x.city_mechanics.arbitrary = "not engine derived";
    },
    (x) => {
      x.building.candidates[1].water_ids = ["invented", null];
    },
    (x) => {
      x.plan.expires_tick = 100;
    },
    (x) => {
      x.plan.objective = "";
    },
    (x) => {
      x.extra = "browser/tool injection";
    },
  ];
  for (const change of changes) {
    const value = base();
    change(value);
    assert.throws(() => validateHybridInput(value));
  }
});
