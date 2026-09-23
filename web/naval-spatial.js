// Read-only, explicitly invoked naval GEOMETRY study. No boat action, worker
// legality call, live observation, or automatic 1 Hz map scan. Full-resolution
// cardinal water connectivity is NOT the engine's 2x minimap water graph or
// pathfinder; these are possible coast-to-coast contacts, not safe/legal boats.

function bounded(value, name, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`Invalid ${name}`);
  }
  return value;
}

function around(game, tile, buffer) {
  if (typeof game.neighbors4 !== "function") return game.neighbors(tile);
  buffer.length = 4; // GameMap.neighbors4 requires length >= 4 on every call
  const count = game.neighbors4(tile, buffer);
  buffer.length = count;
  return buffer;
}

/**
 * Analyze a previously captured analyzeSpatialMap(game, ownSmallID, ...)
 * snapshot. This function does another explicit O(width*height) read-only pass
 * to group target-owned/passable land regions. No scheduling or worker call.
 *
 * maxCoastTiles bounds sampled target region/water coast contacts, NOT the
 * required whole-map topology scan. maxPairs bounds source/target region
 * combinations considered for the final diverse shortlist. Every omitted
 * combination and target-owner region is counted; never interpret an empty
 * shortlist as proof that a boat is impossible.
 *
 * Returned shore refs are CODE-SIDE samples for a future worker probe; any
 * model-facing projection must replace them with opaque candidate IDs.
 */
export function analyzeNavalSpatial(game, spatial, {
  maxCandidates = 24, maxCoastTiles = 256, maxPairs = 1024,
  includeWilderness = true,
} = {}) {
  bounded(maxCandidates, "maxCandidates", 128);
  bounded(maxCoastTiles, "maxCoastTiles", 4096);
  bounded(maxPairs, "maxPairs", 4096);
  if (typeof includeWilderness !== "boolean") throw new TypeError("Invalid includeWilderness");
  const width = game.width();
  const height = game.height();
  const size = width * height;
  if (!spatial || spatial.width !== width || spatial.height !== height ||
      spatial.waterByTile?.length !== size || spatial.regionByTile?.length !== size ||
      !Number.isInteger(spatial.player_id)) {
    throw new Error("Naval analysis needs a matching spatial snapshot");
  }
  if (spatial.tick !== null && typeof game.ticks === "function" &&
      game.ticks() !== spatial.tick) {
    throw new Error("Naval spatial snapshot is stale");
  }
  const playerId = spatial.player_id;
  const hasShore = typeof game.isShore === "function";
  const buffer = [0, 0, 0, 0];
  const waterIndex = new Map(spatial.waterComponents.map((water) =>
    [water.id, water.index]));
  // For each component, group own shoreline by connected own-land region.
  const sourcesByWater = new Map();
  for (const [tile, ids] of spatial.waterIdsByCoastTile) {
    if (game.ownerID(tile) !== playerId || !game.isLand(tile) ||
        game.isImpassable(tile) || (hasShore && !game.isShore(tile))) continue;
    const sourceRegion = spatial.regionByTile[tile];
    if (!sourceRegion) continue;
    const adjacent = around(game, tile, buffer);
    const bordering = new Set();
    for (let i = 0; i < adjacent.length; i++) {
      const component = spatial.waterByTile[adjacent[i]];
      if (component) bordering.add(component);
    }
    for (const id of ids) {
      const component = waterIndex.get(id);
      if (!component || !bordering.has(component)) continue;
      let regions = sourcesByWater.get(component);
      if (!regions) sourcesByWater.set(component, regions = new Map());
      let shore = regions.get(sourceRegion);
      if (!shore) {
        shore = { tile, shore_tiles: 0, source_region_id: spatial.regions[sourceRegion - 1].id };
        regions.set(sourceRegion, shore);
      }
      shore.shore_tiles++;
    }
  }

  // One terrain/owner snapshot. Water and impassable land cannot be landing
  // tiles; two islands with the same owner are different 4-connected regions.
  const owner = new Uint16Array(size);
  const passable = new Uint8Array(size);
  for (let tile = 0; tile < size; tile++) {
    if (!game.isLand(tile) || game.isImpassable(tile)) continue;
    passable[tile] = 1;
    const id = game.ownerID(tile);
    if (!Number.isInteger(id) || id < 0 || id > 4095) {
      throw new RangeError("Invalid owner ID");
    }
    owner[tile] = id;
  }
  const targetRegions = [];
  const visited = new Uint8Array(size);
  const queue = new Uint32Array(size);
  const coastGroups = [];
  for (let start = 0; start < size; start++) {
    if (!passable[start] || visited[start] || owner[start] === playerId ||
        (!includeWilderness && owner[start] === 0)) continue;
    const targetOwner = owner[start];
    const regionIndex = targetRegions.length + 1;
    const regionId = `${spatial.snapshot_id}:nr${regionIndex}`;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    const coasts = new Map();
    for (let head = 0; head < tail; head++) {
      const tile = queue[head];
      const neighboring = around(game, tile, buffer);
      for (let i = 0; i < neighboring.length; i++) {
        const next = neighboring[i];
        if (passable[next] && !visited[next] && owner[next] === targetOwner) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (hasShore && !game.isShore(tile)) continue;
      const perTile = new Set(); // a tile may touch the same body on two sides
      for (let i = 0; i < neighboring.length; i++) {
        const next = neighboring[i];
        const water = spatial.waterByTile[next];
        if (!water || !sourcesByWater.has(water) || perTile.has(water)) continue;
        perTile.add(water);
        let coast = coasts.get(water);
        if (!coast) {
          coast = { region_id: regionId, region_index: regionIndex,
            target_owner_id: targetOwner, water_index: water,
            shore_tile: tile, shore_tiles: 0 };
          coasts.set(water, coast);
        }
        coast.shore_tiles++;
      }
    }
    const region = { id: regionId, owner_id: targetOwner,
      tile_count: tail, coast_components: coasts.size };
    targetRegions.push(region);
    for (const coast of coasts.values()) coastGroups.push(coast);
  }

  // Preserve one coast sample per distinct target region before consuming the
  // rest of the budget. Candidate scoring cannot erase a whole small island
  // merely because a larger owner has more shoreline tiles.
  const firstCoastByRegion = new Map();
  for (const coast of coastGroups) {
    if (!firstCoastByRegion.has(coast.region_id)) {
      firstCoastByRegion.set(coast.region_id, coast);
    }
  }
  const orderedCoasts = [...firstCoastByRegion.values(),
    ...coastGroups.filter((coast) => firstCoastByRegion.get(coast.region_id) !== coast)];
  const sampledCoasts = orderedCoasts.slice(0, maxCoastTiles);
  const sampledRegions = new Set(sampledCoasts.map((coast) => coast.region_id));
  const eligibleRegions = new Set(coastGroups.map((coast) => coast.region_id));
  const totalEligible = coastGroups.reduce((count, coast) =>
    count + sourcesByWater.get(coast.water_index).size, 0);
  const coastBudgetPairs = sampledCoasts.reduce((count, coast) =>
    count + sourcesByWater.get(coast.water_index).size, 0);
  const pool = [];
  for (const coast of sampledCoasts) {
    for (const source of sourcesByWater.get(coast.water_index).values()) {
      if (pool.length >= maxPairs) break;
      const sourceX = source.tile % width;
      const sourceY = Math.floor(source.tile / width);
      const targetX = coast.shore_tile % width;
      const targetY = Math.floor(coast.shore_tile / width);
      pool.push({ source_region_id: source.source_region_id,
        target_region_id: coast.region_id,
        target_owner_id: coast.target_owner_id,
        target_region_tiles: targetRegions[coast.region_index - 1].tile_count,
        water_component_id: spatial.waterComponents[coast.water_index - 1].id,
        water_ocean_status: spatial.waterComponents[coast.water_index - 1].ocean_status,
        source_shore_tile: source.tile, target_shore_tile: coast.shore_tile,
        source_shore_tiles: source.shore_tiles,
        target_shore_tiles: coast.shore_tiles,
        // Manhattan separation of sample shores, NOT a water-path estimate;
        // the engine may use a different movement graph or diagonal steps.
        water_span_estimate_tiles: Math.abs(sourceX - targetX) +
          Math.abs(sourceY - targetY),
        water_span_method: "shore_manhattan_separation_not_water_path",
        status: "geometric_only_not_engine_legal" });
    }
  }
  const selected = [];
  const selectedIndexes = new Set();
  const take = (index) => {
    if (index !== undefined && !selectedIndexes.has(index) &&
        selected.length < maxCandidates) {
      selectedIndexes.add(index);
      selected.push({ id: `${spatial.snapshot_id}:n${index + 1}`, ...pool[index] });
    }
  };
  const distinct = (keyOf) => {
    const first = new Map();
    for (let i = 0; i < pool.length; i++) {
      const key = keyOf(pool[i]);
      if (!first.has(key)) first.set(key, i);
    }
    for (const index of first.values()) take(index);
  };
  distinct((c) => c.target_owner_id);
  distinct((c) => c.target_region_id);
  distinct((c) => c.water_component_id);
  distinct((c) => c.source_region_id);
  for (let i = 0; i < pool.length; i++) take(i);
  const reasons = {
    coast_budget_unexamined: totalEligible - coastBudgetPairs,
    pair_budget_unexamined: coastBudgetPairs - pool.length,
    shortlist_limit: pool.length - selected.length,
  };
  return { snapshot_id: spatial.snapshot_id, tick: spatial.tick,
    map_id: spatial.map_id, player_id: playerId,
    candidates: selected, total_eligible: totalEligible,
    omitted_count: totalEligible - selected.length,
    reasons,
    coast: { source_water_components: sourcesByWater.size,
      eligible_target_owner_regions: eligibleRegions.size,
      coast_budget_truncated_owner_regions:
        eligibleRegions.size - sampledRegions.size,
      eligible_region_component_coasts: coastGroups.length,
      sampled_region_component_coasts: sampledCoasts.length,
      eligible_coast_contacts: coastGroups.reduce((n, c) => n + c.shore_tiles, 0),
      sample_budget: maxCoastTiles,
      shore_source: hasShore ? "isShore_and_water_adjacency" : "water_adjacency_only",
    },
    certainty: "Full-resolution cardinal water contact only; engine transport legality, naval path and combat safety unverified" };
}
