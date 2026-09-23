import test from "node:test";
import assert from "node:assert/strict";
import { createBuildingAdapter } from "../web/building-adapter.js";
import {
  buildHybridRequest,
  parseHybridDecision,
} from "../src/hybrid-policy.mjs";
import { observation } from "./fixtures/land.mjs";

test("the real City proposal shape survives strict hybrid validation and maps back to one callback", async () => {
  const sent = [];
  const player = {
    smallID: () => 1,
    gold: () => 200000n,
    units: () => [],
    buildables: async (tile, types) => {
      assert.deepEqual(types, ["City"]);
      return [
        { type: "City", canBuild: tile, canUpgrade: false, cost: 125000n },
      ];
    },
  };
  const game = {
    width: () => 1,
    height: () => 1,
    ref: () => 0,
    ownerID: () => 1,
    isLand: () => true,
    isImpassable: () => false,
    neighbors: () => [],
    gameID: () => "solo-1",
    ticks: () => 100,
    myPlayer: () => player,
  };
  const read = () => ({ ready: true, ended: false, tick: 100 });
  const builder = createBuildingAdapter({
    game,
    read,
    cityUnit: "City",
    sendBuild: (unit, tile) => {
      sent.push({ unit, tile });
      return true;
    },
  });
  const building = await builder.propose({
    mapId: "map",
    coverageRadius: 0,
    maxCandidates: 1,
    maxExamined: 1,
    maxWorkerChecks: 1,
  });
  assert.equal(building.candidates.length, 1);
  assert.equal(building.candidates[0].cost_gold, "125000");
  assert.equal(building.candidates[0].gold_after_estimate, "75000");
  assert.ok(Object.hasOwn(building.omissions, "occupied_city"));
  const input = {
    game_id: "solo-1",
    snapshot_tick: 100,
    land: observation(8000, 20000, "tribe"),
    building,
    city_mechanics: {
      troop_capacity_gain_display: 25000,
      construction_ticks: 20,
    },
    plan: null,
  };
  const request = buildHybridRequest(input);
  assert.deepEqual(Object.keys(request.questions), [
    "branch",
    "land_action",
    "city_site",
  ]);
  assert.ok(!JSON.stringify(request).includes('"tile":'));
  const picks = {
    branch: "city_build",
    land_action: "wait",
    city_site: "build_city_1",
  };
  const response = {
    model: "jev-mock",
    usage: {},
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => [
        key,
        {
          type: "choice",
          choice: picks[key],
          confidence: 0.8,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((choice) => [
              choice,
              Number(choice === picks[key]),
            ]),
          ),
        },
      ]),
    ),
  };
  const decision = parseHybridDecision(response, request);
  assert.equal(decision.candidate_id, building.candidates[0].id);
  assert.equal(decision.context.building_snapshot_id, building.snapshot_id);
  assert.equal(await builder.canExecute(decision.candidate_id), true);
  assert.equal(await builder.execute(decision.candidate_id, () => true), true);
  assert.deepEqual(sent, [{ unit: "City", tile: 0 }]);
  assert.equal(await builder.execute(decision.candidate_id, () => true), false);
});
