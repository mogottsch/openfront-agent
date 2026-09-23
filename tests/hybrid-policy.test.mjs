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
