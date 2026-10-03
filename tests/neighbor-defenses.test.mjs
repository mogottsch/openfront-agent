import assert from "node:assert/strict";
import test from "node:test";
import { analyzeNeighborDefenses, observeNeighborStructures, validateNeighborStructures } from "../web/neighbor-defenses.js";

// Dependency-free facades mirror SOURCE APIs. These are not actual-engine
// parity tests or gameplay: browser units() excludes inactive units; core's
// list can include them. Both use a single-type overload, no shared arrays mutate.
function fixture(rows = ["AAAB", "BBBB", "BBBB"], {
  browser = true, radius = 2, terrain = [],
} = {}) {
  const width = rows[0].length, height = rows.length;
  const owners = [...rows.join("")].map((c) => ({ A: 1, B: 2, C: 3 })[c] ?? 0);
  const types = owners.map((_, i) => terrain[i] ?? 0);
  let tick = 100, gameId = "neighbor-facts-test", targetAlive = true;
  const units = [];
  const target = {
    smallID: () => 2, id: () => "nation2", type: () => "NATION",
    isPlayer: () => true, isAlive: () => targetAlive,
    units: (...args) => {
      assert.equal(args.length, 1, "common single-type signature");
      assert.equal(typeof args[0], "string", "not core-only array overload");
      return units.filter((u) => u.type() === args[0] && (!browser || u.isActive()));
    },
  };
  const game = {
    width: () => width, height: () => height, ref: (x, y) => y * width + x,
    ownerID: (tile) => owners[tile], terrainType: (tile) => types[tile],
    isLand: (tile) => types[tile] !== 3, isImpassable: (tile) => types[tile] === 4,
    ticks: () => tick, gameID: () => gameId,
    playerBySmallID: (id) => id === 2 ? target : undefined,
    config: () => ({ defensePostRange: () => radius }),
    neighbors: (tile) => {
      const x = tile % width, y = Math.floor(tile / width);
      return [y > 0 ? tile - width : null, y < height - 1 ? tile + width : null,
        x > 0 ? tile - 1 : null, x < width - 1 ? tile + 1 : null].filter((n) => n !== null);
    },
  };
  let serial = 0;
  function unit(type, tile, { active = true, constructing = false, level = 1,
    ownerId = 2 } = {}) {
    const id = ++serial;
    return { id: () => id, type: () => type, tile: () => tile,
      isActive: () => active, isUnderConstruction: () => constructing,
      level: () => level, owner: () => ({ smallID: () => ownerId }) };
  }
  const analyze = (options = {}) => analyzeNeighborDefenses(game, { selfId: 1, targetId: 2, ...options });
  return { game, units, unit, analyze, target, owners, types,
    setTick: (t) => { tick = t; }, setGame: (id) => { gameId = id; },
    setAlive: (alive) => { targetAlive = alive; } };
}

test("completed buildings are STRUCTURE counts, not summed upgrade levels; construction separate", () => {
  const f = fixture();
  f.units.push(f.unit("City", 4, { level: 3 }), f.unit("City", 5, { constructing: true }),
    f.unit("Defense Post", 8, { level: 4 }), f.unit("Defense Post", 7, { constructing: true }));
  const result = f.analyze();
  assert.deepEqual(result.city, { completed_count: 1, constructing_count: 1, completed_levels: 3 });
  assert.deepEqual(result.defense_post, { completed_count: 1, constructing_count: 1,
    completed_levels: 4, range_tiles: 2 });
  assert.equal(result.snapshot_tick, 100);
  assert.equal(result.target_id, 2);
  assert.equal(result.territory.owned_tiles, 9);
  assert.equal(result.frontier.target_tiles, 4);
  assert.equal(result.frontier.shared_land_edges, 4);
});

test("browser-active-only and core-style enumeration produce identical modeled facts (MOCK parity)", () => {
  const browser = fixture(undefined, { browser: true });
  const core = fixture(undefined, { browser: false });
  for (const f of [browser, core]) {
    f.units.push(f.unit("City", 8, { level: 2 }),
      f.unit("City", 7, { active: false }),
      f.unit("Defense Post", 8, { constructing: true }),
      f.unit("Defense Post", 7, { active: false }));
  }
  assert.deepEqual(browser.analyze(), core.analyze());
  assert.equal(core.analyze().frontier.within_completed_post_range_tiles, 0);
});

test("radius is inclusive EUCLIDEAN and checks target side; constructing/foreign Posts cannot cover", () => {
  const f = fixture(["ABB"], { radius: 1 });
  f.units.push(f.unit("Defense Post", 2)); // target-side tile1 exactly one away
  assert.equal(f.analyze().frontier.within_completed_post_range_tiles, 1);
  const diagonal = fixture(["ABB", "BBB", "BBB"], { radius: 1 });
  diagonal.units.push(diagonal.unit("Defense Post", 4));
  // Target tiles1 and3 are a cardinal radius1 from tile4; not from a
  // mistakenly measured own tile0 (sqrt2 away).
  assert.equal(diagonal.analyze().frontier.within_completed_post_range_tiles, 2);
  const outside = fixture(["AAB", "BBB", "BBB"], { radius: 2 });
  outside.units.push(outside.unit("Defense Post", 6));
  // Target tiles2 (sqrt8) and4 (sqrt2) and3 (1); 2 of 3 in range.
  assert.equal(outside.analyze().frontier.within_completed_post_range_tiles, 2);
  const building = fixture(["ABB"], { radius: 100 });
  building.units.push(building.unit("Defense Post", 1, { constructing: true }));
  assert.equal(building.analyze().frontier.within_completed_post_range_tiles, 0);
  building.units.push(building.unit("Defense Post", 2, { ownerId: 3 }));
  assert.throws(() => building.analyze(), /identity/);
});

test("multiple border edges sharing one target tile never double count tiles or overlapping Posts", () => {
  const f = fixture(["ABA", "BBB"], { radius: 10 });
  f.units.push(f.unit("Defense Post", 1), f.unit("Defense Post", 5));
  const result = f.analyze();
  assert.equal(result.frontier.target_tiles, 3);
  assert.equal(result.frontier.shared_land_edges, 4);
  assert.equal(result.frontier.within_completed_post_range_tiles, 3);
});

test("territory histogram is exact current ownership, frontier excludes water/impassable/diagonal contacts", () => {
  const f = fixture(["ABB", "BCB", "BBB"], { terrain: [0, 1, 2, 3, 0, 4, 2, 0, 1] });
  const result = f.analyze();
  assert.deepEqual(result.territory.terrain, { plains: 1, highland: 2, mountain: 2,
    ocean: 1, impassable: 1 });
  assert.equal(result.territory.owned_tiles, 7);
  assert.equal(result.frontier.target_tiles, 1);
  assert.equal(result.frontier.terrain.highland, 1);
  assert.equal(result.frontier.terrain.mountain, 0); // diagonal/far target isn't frontier
  f.owners[1] = 3;
  assert.equal(f.analyze().frontier.target_tiles, 0);
});

test("budgets never turn uncomputed geometry into no defenses or a sampled territory total", () => {
  const f = fixture();
  f.units.push(f.unit("Defense Post", 8));
  assert.throws(() => f.analyze({ maxMapTiles: 11 }), /map size/);
  const result = f.analyze({ maxCoverageChecks: 0 });
  assert.equal(result.frontier.within_completed_post_range_tiles, null);
  assert.equal(result.frontier.range_coverage, "unknown_comparison_budget_exceeded");
  assert.equal(result.defense_post.completed_count, 1);
  assert.equal(result.territory.owned_tiles, 9);
  assert.throws(() => f.analyze({ maxCoverageChecks: -1 }));
});

test("unavailable metadata, duplicates or unknown terrain fail closed instead of assuming zero", () => {
  const f = fixture();
  f.units.push(f.unit("City", 4));
  f.units[0].isUnderConstruction = () => undefined;
  assert.throws(() => f.analyze(), /construction/);
  f.units[0].isUnderConstruction = () => false;
  f.units.push(f.units[0]);
  assert.throws(() => f.analyze(), /Duplicate/);
  f.units.pop();
  f.types[3] = 9;
  assert.throws(() => f.analyze(), /terrain/);
  const unavailable = fixture();
  unavailable.target.units = undefined;
  assert.throws(() => unavailable.analyze());
  unavailable.setAlive(false);
  assert.throws(() => unavailable.analyze(), /live tribe or nation/);
});

test("synchronous facts reject changed tick/game/identity and never call worker/send/model methods", () => {
  for (const change of [
    (f) => f.setTick(101), (f) => f.setGame("replacement"), (f) => f.setAlive(false),
    (f) => { f.target.id = () => "replacement-target"; },
  ]) {
    const f = fixture();
    const terrainType = f.game.terrainType;
    f.game.terrainType = (tile) => { change(f); return terrainType(tile); };
    assert.throws(() => f.analyze(), /snapshot changed/);
  }
  const f = fixture();
  for (const method of ["sendAttack", "sendBuild", "canBuild", "buildables", "decide"]) {
    f.game[method] = f.target[method] = () => { throw new Error("NOT AUTHORIZED"); };
  }
  const before = [...f.owners];
  const result = f.analyze();
  assert.match(result.frontier.scope, /not_attack_path/);
  assert.deepEqual(f.owners, before);
  assert.equal("conquest_probability" in result, false);
  assert.equal("garrison" in result, false);
});

const zeroStructures = () => ({
  source_tick: 100,
  city: { completed_count: 0, constructing_count: 0, completed_levels: 0 },
  defense_post: { completed_count: 0, constructing_count: 0, completed_levels: 0 },
});

test("cheap structure facts touch NO map/position/config/worker/model and count authoritative zero", () => {
  const f = fixture();
  for (const name of ["width", "height", "ref", "ownerID", "terrainType", "isLand",
    "isImpassable", "neighbors", "config", "sendAttack", "sendBuild", "buildables", "decide"]) {
    f.game[name] = () => { throw new Error(`Forbidden ${name}`); };
  }
  assert.deepEqual(observeNeighborStructures(f.game, 2), zeroStructures());
  const city = f.unit("City", 4, { level: 3 });
  const post = f.unit("Defense Post", 5, { constructing: true });
  city.tile = post.tile = () => { throw new Error("No positions necessary for counts"); };
  f.units.push(city, post);
  assert.deepEqual(observeNeighborStructures(f.game, 2), {
    source_tick: 100,
    city: { completed_count: 1, constructing_count: 0, completed_levels: 3 },
    defense_post: { completed_count: 0, constructing_count: 1, completed_levels: 0 },
  });
});

test("cheap counts match explicit slow study and mocked browser/core views for tribes/nations", () => {
  for (const type of ["BOT", "NATION"]) {
    const results = [];
    for (const browser of [true, false]) {
      const f = fixture(undefined, { browser });
      f.target.type = () => type;
      f.units.push(f.unit("City", 4, { level: 3 }),
        f.unit("City", 5, { constructing: true }), f.unit("City", 6, { active: false }),
        f.unit("Defense Post", 7, { level: 2 }),
        f.unit("Defense Post", 8, { constructing: true }),
        f.unit("Defense Post", 9, { active: false }));
      const result = observeNeighborStructures(f.game, 2);
      const slow = f.analyze();
      assert.deepEqual(result.city, slow.city);
      assert.deepEqual(result.defense_post, { completed_count: slow.defense_post.completed_count,
        constructing_count: slow.defense_post.constructing_count,
        completed_levels: slow.defense_post.completed_levels });
      results.push(result);
    }
    assert.deepEqual(...results);
  }
});

test("cheap snapshots reject changes during enumeration, replaced identity and missing/unknown metadata", () => {
  for (const change of [
    (f) => f.setTick(101), (f) => f.setGame("new-game"), (f) => f.setAlive(false),
    (f) => { f.target.id = () => "new-target"; },
    (f) => { f.target.type = () => "HUMAN"; },
    (f) => { f.game.playerBySmallID = () => undefined; },
  ]) {
    const f = fixture(undefined, { browser: false });
    const units = f.target.units;
    f.target.units = (...args) => { const result = units(...args); change(f); return result; };
    assert.throws(() => observeNeighborStructures(f.game, 2), /snapshot changed/);
  }
  const f = fixture(undefined, { browser: false });
  const city = f.unit("City", 4);
  f.units.push(city);
  city.isActive = () => undefined;
  assert.throws(() => observeNeighborStructures(f.game, 2), /identity\/activity/);
  city.isActive = () => true;
  city.isUnderConstruction = () => undefined;
  assert.throws(() => observeNeighborStructures(f.game, 2), /construction/);
  city.isUnderConstruction = () => false;
  city.level = () => undefined;
  assert.throws(() => observeNeighborStructures(f.game, 2), /unit level/);
  assert.throws(() => observeNeighborStructures(f.game, 0), /target ID/);
  const missing = fixture();
  missing.target.units = undefined;
  assert.throws(() => observeNeighborStructures(missing.game, 2));
});

test("compact structure validator rejects extra/missing/noninteger/inconsistent counts, keeps zeros", () => {
  assert.deepEqual(validateNeighborStructures(zeroStructures()), zeroStructures());
  const invalid = [null, [], {}, { ...zeroStructures(), terrain: {} },
    { ...zeroStructures(), source_tick: -1 }, { ...zeroStructures(), source_tick: 1.5 },
    { ...zeroStructures(), source_tick: "100" }, { ...zeroStructures(), source_tick: Infinity }];
  for (const value of [undefined, null, "0", 0.5, -1, NaN, Infinity, 4097]) {
    const entry = zeroStructures();
    entry.city.completed_count = value;
    invalid.push(entry);
  }
  for (const change of [
    (v) => { delete v.defense_post; },
    (v) => { delete v.city.completed_levels; },
    (v) => { v.city.range_tiles = 30; },
    (v) => { v.city.completed_levels = 1; }, // zero completed cannot have levels
    (v) => { v.city.completed_count = 1; }, // completed level sum must be >= count
    (v) => { v.city.constructing_count = -1; },
    (v) => { v.city.constructing_count = "1"; },
    (v) => { v.city.completed_count = 4096; v.city.completed_levels = 4096; v.city.constructing_count = 1; },
    (v) => { v.city.completed_count = 1; v.city.completed_levels = 1_000_001; },
  ]) {
    const value = zeroStructures();
    change(value);
    invalid.push(value);
  }
  for (const value of invalid) assert.throws(() => validateNeighborStructures(value));
  const original = zeroStructures();
  const parsed = validateNeighborStructures(original);
  assert.notEqual(parsed, original);
  assert.notEqual(parsed.city, original.city);
});
