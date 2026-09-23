import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { analyzeSpatialMap } from "../web/spatial-map.js";
import { analyzeNavalSpatial, selectNavalCandidateIndexes } from "../web/naval-spatial.js";

function map(rows) {
  const width = rows[0].length;
  assert(rows.every((row) => row.length === width));
  const height = rows.length;
  const cells = rows.join("");
  let tick = 11;
  const neighbors = (tile) => {
    const x = tile % width;
    const y = Math.floor(tile / width);
    return [y ? tile - width : null, y < height - 1 ? tile + width : null,
      x ? tile - 1 : null, x < width - 1 ? tile + 1 : null]
      .filter((n) => n !== null);
  };
  const game = { width: () => width, height: () => height,
    ref: (x, y) => y * width + x,
    ticks: () => tick,
    ownerID: (tile) => ({ A: 1, B: 2, C: 3 })[cells[tile]] ?? 0,
    isLand: (tile) => !["~", "O"].includes(cells[tile]),
    isWater: (tile) => ["~", "O"].includes(cells[tile]),
    isOcean: (tile) => cells[tile] === "O",
    isImpassable: (tile) => cells[tile] === "#",
    neighbors,
    isShore: (tile) => cells[tile] !== "#" &&
      !["~", "O"].includes(cells[tile]) &&
      neighbors(tile).some((n) => ["~", "O"].includes(cells[n])),
  };
  return { game, setTick: (n) => { tick = n; } };
}

const snapshot = (game) => analyzeSpatialMap(game, 1, { tick: 11, mapId: "naval-test" });

test("two separate lakes do not offer a fictional inter-lake landfall", () => {
  const { game } = map(["AAAA...BBBB", "A~AA...B~BB", "AAAA...BBBB"]);
  const spatial = snapshot(game);
  assert.equal(spatial.waterComponents.length, 2);
  const naval = analyzeNavalSpatial(game, spatial);
  assert.equal(naval.coast.source_water_components, 1);
  assert.equal(naval.total_eligible, 0);
  assert.equal(naval.candidates.length, 0);
  assert.match(naval.certainty, /unverified/);
});

test("same cardinal water body gives a code-side coast pair, not a legal boat", () => {
  const { game } = map(["AAAA~~~~BBBB", "AAAA~~~~BBBB"]);
  const spatial = snapshot(game);
  const naval = analyzeNavalSpatial(game, spatial);
  assert.equal(naval.total_eligible, 1);
  const [site] = naval.candidates;
  assert.equal(site.source_region_id, spatial.regions[0].id);
  assert.equal(site.target_owner_id, 2);
  assert.equal(game.ownerID(site.source_shore_tile), 1);
  assert.equal(game.ownerID(site.target_shore_tile), 2);
  assert.equal(site.water_component_id, spatial.waterComponents[0].id);
  assert.equal(site.status, "geometric_only_not_engine_legal");
  assert.equal(site.water_span_method, "shore_manhattan_separation_not_water_path");
  assert.match(site.id, /:n1$/); // opaque index, not the landing ref
  assert.equal(naval.coast.shore_source, "isShore_and_water_adjacency");
});

test("an island and mainland of the same owner remain distinct target regions", () => {
  const { game } = map([
    "AAAA~~~~~~~~BBBB",
    "AAAA~~~~~~~~BBBB",
    "AAAA~~~BB~~~BBBB",
  ]);
  const spatial = snapshot(game);
  const naval = analyzeNavalSpatial(game, spatial);
  assert.equal(naval.total_eligible, 2);
  assert.equal(new Set(naval.candidates.map((c) => c.target_region_id)).size, 2);
  assert.deepEqual(naval.candidates.map((c) => c.target_region_tiles).sort((a, b) => a - b), [2, 12]);
  assert(naval.candidates.every((c) => c.target_owner_id === 2));
  assert.equal(naval.omitted_count, 0);
  const coastLimited = analyzeNavalSpatial(game, spatial,
    { maxCoastTiles: 1, maxCandidates: 20 });
  assert.equal(coastLimited.coast.eligible_target_owner_regions, 2);
  assert.equal(coastLimited.coast.coast_budget_truncated_owner_regions, 1);
  assert.equal(coastLimited.coast.sampled_region_component_coasts, 1);
  assert.equal(coastLimited.candidates.length, 1);
  assert.equal(coastLimited.omitted_count, 1);
  assert.equal(coastLimited.reasons.coast_budget_unexamined, 1);
  const shortlistLimited = analyzeNavalSpatial(game, spatial,
    { maxCandidates: 1, maxCoastTiles: 2 });
  assert.equal(shortlistLimited.reasons.shortlist_limit, 1);
  assert.equal(shortlistLimited.omitted_count, 1);
});

test("two disconnected own shores touching one body remain separate source regions", () => {
  const { game } = map([
    "AA~~~~~~~~AA",
    "AA~~~~BB~~AA",
    "AA~~~~~~~~AA",
  ]);
  const spatial = snapshot(game);
  assert.equal(spatial.regions.length, 2);
  const naval = analyzeNavalSpatial(game, spatial);
  assert.equal(naval.total_eligible, 2);
  assert.equal(new Set(naval.candidates.map((c) => c.source_region_id)).size, 2);
  assert.equal(new Set(naval.candidates.map((c) => c.water_component_id)).size, 1);
  const none = analyzeNavalSpatial(game, spatial, { maxCoastTiles: 0 });
  assert.equal(none.coast.coast_budget_truncated_owner_regions, 1);
  assert.equal(none.candidates.length, 0);
  assert.equal(none.reasons.coast_budget_unexamined, 2);
});

test("closest coast last in map scan survives a truncated diverse shortlist", () => {
  const { game } = map([
    "A~~~~~~~~~BBBB",
    "A~~~~~~~BB~~~~",
    "A~B~~~~~~~~~~~",
  ]);
  const spatial = snapshot(game);
  const full = analyzeNavalSpatial(game, spatial, { maxCandidates: 3 });
  assert.equal(full.candidates.length, 3);
  assert.deepEqual(full.candidates.map((c) => c.target_region_tiles), [4, 2, 1]);
  const near = full.candidates[2]; // last target-owner region in row-major scan
  const cut = analyzeNavalSpatial(game, spatial, { maxCandidates: 2 });
  assert.deepEqual(cut.candidates.map((c) => c.target_region_tiles), [1, 4]);
  assert.equal(cut.candidates[0].id, near.id); // original pool ID retained
  assert.equal(cut.reasons.shortlist_limit, 1);
  assert.equal(cut.omitted_count, 1);
  assert.equal(cut.coast.coast_budget_truncated_owner_regions, 0);
});

test("Pareto geometry preserves distinct owner/water/source axes when budget allows", () => {
  const pool = [
    { target_owner_id: 0, water_component_id: "w1", source_region_id: "s1",
      target_region_id: "r1", water_span_estimate_tiles: 100,
      target_region_tiles: 1000, target_shore_tiles: 20 },
    { target_owner_id: 0, water_component_id: "w1", source_region_id: "s1",
      target_region_id: "r2", water_span_estimate_tiles: 2,
      target_region_tiles: 10, target_shore_tiles: 2 },
    { target_owner_id: 2, water_component_id: "w2", source_region_id: "s2",
      target_region_id: "r3", water_span_estimate_tiles: 20,
      target_region_tiles: 200, target_shore_tiles: 12 },
    { target_owner_id: 0, water_component_id: "w1", source_region_id: "s1",
      target_region_id: "r4", water_span_estimate_tiles: 50,
      target_region_tiles: 50, target_shore_tiles: 5 },
  ];
  assert.deepEqual(selectNavalCandidateIndexes(pool, 4), [0, 1, 2, 3]);
  assert.deepEqual(selectNavalCandidateIndexes(pool, 3), [1, 0, 2]);
  assert.deepEqual(selectNavalCandidateIndexes(pool, 2), [1, 0]);
  assert.deepEqual(selectNavalCandidateIndexes(pool, 1), [1]);
  assert.deepEqual(selectNavalCandidateIndexes(pool, 0), []);
});

const onionArtifact = new URL("../logs/naval-adapter-engine.json", import.meta.url);
test("ignored genuine Onion tick649 proposal replay keeps near and large with max6",
  { skip: !existsSync(onionArtifact) }, () => {
    const source = JSON.parse(readFileSync(onionArtifact, "utf8"));
    const proposal = source.after_regrow.proposal;
    assert.equal(source.engineCommit, "bb8af015b515b3b717bd4d901074c5f4c16641cb");
    assert.equal(proposal.source_tick, 649);
    assert.equal(proposal.candidates.length, 11);
    assert.equal(proposal.coverage.worker_checked, 11);
    const selected = selectNavalCandidateIndexes(proposal.candidates, 6)
      .map((i) => proposal.candidates[i]);
    assert.equal(selected.length, 6);
    assert(selected.some((c) => c.water_span_estimate_tiles === 18));
    assert(selected.some((c) => c.target_region_tiles === 76697));
    assert.equal(proposal.candidates.length - selected.length, 5);
    assert.deepEqual(selectNavalCandidateIndexes(proposal.candidates, 11),
      Array.from({ length: 11 }, (_, i) => i));
    process.stdout.write(`Onion tick649 stored worker-checked replay max6: ` +
      `${selected.map((c) => `${c.id.split(":").at(-1)}=${c.water_span_estimate_tiles}`).join(", ")}; ` +
      `stored cohort omitted 5\n`);
  });

test("impassable or unshored land cannot masquerade as a landing shore", () => {
  const { game } = map(["AA~#B"]);
  assert.equal(analyzeNavalSpatial(game, snapshot(game)).candidates.length, 0);
  const a = map(["AA~B"]);
  a.game.isShore = (tile) => tile !== 3 &&
    a.game.isLand(tile) && a.game.neighbors(tile).some((n) => a.game.isWater(n));
  const spatial = snapshot(a.game);
  assert.equal(spatial.waterComponents.length, 1);
  assert.equal(analyzeNavalSpatial(a.game, spatial).total_eligible, 0);
});

test("wilderness is explicit and can be excluded without confusing player landfalls", () => {
  const { game } = map(["AA~~~..."]);
  const spatial = snapshot(game);
  const withWilderness = analyzeNavalSpatial(game, spatial);
  assert.equal(withWilderness.candidates[0].target_owner_id, 0);
  const without = analyzeNavalSpatial(game, spatial, { includeWilderness: false });
  assert.equal(without.total_eligible, 0);
  assert.equal(without.candidates.length, 0);
});

test("pair cap and owner-region cap disclose omitted candidate combinations", () => {
  const { game } = map([
    "AAAA~~~~~~~~BBBB",
    "AAAA~~~~~~~~BBBB",
    "AAAA~~~BB~~~BBBB",
  ]);
  const spatial = snapshot(game);
  const full = analyzeNavalSpatial(game, spatial);
  const capped = analyzeNavalSpatial(game, spatial, { maxPairs: 1, maxCandidates: 8 });
  assert(full.total_eligible >= 2);
  assert.equal(capped.candidates.length, 1);
  assert.equal(capped.reasons.pair_budget_unexamined, capped.total_eligible - 1);
  assert.equal(capped.omitted_count,
    Object.values(capped.reasons).reduce((sum, n) => sum + n, 0));
});

test("rejects stale or mismatched spatial data instead of relabeling a live map", () => {
  const { game, setTick } = map(["AA~~BB"]);
  const spatial = snapshot(game);
  setTick(12);
  assert.throws(() => analyzeNavalSpatial(game, spatial), /stale/);
  const other = map(["AA~B"]);
  assert.throws(() => analyzeNavalSpatial(other.game, spatial), /matching spatial snapshot/);
});

test("explicit medium-map trial measures geometry without worker or model calls", () => {
  const w = 320;
  const h = 256;
  const rows = Array.from({ length: h }, () =>
    "A".repeat(80) + "O".repeat(90) + "B".repeat(150));
  assert.equal(rows[0].length, w);
  const { game } = map(rows);
  const start = performance.now();
  const spatial = snapshot(game);
  const analyzedMs = performance.now() - start;
  const second = performance.now();
  const naval = analyzeNavalSpatial(game, spatial);
  const navalMs = performance.now() - second;
  assert.equal(naval.total_eligible, 1);
  assert(analyzedMs < 5000 && navalMs < 5000);
  process.stdout.write(`naval 320x256: base ${analyzedMs.toFixed(1)}ms; ` +
    `naval ${navalMs.toFixed(1)}ms; eligible ${naval.total_eligible}; ` +
    `omitted ${naval.omitted_count}\n`);
});
