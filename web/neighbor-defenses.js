// Future-only, explicit read-only study: NOT imported by the live observation
// or controller. Counts/terrain/range describe the current snapshot, not an
// AttackExecution path, future defensive strength, or conquest probability.
// Shared GameView/GameImpl accessors only; no worker, intent, model, or timers.
const TERRAIN_KEYS = ["plains", "highland", "mountain", "ocean", "impassable"];
const terrainCounts = () => Object.fromEntries(TERRAIN_KEYS.map((key) => [key, 0]));

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`Invalid ${name}`);
  return value;
}

function classifyUnits(target, type, size) {
  const units = target.units(type); // single-type overload works in both APIs
  if (!Array.isArray(units) || units.length > 4096)
    throw new Error("Unit enumeration unavailable or oversized");
  const counts = { completed_count: 0, constructing_count: 0, completed_levels: 0 };
  const completedTiles = [];
  const ids = new Set();
  for (const unit of units) {
    // Browser ownership groups are active-only. Core units() need the explicit
    // activity check. Never count deleted units or guess unknown status.
    const active = unit.isActive();
    if (active === false) continue;
    if (active !== true || unit.type() !== type ||
        unit.owner().smallID() !== target.smallID())
      throw new Error("Unit identity/activity unavailable or inconsistent");
    const id = integer(unit.id(), "unit ID", 0, Number.MAX_SAFE_INTEGER);
    if (ids.has(id)) throw new Error("Duplicate unit ID");
    ids.add(id);
    const tile = integer(unit.tile(), "unit tile", 0, size - 1);
    const constructing = unit.isUnderConstruction();
    if (constructing === true) counts.constructing_count++;
    else if (constructing === false) {
      counts.completed_count++;
      counts.completed_levels += integer(unit.level(), "unit level", 1, 1_000_000);
      completedTiles.push(tile);
    } else throw new Error("Unit construction status unavailable");
  }
  return { counts, completedTiles };
}

/**
 * Synchronously scans ONE target's current territory and target-side land
 * frontier with self. Call explicitly/off the 1 Hz loop. It fails rather than
 * publishing a sampled territory histogram when maxMapTiles is exceeded.
 * Range coverage is null (never zero) if its comparison budget is exceeded.
 * Terrain enum values mirror core/game/Game.ts: Plains0..Impassable4.
 * UnitType.City/DefensePost are the upstream strings "City"/"Defense Post".
 * No array or engine object is mutated; no raw unit positions leave this API.
 */
export function analyzeNeighborDefenses(game, {
  selfId, targetId, maxMapTiles = 4_194_304, maxCoverageChecks = 1_000_000,
} = {}) {
  integer(selfId, "self ID", 1, 4095);
  integer(targetId, "target ID", 1, 4095);
  if (selfId === targetId) throw new Error("Target must differ from observer");
  integer(maxMapTiles, "map scan budget", 1, 4_194_304);
  integer(maxCoverageChecks, "coverage budget", 0, 10_000_000);
  const width = integer(game.width(), "width", 1, 4_194_304);
  const height = integer(game.height(), "height", 1, 4_194_304);
  const size = integer(width * height, "map size", 1, maxMapTiles);
  const tick = integer(game.ticks(), "snapshot tick", 0, Number.MAX_SAFE_INTEGER);
  const gameId = game.gameID();
  if (typeof gameId !== "string" || !gameId) throw new Error("Game ID unavailable");
  const target = game.playerBySmallID(targetId);
  if (!target?.isPlayer() || target.smallID() !== targetId ||
      target.isAlive() !== true || !["BOT", "NATION"].includes(target.type()))
    throw new Error("Target must be a live tribe or nation");
  const targetIdentity = target.id();
  if (typeof targetIdentity !== "string" || !targetIdentity)
    throw new Error("Target identity unavailable");
  const radius = integer(game.config().defensePostRange(), "Post radius", 0, 2048);
  const city = classifyUnits(target, "City", size);
  const posts = classifyUnits(target, "Defense Post", size);
  const territory = terrainCounts();
  const frontierTerrain = terrainCounts();
  const frontierTiles = [];
  let ownedTiles = 0, sharedEdges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = game.ref(x, y);
      if (tile !== y * width + x) throw new Error("Expected row-major tile refs");
      if (game.ownerID(tile) !== targetId) continue;
      const terrain = game.terrainType(tile);
      if (!Number.isInteger(terrain) || !TERRAIN_KEYS[terrain])
        throw new Error("Unknown terrain type");
      territory[TERRAIN_KEYS[terrain]]++;
      ownedTiles++;
      if (!game.isLand(tile) || game.isImpassable(tile)) continue;
      let touchingEdges = 0;
      for (const neighbor of game.neighbors(tile)) {
        integer(neighbor, "neighbor tile", 0, size - 1);
        if (game.ownerID(neighbor) === selfId && game.isLand(neighbor) &&
            !game.isImpassable(neighbor)) touchingEdges++;
      }
      if (!touchingEdges) continue;
      sharedEdges += touchingEdges;
      frontierTiles.push(tile); // unique target tiles, not one entry per edge
      frontierTerrain[TERRAIN_KEYS[terrain]]++;
    }
  }
  const canMeasureRange = frontierTiles.length * posts.completedTiles.length <= maxCoverageChecks;
  const radiusSquared = radius * radius;
  const inRange = canMeasureRange ? frontierTiles.filter((tile) =>
    posts.completedTiles.some((post) => {
      const dx = tile % width - post % width;
      const dy = Math.floor(tile / width) - Math.floor(post / width);
      // UnitGrid.hasUnitNearby uses inclusive Euclidean distance squared.
      return dx * dx + dy * dy <= radiusSquared;
    })).length : null;
  if (game.ticks() !== tick || game.gameID() !== gameId ||
      target.id() !== targetIdentity || target.isAlive() !== true)
    throw new Error("Neighbor-defense snapshot changed during analysis");
  return {
    facts_version: "neighbor-defenses-v1",
    game_id: gameId, snapshot_tick: tick, observer_id: selfId, target_id: targetId,
    city: city.counts,
    defense_post: { ...posts.counts, range_tiles: radius },
    territory: { owned_tiles: ownedTiles, terrain: territory },
    frontier: {
      scope: "current_target_side_cardinal_land_contacts_not_attack_path",
      target_tiles: frontierTiles.length, shared_land_edges: sharedEdges,
      terrain: frontierTerrain,
      within_completed_post_range_tiles: inRange,
      range_coverage: canMeasureRange ? "exact_current_geometry" : "unknown_comparison_budget_exceeded",
    },
  };
}
