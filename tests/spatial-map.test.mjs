import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { analyzeSpatialMap, prefilterPlacementSites } from "../web/spatial-map.js";

function map(rows, { oceanAvailable = true, waterAvailable = true } = {}) {
  const width = rows[0].length;
  assert(rows.every((row) => row.length === width));
  const height = rows.length;
  const cells = rows.join("");
  const game = {
    width: () => width,
    height: () => height,
    ref: (x, y) => y * width + x,
    ownerID: (tile) => ({ A: 1, B: 2, C: 3 })[cells[tile]] ?? 0,
    isLand: (tile) => !["~", "O"].includes(cells[tile]),
    isImpassable: (tile) => cells[tile] === "#",
    neighbors: (tile) => {
      const x = tile % width;
      const y = Math.floor(tile / width);
      return [y > 0 ? tile - width : null,
        y < height - 1 ? tile + width : null,
        x > 0 ? tile - 1 : null,
        x < width - 1 ? tile + 1 : null].filter((n) => n !== null);
    },
  };
  if (waterAvailable) game.isWater = (tile) => ["~", "O"].includes(cells[tile]);
  if (oceanAvailable) game.isOcean = (tile) => cells[tile] === "O";
  return game;
}

const at = (game, x, y) => game.ref(x, y);

test("four-connected owned regions include a one-tile strip but not a broken strip", () => {
  const linked = map(["AAA...AAA", "AAA...AAA", "AAAAAAAAA"]);
  const joined = analyzeSpatialMap(linked, 1, { tick: 12, mapId: "synthetic" });
  assert.equal(joined.regions.length, 1);
  assert.equal(joined.regions[0].tile_count, 21);
  assert.equal(joined.regionByTile[at(linked, 8, 0)], 1);
  const broken = analyzeSpatialMap(map(["AAA...AAA", "AAA...AAA", "AAAA.AAAA"]), 1,
    { tick: 12, mapId: "synthetic" });
  assert.deepEqual(broken.regions.map((r) => r.tile_count), [10, 10]);
  assert.notEqual(joined.snapshot_id, broken.snapshot_id);
  assert.notEqual(joined.regions[0].id, broken.regions[0].id);
});

test("front arcs distinguish repeated opponent contact separated by wilderness", () => {
  const game = map(["BBBBBBB", "AA.AA.A", "AAAAAAA"]);
  const spatial = analyzeSpatialMap(game, 1);
  assert.equal(spatial.regions.length, 1);
  const rival = spatial.fronts.filter((f) => f.kind === "player" && f.target_id === 2);
  assert.equal(rival.length, 3);
  assert.deepEqual(rival.map((f) => f.edge_count), [2, 2, 1]);
  assert.equal(spatial.fronts.filter((f) => f.kind === "wilderness").length > 0, true);
  assert(rival.every((f) => f.region_id === spatial.regions[0].id));
});

test("cardinal water components identify distinct lakes, ocean and each real coast", () => {
  const game = map(["AAAAAAAAAA", "A~A~AOOOAA", "AAAAAAAAAA"]);
  const spatial = analyzeSpatialMap(game, 1);
  assert.deepEqual(spatial.waterComponents.map((c) => c.tile_count), [1, 1, 3]);
  assert.deepEqual(spatial.waterComponents.map((c) => c.ocean_status), ["inland", "inland", "ocean"]);
  assert.notEqual(spatial.waterByTile[at(game, 1, 1)], spatial.waterByTile[at(game, 3, 1)]);
  const betweenLakes = spatial.waterIdsByCoastTile.get(at(game, 2, 1));
  assert.equal(betweenLakes.length, 2);
  // Each lake is a connected water body; its four separated own-bank tiles
  // form four cardinal frontier arcs, all referencing that same component.
  assert.equal(new Set(spatial.fronts.filter((f) => f.kind === "water")
    .map((f) => f.target_id)).size, 3);
  const coast = prefilterPlacementSites(spatial,
    { siteKind: "coast", coverageRadius: 0, maxCandidates: 20 });
  assert(coast.candidates.every((c) => c.water_ids.length));
  assert(coast.candidates.some((c) => c.water_ids.includes(spatial.waterComponents[2].id)));
});

test("GameView neighbors4 buffer remains valid after short edge lists", () => {
  const game = map(["AA", "AA"]);
  const ordinary = game.neighbors;
  game.neighbors4 = (tile, out) => {
    assert(out.length >= 4);
    const around = ordinary(tile);
    for (let i = 0; i < around.length; i++) out[i] = around[i];
    return around.length;
  };
  game.neighbors = () => { throw new Error("Should use neighbors4"); };
  const spatial = analyzeSpatialMap(game, 1);
  assert.equal(spatial.regions[0].tile_count, 4);
});

test("unavailable ocean/water getters are explicitly labeled, not guessed", () => {
  const spatial = analyzeSpatialMap(map(["A~A"],
    { oceanAvailable: false, waterAvailable: false }), 1);
  assert.equal(spatial.water_source, "derived_from_isLand");
  assert.equal(spatial.ocean_source, "unavailable");
  assert.equal(spatial.waterComponents[0].ocean_status, "unknown");
});

test("land and player border distances are shortest paths through own land only", () => {
  const game = map(["BBBBB", "AAAAA", "AAAAA", "AAAAA", "....."]);
  const spatial = analyzeSpatialMap(game, 1);
  assert.equal(spatial.landBorderDistanceByTile[at(game, 2, 1)], 0);
  assert.equal(spatial.landBorderDistanceByTile[at(game, 2, 2)], 1);
  assert.equal(spatial.landBorderDistanceByTile[at(game, 2, 3)], 0);
  assert.equal(spatial.playerBorderDistanceByTile[at(game, 2, 3)], 2);
  assert.equal(spatial.landBorderDistanceByTile[at(game, 1, 0)], -1);
  assert.equal(spatial.nearestLandFrontByTile[at(game, 2, 2)] > 0, true);
});

test("tiny maps and impassable edges do not invent fronts, distances or legal sites", () => {
  const one = analyzeSpatialMap(map(["A"]), 1);
  assert.equal(one.regions.length, 1);
  assert.equal(one.fronts.length, 0);
  assert.equal(one.landBorderDistanceByTile[0], -1);
  assert.equal(prefilterPlacementSites(one, { coverageRadius: 0 }).candidates[0].tile, 0);
  const game = map(["#A#", "###"]);
  const blocked = analyzeSpatialMap(game, 1);
  assert.equal(blocked.fronts.filter((f) => f.kind === "blocked").length, 1);
  assert.equal(blocked.landBorderDistanceByTile[1], -1);
  assert.deepEqual(prefilterPlacementSites(blocked, { coverageRadius: 0 }).candidates.map((c) => c.tile), [1]);
});

test("marginal coverage is geometric own-passable coverage not already covered", () => {
  const game = map(["AAAAAAA"]);
  const spatial = analyzeSpatialMap(game, 1);
  const result = prefilterPlacementSites(spatial,
    { existingSites: [at(game, 1, 0)], coverageRadius: 1, maxCandidates: 7 });
  const byTile = new Map(result.candidates.map((c) => [c.tile, c]));
  assert.equal(byTile.get(3).marginal_coverage_tiles, 2);
  assert.equal(byTile.get(5).marginal_coverage_tiles, 3);
  assert.equal(byTile.get(1).marginal_coverage_tiles, 0);
  const withWater = analyzeSpatialMap(map(["AA~AA"]), 1);
  const coastal = prefilterPlacementSites(withWater,
    { coverageRadius: 2, maxCandidates: 5 });
  assert.equal(coastal.candidates.find((c) => c.tile === 1).marginal_coverage_tiles, 3);
});

test("bounded prefilter keeps region, lake, front and border-depth diversity, reports omissions", () => {
  const game = map([
    "BBBB...........",
    "AAAA....AAAAAAA",
    "A~AA....A~AAOOA",
    "AAAA....AAAAAAA",
    "AAAA....AAAAAAA",
    "AAAA....AAAAAAA",
  ]);
  const spatial = analyzeSpatialMap(game, 1, { tick: 42 });
  const all = prefilterPlacementSites(spatial,
    { coverageRadius: 2, maxCandidates: 12, maxExamined: 1000 });
  assert.equal(all.total_examined, all.total_eligible);
  assert.equal(new Set(all.candidates.map((c) => c.region_id)).size, 2);
  assert(all.candidates.some((c) => c.distance_to_land_border >= 2));
  const waters = new Set(all.candidates.flatMap((c) => c.water_ids));
  assert.equal(waters.size, 3);
  assert(all.candidates.some((c) => c.front_id));
  assert.equal(all.omitted_count, all.total_eligible - all.candidates.length);
  const bounded = prefilterPlacementSites(spatial,
    { coverageRadius: 2, maxCandidates: 4, maxExamined: 8 });
  assert.equal(bounded.total_examined, 8);
  assert.equal(bounded.candidates.length, 4);
  assert.equal(bounded.reasons.not_examined, bounded.total_eligible - 8);
  assert.equal(bounded.reasons.shortlist_limit, 4);
  assert.equal(bounded.omitted_count, bounded.reasons.not_examined + bounded.reasons.shortlist_limit);
  assert(bounded.candidates.every((c) => c.id.startsWith(`${spatial.snapshot_id}:site`)));
});

test("explicit snapshot computation is bounded in a measured medium-map trial", () => {
  const w = 320;
  const h = 256;
  const cells = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => x < 16 || x >= w - 16 || y < 16 || y >= h - 16
      ? "~" : x < 190 ? "A" : "B").join(""));
  const game = map(cells);
  const start = performance.now();
  const spatial = analyzeSpatialMap(game, 1, { tick: 1, mapId: "timing" });
  const analyzedMs = performance.now() - start;
  const prefilterStart = performance.now();
  const candidates = prefilterPlacementSites(spatial, {
    existingSites: [game.ref(75, 100), game.ref(110, 180)], coverageRadius: 8,
    maxCandidates: 24, maxExamined: 2048,
  });
  const prefilterMs = performance.now() - prefilterStart;
  assert.equal(candidates.total_examined, 2048);
  assert(candidates.candidates.length <= 24);
  assert(analyzedMs < 5000 && prefilterMs < 5000,
    `Unexpectedly slow: analysis=${analyzedMs.toFixed(1)}ms prefilter=${prefilterMs.toFixed(1)}ms`);
  process.stdout.write(`spatial 320x256: analysis ${analyzedMs.toFixed(1)}ms; prefilter ${prefilterMs.toFixed(1)}ms; ` +
    `examined ${candidates.total_examined}/${candidates.total_eligible}; omitted ${candidates.omitted_count}\n`);
});
