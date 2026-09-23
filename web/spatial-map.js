// Read-only, snapshot-scoped geometry for future placement studies. This module
// does not call a worker, establish build legality, send an intent, or expose a
// new observation to Jev. Call it explicitly on a chosen GameView snapshot;
// never rebuild a full map on the one-second decision loop.
let nextSnapshot = 1;

function dimensions(game) {
  const width = game.width();
  const height = game.height();
  const size = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 ||
      height < 1 || !Number.isSafeInteger(size) || size > 0x7fffffff) {
    throw new RangeError("Invalid spatial-map dimensions");
  }
  return { width, height, size };
}

function neighbors(game, tile, buffer) {
  if (typeof game.neighbors4 === "function") {
    // The engine requires a buffer with length >= 4 on EVERY call, including
    // after an edge tile returned only two neighbors on the previous call.
    buffer.length = 4;
    const count = game.neighbors4(tile, buffer);
    buffer.length = count;
    return buffer;
  }
  return game.neighbors(tile);
}

function spreadDistances(game, owned, size, seedTiles) {
  const distances = new Int32Array(size).fill(-1);
  const nearest = new Int32Array(size);
  const queue = new Uint32Array(size);
  const buffer = [0, 0, 0, 0];
  let tail = 0;
  for (const [tile, front] of seedTiles) {
    if (distances[tile] !== -1) continue;
    distances[tile] = 0;
    nearest[tile] = front;
    queue[tail++] = tile;
  }
  for (let head = 0; head < tail; head++) {
    const tile = queue[head];
    const around = neighbors(game, tile, buffer);
    for (let i = 0; i < around.length; i++) {
      const adjacent = around[i];
      if (!owned[adjacent] || distances[adjacent] !== -1) continue;
      distances[adjacent] = distances[tile] + 1;
      nearest[adjacent] = nearest[tile];
      queue[tail++] = adjacent;
    }
  }
  return { distances, nearest };
}

/**
 * Minimal GameView facade: width(), height(), ref(x,y), ownerID(tile),
 * isLand(tile), isImpassable(tile), neighbors(tile) or neighbors4(tile,out).
 * Optional isWater(tile) and isOcean(tile) improve provenance/classification.
 * Tile refs must be GameView's row-major integer refs (y * width + x).
 * Returns a private code-side snapshot, NOT an observation or legal site list.
 */
export function analyzeSpatialMap(game, playerId, { tick = null, mapId = "map" } = {}) {
  const { width, height, size } = dimensions(game);
  if (!Number.isInteger(playerId) || playerId < 1 || playerId > 4095) {
    throw new RangeError("Invalid player ID");
  }
  if (tick !== null && (!Number.isInteger(tick) || tick < 0)) {
    throw new RangeError("Invalid tick");
  }
  const snapshot_id = `${String(mapId)}@${tick ?? "?"}#${nextSnapshot++}`;
  const owner = new Uint16Array(size);
  const owned = new Uint8Array(size);
  const water = new Uint8Array(size);
  const passable = new Uint8Array(size);
  const ocean = new Uint8Array(size);
  const ownedTiles = [];
  const hasWater = typeof game.isWater === "function";
  const hasOcean = typeof game.isOcean === "function";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = game.ref(x, y);
      if (tile !== y * width + x) throw new Error("Expected GameView row-major refs");
      const isLand = game.isLand(tile);
      water[tile] = Number(hasWater ? game.isWater(tile) : !isLand);
      passable[tile] = Number(isLand && !game.isImpassable(tile));
      if (water[tile] && hasOcean) ocean[tile] = Number(game.isOcean(tile));
      const id = game.ownerID(tile);
      if (!Number.isInteger(id) || id < 0 || id > 4095) throw new RangeError("Invalid tile owner");
      owner[tile] = id;
      if (passable[tile] && id === playerId) {
        owned[tile] = 1;
        ownedTiles.push(tile);
      }
    }
  }

  const queue = new Uint32Array(size);
  const buffer = [0, 0, 0, 0];
  const regionByTile = new Int32Array(size);
  const regions = [];
  for (const start of ownedTiles) {
    if (regionByTile[start]) continue;
    const index = regions.length + 1;
    regionByTile[start] = index;
    let tail = 1;
    queue[0] = start;
    for (let head = 0; head < tail; head++) {
      const around = neighbors(game, queue[head], buffer);
      for (let i = 0; i < around.length; i++) {
        const n = around[i];
        if (!owned[n] || regionByTile[n]) continue;
        regionByTile[n] = index;
        queue[tail++] = n;
      }
    }
    regions.push({ id: `${snapshot_id}:r${index}`, index, tile_count: tail,
      sample_tile: start, front_ids: [] });
  }

  const waterByTile = new Int32Array(size);
  const waterComponents = [];
  for (let start = 0; start < size; start++) {
    if (!water[start] || waterByTile[start]) continue;
    const index = waterComponents.length + 1;
    waterByTile[start] = index;
    let tail = 1;
    let oceanCount = 0;
    queue[0] = start;
    for (let head = 0; head < tail; head++) {
      const tile = queue[head];
      oceanCount += ocean[tile];
      const around = neighbors(game, tile, buffer);
      for (let i = 0; i < around.length; i++) {
        const n = around[i];
        if (!water[n] || waterByTile[n]) continue;
        waterByTile[n] = index;
        queue[tail++] = n;
      }
    }
    waterComponents.push({ id: `${snapshot_id}:w${index}`, index,
      tile_count: tail, sample_tile: start,
      ocean_status: !hasOcean ? "unknown" : oceanCount ? "ocean" : "inland",
      mixed_ocean_flags: hasOcean && oceanCount > 0 && oceanCount < tail });
  }

  // One entry per owned boundary tile and *contact label*, preserving separate
  // opposing players, wilderness, blocked terrain and water bodies. A tile may
  // touch several labels. Four-connected components of these tiles are arcs.
  const groups = new Map();
  for (const tile of ownedTiles) {
    const region = regionByTile[tile];
    const around = neighbors(game, tile, buffer);
    for (let i = 0; i < around.length; i++) {
      const n = around[i];
      if (owned[n]) continue;
      const kind = water[n] ? "water" : !passable[n] ? "blocked" :
        owner[n] === 0 ? "wilderness" : "player";
      const target = kind === "water" ? waterByTile[n] :
        kind === "player" ? owner[n] : 0;
      const key = `${region}:${kind}:${target}`;
      if (!groups.has(key)) groups.set(key, { region, kind, target, edges: new Map() });
      const edges = groups.get(key).edges;
      edges.set(tile, (edges.get(tile) ?? 0) + 1);
    }
  }
  const fronts = [];
  const waterIdsByCoastTile = new Map();
  const landSeeds = [];
  const playerSeeds = [];
  for (const { region, kind, target, edges } of groups.values()) {
    const seen = new Set();
    for (const start of edges.keys()) {
      if (seen.has(start)) continue;
      const index = fronts.length + 1;
      const tiles = [];
      let edge_count = 0;
      let head = 0;
      tiles.push(start);
      seen.add(start);
      while (head < tiles.length) {
        const tile = tiles[head++];
        edge_count += edges.get(tile);
        const around = neighbors(game, tile, buffer);
        for (let i = 0; i < around.length; i++) {
          const n = around[i];
          if (!edges.has(n) || seen.has(n)) continue;
          seen.add(n);
          tiles.push(n);
        }
      }
      const front = { id: `${snapshot_id}:f${index}`, index,
        region_id: regions[region - 1].id, kind,
        target_id: kind === "water" ? waterComponents[target - 1].id :
          kind === "player" ? target : null,
        edge_count, tiles };
      fronts.push(front);
      regions[region - 1].front_ids.push(front.id);
      if (kind === "water") {
        for (const tile of tiles) {
          const ids = waterIdsByCoastTile.get(tile) ?? [];
          if (!ids.includes(front.target_id)) ids.push(front.target_id);
          waterIdsByCoastTile.set(tile, ids);
        }
      } else if (kind === "wilderness" || kind === "player") {
        for (const tile of tiles) landSeeds.push([tile, index]);
        if (kind === "player") for (const tile of tiles) playerSeeds.push([tile, index]);
      }
    }
  }
  const land = spreadDistances(game, owned, size, landSeeds);
  const player = spreadDistances(game, owned, size, playerSeeds);
  return { snapshot_id, tick, map_id: String(mapId), player_id: playerId,
    width, height, ownedTiles, regionByTile, regions,
    waterByTile, waterComponents, fronts, waterIdsByCoastTile,
    landBorderDistanceByTile: land.distances,
    playerBorderDistanceByTile: player.distances,
    nearestLandFrontByTile: land.nearest,
    water_source: hasWater ? "isWater" : "derived_from_isLand",
    ocean_source: hasOcean ? "isOcean" : "unavailable" };
}

function nonnegativeInteger(value, name, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`Invalid ${name}`);
  }
  return value;
}

/**
 * Pure geometric PREFILTER; buildability/cost/defense effects are unknown.
 * `existingSites` are tile refs whose geometric discs already cover own land.
 * Only `maxExamined` sites have their marginal coverage measured; omissions are
 * explicitly counted. `siteKind: "coast"` means cardinally adjacent to water,
 * not necessarily port-legal or navigable. Candidate IDs only resolve in this
 * analysis instance and must be revalidated against the live worker later.
 */
export function prefilterPlacementSites(analysis, {
  existingSites = [], coverageRadius = 6, maxCandidates = 24,
  maxExamined = 4096, siteKind = "any",
} = {}) {
  const { width, height, ownedTiles, regionByTile, regions, fronts,
    waterIdsByCoastTile, landBorderDistanceByTile, playerBorderDistanceByTile,
    nearestLandFrontByTile, snapshot_id } = analysis;
  const size = width * height;
  nonnegativeInteger(coverageRadius, "coverageRadius", Math.max(width, height));
  nonnegativeInteger(maxCandidates, "maxCandidates", 512);
  nonnegativeInteger(maxExamined, "maxExamined", 65536);
  if (!Array.isArray(existingSites) || !["any", "coast", "interior"].includes(siteKind)) {
    throw new TypeError("Invalid placement options");
  }
  // Restrict to owned passable land already collected by the topology pass.
  const eligible = ownedTiles.filter((t) => siteKind === "any" ||
    (siteKind === "coast") === waterIdsByCoastTile.has(t));
  const budget = Math.min(maxExamined, eligible.length);
  const sampled = new Set();
  const eligibleSet = new Set(eligible);
  const add = (tile) => {
    if (sampled.size < budget && eligibleSet.has(tile)) sampled.add(tile);
  };
  // Guarantee topological anchors before even grid sampling where the budget
  // permits; tiny disconnected territories and small lakes should not vanish.
  const firstInRegion = new Map();
  for (const tile of eligible) {
    const region = regionByTile[tile];
    if (!firstInRegion.has(region)) firstInRegion.set(region, tile);
  }
  for (const region of regions) add(firstInRegion.get(region.index));
  const seenWater = new Set();
  for (const tile of eligible) {
    for (const id of waterIdsByCoastTile.get(tile) ?? []) {
      if (seenWater.has(id)) continue;
      seenWater.add(id);
      add(tile);
    }
  }
  for (const front of fronts) {
    for (const tile of front.tiles) {
      if (eligibleSet.has(tile)) { add(tile); break; }
    }
  }
  for (let i = 0; sampled.size < budget && i < budget * 2 + 1; i++) {
    add(eligible[Math.floor((i + 0.5) * eligible.length / (budget * 2 + 1))]);
  }
  // If anchors overlap the regular samples, fill to budget deterministically.
  for (let i = 0; sampled.size < budget && i < eligible.length; i++) add(eligible[i]);

  // Row-prefix sum of uncovered owned land. Each existing site contributes
  // circle row intervals; candidate coverage then costs O(radius), not O(area).
  const stride = width + 1;
  const difference = new Int32Array(stride * height);
  for (const site of existingSites) {
    nonnegativeInteger(site, "existing site ref", size - 1);
    const x = site % width;
    const y = Math.floor(site / width);
    for (let dy = -coverageRadius; dy <= coverageRadius; dy++) {
      const row = y + dy;
      if (row < 0 || row >= height) continue;
      const dx = Math.floor(Math.sqrt(coverageRadius ** 2 - dy ** 2));
      const left = Math.max(0, x - dx);
      const right = Math.min(width - 1, x + dx);
      difference[row * stride + left]++;
      difference[row * stride + right + 1]--;
    }
  }
  const prefix = new Uint32Array(stride * height);
  for (let y = 0; y < height; y++) {
    let covered = 0;
    let count = 0;
    for (let x = 0; x < width; x++) {
      covered += difference[y * stride + x];
      if (!covered && regionByTile[y * width + x]) count++;
      prefix[y * stride + x + 1] = count;
    }
  }
  const coverage = (tile) => {
    const x = tile % width;
    const y = Math.floor(tile / width);
    let count = 0;
    for (let dy = -coverageRadius; dy <= coverageRadius; dy++) {
      const row = y + dy;
      if (row < 0 || row >= height) continue;
      const dx = Math.floor(Math.sqrt(coverageRadius ** 2 - dy ** 2));
      const offset = row * stride;
      count += prefix[offset + Math.min(width, x + dx + 1)] -
        prefix[offset + Math.max(0, x - dx)];
    }
    return count;
  };
  const examined = [...sampled].map((tile) => {
    const front = fronts[nearestLandFrontByTile[tile] - 1];
    return { id: `${snapshot_id}:site${tile}`, tile,
      region_id: regions[regionByTile[tile] - 1].id,
      front_id: front?.id ?? null,
      water_ids: waterIdsByCoastTile.get(tile) ?? [],
      distance_to_land_border: landBorderDistanceByTile[tile],
      distance_to_player_border: playerBorderDistanceByTile[tile],
      marginal_coverage_tiles: coverage(tile) };
  });
  const better = (a, b) => b.marginal_coverage_tiles - a.marginal_coverage_tiles ||
    b.distance_to_player_border - a.distance_to_player_border || a.tile - b.tile;
  examined.sort(better);
  const selected = [];
  const chosen = new Set();
  const take = (candidate) => {
    if (candidate && selected.length < maxCandidates && !chosen.has(candidate.tile)) {
      chosen.add(candidate.tile);
      selected.push(candidate);
    }
  };
  const chooseGroups = (keyOf) => {
    const groups = new Map();
    for (const candidate of examined) {
      for (const key of keyOf(candidate)) {
        if (!groups.has(key)) groups.set(key, candidate);
      }
    }
    for (const candidate of groups.values()) take(candidate);
  };
  chooseGroups((c) => [c.region_id]);
  chooseGroups((c) => c.water_ids);
  chooseGroups((c) => c.front_id ? [c.front_id] : []);
  chooseGroups((c) => [c.distance_to_land_border < 0 ? "landlocked" :
    c.distance_to_land_border <= 2 ? "front" :
      c.distance_to_land_border <= 6 ? "middle" : "deep"]);
  for (const candidate of examined) take(candidate);
  return { snapshot_id, candidates: selected,
    total_eligible: eligible.length, total_examined: examined.length,
    omitted_count: eligible.length - selected.length,
    reasons: { not_examined: eligible.length - examined.length,
      shortlist_limit: examined.length - selected.length },
    coverage_model: "Euclidean tile disc over owned passable land; geometric only" };
}
