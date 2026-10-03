// OFFLINE historical intent replay + exact post-hoc geometry, NOT a new policy
// or live model game. Never calls runFocusedEurope, Start, Jev or any provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFocusedEuropeWorld } from "./benchmark-focused-europe.mts";
import { observeCore } from "./benchmark-jev-observation.mjs";
import { summarizeBorders } from "../web/game-adapter.js";

const INPUT = "logs/jev-focused-europe-easy-v451-first90.json";
const OUTPUT = "logs/recorded-wilderness.json";
const MAX_MAP_TILES = 4_200_000;
const EXPECTED_FINAL_TICK = 901;
const EXPECTED_FINAL_HASH = 1839361844077469;
const EXPECTED_TAPE_SHA = "03aed19621b721dea58b4b1b8baff6e83068ab07077d5ce9b4e6231cfe5f9b4c";
const sha = (data: any) => createHash("sha256").update(data).digest("hex");
const addTerrain = (hist: Record<string, number>, terrain: string) => {
  hist[terrain] = (hist[terrain] ?? 0) + 1;
};

// Complete full-map classification, then BFS of every owner-0 passable-land
// component containing a cardinal neighbor of one of OUR owned tiles.
// No diagonals, water, impassable, other-owned or through-our-land shortcuts.
export function scanWilderness(game: any, human: any, gameId: string,
  terrainNames: Record<string, string> | null = null) {
  const tick = game.ticks(), width = game.width(), height = game.height();
  const terrainLabel = (tile: number) => {
    const value = game.terrainType(tile);
    const label = terrainNames === null ? String(value) : terrainNames[String(value)];
    if (typeof label !== "string") throw new Error("Unknown source terrain type");
    return label;
  };
  const area = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || !Number.isSafeInteger(area) || area > MAX_MAP_TILES)
    throw new Error("Full-map scan rejected: exceeds 4.2M tile bound");
  const eligible = new Uint8Array(area);
  const isSeed = new Uint8Array(area);
  const labels = new Uint32Array(area);
  const queue = new Uint32Array(area);
  const seeds: number[] = [];
  const allNeutralTerrain: Record<string, number> = {};
  const totals = { owner0_all_tiles: 0, owner0_land_tiles: 0,
    owner0_impassable_land_tiles: 0, owner0_passable_land_tiles: 0 };
  const owned: number[] = [];
  for (let tile = 0; tile < area; tile++) {
    const owner = game.ownerID(tile);
    if (owner === human.smallID()) owned.push(tile);
    if (owner !== 0) continue;
    totals.owner0_all_tiles++;
    if (!game.isLand(tile)) continue;
    totals.owner0_land_tiles++;
    if (game.isImpassable(tile)) { totals.owner0_impassable_land_tiles++; continue; }
    totals.owner0_passable_land_tiles++;
    eligible[tile] = 1;
    addTerrain(allNeutralTerrain, terrainLabel(tile));
  }
  assert.equal(owned.length, human.numTilesOwned(), "Full-map owned-tile count mismatch");
  const nbuf = [0, 0, 0, 0];
  const edges = { total_edges: 0, wilderness_edges: 0, player_edges: 0,
    water_edges: 0, blocked_edges: 0 };
  for (const tile of owned) {
    const n = game.neighbors4(tile, nbuf);
    edges.blocked_edges += 4 - n; // outward map edges
    for (let k = 0; k < n; k++) {
      const neighbor = nbuf[k];
      if (game.ownerID(neighbor) === human.smallID()) continue;
      if (!game.isLand(neighbor)) edges.water_edges++;
      else if (game.isImpassable(neighbor)) edges.blocked_edges++;
      else if (eligible[neighbor]) {
        edges.wilderness_edges++;
        if (!isSeed[neighbor]) { isSeed[neighbor] = 1; seeds.push(neighbor); }
      } else edges.player_edges++;
    }
  }
  edges.total_edges = edges.wilderness_edges + edges.player_edges +
    edges.water_edges + edges.blocked_edges;
  const adapterBorder = summarizeBorders(game, human.smallID(), human.borderTiles()).border;
  assert.deepEqual(edges, adapterBorder, "Independent cardinals differ from raw adapter edges");
  seeds.sort((a, b) => a - b);
  const components: any[] = [];
  const reachableTerrain: Record<string, number> = {};
  let reachable = 0;
  for (const seed of seeds) {
    if (labels[seed]) continue;
    const label = components.length + 1;
    let head = 0, tail = 1;
    queue[0] = seed; labels[seed] = label;
    const seedRefs: number[] = [];
    const terrain: Record<string, number> = {};
    let minX = width, minY = height, maxX = -1, maxY = -1;
    while (head < tail) {
      const tile = queue[head++];
      const x = game.x(tile), y = game.y(tile);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      addTerrain(terrain, terrainLabel(tile));
      addTerrain(reachableTerrain, terrainLabel(tile));
      if (isSeed[tile]) seedRefs.push(tile);
      const n = game.neighbors4(tile, nbuf);
      for (let k = 0; k < n; k++) {
        const neighbor = nbuf[k];
        if (!eligible[neighbor] || labels[neighbor]) continue;
        labels[neighbor] = label;
        if (tail >= area) throw new Error("BFS queue overflow");
        queue[tail++] = neighbor;
      }
    }
    reachable += tail;
    seedRefs.sort((a, b) => a - b);
    components.push({ id: label, tiles: tail, seed_count: seedRefs.length,
      seed_refs: seedRefs, terrain_histogram: terrain,
      bounds: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY } });
  }
  const seedPoints = seeds.map((tile) => ({ tile, x: game.x(tile), y: game.y(tile),
    component_id: labels[tile] }));
  assert.equal(components.reduce((n, c) => n + c.seed_count, 0), seeds.length);
  assert.equal(Object.values(reachableTerrain).reduce((a, b) => a + b, 0), reachable);
  assert.ok(reachable <= totals.owner0_passable_land_tiles);
  assert.equal(game.ticks(), tick, "Geometry source changed while scanning");
  return { source_stamp: { game_id: gameId, player_id: human.id(),
    player_small_id: human.smallID(), snapshot_tick: tick,
    method: "full-map-owner0-passable-land-cardinal-components-from-our-border",
    complete: true, sampled: false, max_map_tiles: MAX_MAP_TILES,
    inspected_map_tiles: area, width, height },
    own_tiles: owned.length, raw_border_edges: edges,
    map_unclaimed: totals, map_unclaimed_passable_terrain: allNeutralTerrain,
    distinct_border_seed_tiles: seeds.length, all_border_seed_tiles: seedPoints,
    reachable_component_count: components.length, reachable_passable_tiles: reachable,
    unreachable_passable_tiles: totals.owner0_passable_land_tiles - reachable,
    reachable_terrain_histogram: reachableTerrain, components,
    interpretation: "Static cardinal reachability only; not attack-budget, ROI, future ownership or policy advice" };
}

function selfTest() {
  // Injected arrays only: no OpenFront engine game, network or provider.
  const fixture = (owner: number[], width: number, water: number[] = [],
    blocked: number[] = [], highland: number[] = []) => {
    const own = owner.flatMap((id, ref) => id === 1 ? [ref] : []);
    const game = { ticks: () => 10, width: () => width, height: () => owner.length / width,
      ownerID: (t: number) => owner[t], isLand: (t: number) => !water.includes(t),
      isImpassable: (t: number) => blocked.includes(t),
      terrainType: (t: number) => highland.includes(t) ? "Highland" : "Plains",
      x: (t: number) => t % width, y: (t: number) => Math.floor(t / width),
      ref: (x: number, y: number) => y * width + x,
      neighbors: (t: number) => [t - width, t + width,
        t % width > 0 ? t - 1 : -1, t % width < width - 1 ? t + 1 : -1]
        .filter((n) => n >= 0 && n < owner.length),
      neighbors4(t: number, out: number[]) { const ns = this.neighbors(t);
        ns.forEach((n, i) => out[i] = n); return ns.length; } };
    const human = { smallID: () => 1, id: () => "fixture-human",
      numTilesOwned: () => own.length, borderTiles: () => own };
    return { game, human, scan: () => scanWilderness(game, human, "fixture") };
  };
  const f = fixture([1, 0, 2, 0, 0, 1, 0, 2, 0, 0, 1, 1, 2, 0, 0], 5, [], [9], [6]);
  const scan = f.scan();
  assert.equal(scan.distinct_border_seed_tiles, 2);
  assert.equal(scan.raw_border_edges.wilderness_edges, 3); // duplicate seeds don't duplicate area
  assert.equal(scan.reachable_passable_tiles, 2);
  assert.deepEqual(scan.reachable_terrain_histogram, { Plains: 1, Highland: 1 });
  assert.equal(scan.map_unclaimed.owner0_passable_land_tiles, 7);
  assert.equal(scan.unreachable_passable_tiles, 5);
  assert.deepEqual(scan.components[0].seed_refs, [1, 6]);
  const split = fixture([1, 0, 2, 0, 2, 0, 2, 0, 0], 3, [5]);
  assert.equal(split.scan().reachable_component_count, 2);
  assert.equal(split.scan().reachable_passable_tiles, 2); // no diagonal shortcut
  assert.equal(split.scan().unreachable_passable_tiles, 2);
  const wet = fixture([1, 0, 2, 0, 2, 0, 2, 0, 0], 3, [1, 5]).scan();
  assert.equal(wet.reachable_passable_tiles, 1);
  assert.equal(wet.raw_border_edges.water_edges, 1);
  assert.equal(wet.map_unclaimed.owner0_land_tiles, 3);
  const originSeed = fixture([0, 1], 2).scan();
  assert.deepEqual(originSeed.components[0].seed_refs, [0]);
  assert.equal(originSeed.all_border_seed_tiles[0].tile, 0);
  assert.equal(originSeed.reachable_passable_tiles, 1);
  const huge = { ...f.game, width: () => 4_200_001, height: () => 1 };
  assert.throws(() => scanWilderness(huge, f.human, "fixture"), /4.2M/);
  assert.equal(fixture(Array(15).fill(1), 5).scan().reachable_passable_tiles, 0);
  console.log("Recorded wilderness exact-scan injected-array checks passed");
}

export async function replayRecordedWilderness() {
  const bytes = await readFile(INPUT);
  assert.equal(sha(bytes), EXPECTED_TAPE_SHA, "Historical input tape changed; no replay authorized");
  const tape = JSON.parse(bytes.toString("utf8"));
  assert.equal(tape.mode, "live");
  assert.equal(tape.policy, "land-strategy-v4.5.1-reference-clock-clarity");
  assert.equal(tape.config.seed, "europe-focus-001");
  assert.equal(tape.before.tick, 3);
  assert.equal(tape.after.tick, EXPECTED_FINAL_TICK);
  assert.equal(tape.after.hash, EXPECTED_FINAL_HASH);
  assert.equal(tape.config.minutes, 5);
  assert.equal(tape.decisions.length, 90);
  assert.equal(tape.emitted_intents.length, 11);
  const intentsByTick = new Map<number, any[]>();
  for (const item of tape.emitted_intents) {
    assert.ok(Number.isSafeInteger(item.submitted_tick) &&
      item.submitted_tick > tape.before.tick && item.submitted_tick <= EXPECTED_FINAL_TICK);
    assert.equal(item.type, "attack");
    assert.equal(item.clientID, "human-client");
    assert.ok(item.targetID === null || typeof item.targetID === "string");
    assert.ok(Number.isSafeInteger(item.troops) && item.troops > 0);
    const { submitted_tick, ...intent } = item;
    assert.deepEqual(Object.keys(intent).sort(), ["clientID", "targetID", "troops", "type"]);
    const list = intentsByTick.get(submitted_tick) ?? [];
    list.push(intent); intentsByTick.set(submitted_tick, list);
  }
  const decisionByTick = new Map<number, any>();
  const choices: Record<string, number> = {};
  for (const record of tape.decisions) {
    assert.ok(!decisionByTick.has(record.tick));
    decisionByTick.set(record.tick, record);
    choices[record.selected_id] = (choices[record.selected_id] ?? 0) + 1;
    const emitted = intentsByTick.get(record.tick + 1) ?? [];
    assert.equal(emitted.length, record.selected_id === "wait" ? 0 : 1,
      "Recorded non-wait answers must correspond to their submitted normal intent");
  }
  assert.equal(choices.wait, 79);
  assert.ok(decisionByTick.has(891));
  const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
  const { TerrainType } = await import(pathToFileURL(resolve(root, "src/core/game/Game.ts")).href);
  const world = await createFocusedEuropeWorld({ seed: tape.config.seed,
    minutes: tape.config.minutes }, { paceTick: async () => 0 });
  assert.deepEqual(world.metadata, tape.metadata, "Native roster/config/metadata drift");
  const { game, human } = world;
  assert.deepEqual({ tick: game.ticks(), tiles: human.numTilesOwned(),
    troops_internal: human.troops(), gold: human.gold().toString() }, tape.before);
  const captures: any[] = [];
  let verifiedInputs = 0, replayedIntents = 0;
  const captureAndCheck = () => {
    const record = decisionByTick.get(game.ticks());
    if (record) {
      // Compare historical physical fields, not later schema additions or
      // current menu/policy criteria. No current Choice is requested/executed.
      const now = observeCore(game, human).observation;
      for (const field of ["self", "border", "neighbors", "incoming_attacks", "outgoing_attacks"])
        assert.deepEqual(now[field], record.observation[field],
          `Historical ${field} diverged at input tick ${game.ticks()}`);
      verifiedInputs++;
    }
    if (game.ticks() === 891 || game.ticks() === EXPECTED_FINAL_TICK) {
      const scan = scanWilderness(game, human, tape.config.seed, TerrainType);
      if (record) assert.deepEqual(scan.raw_border_edges, record.observation.border);
      captures.push({ ...scan, engine_hash_at_snapshot: game.hash(),
        human_reserve_internal: human.troops(), human_gold: human.gold().toString(),
        historical_model_input: record ? { tick: record.tick,
          selected_id: record.selected_id, border: record.observation.border } : null });
    }
  };
  captureAndCheck();
  while (game.ticks() < EXPECTED_FINAL_TICK) {
    const intents = intentsByTick.get(game.ticks() + 1) ?? [];
    replayedIntents += intents.length;
    await world.step(intents); // ONLY historical normal intents, else empty turn
    captureAndCheck();
  }
  const after = { tick: game.ticks(), seconds: game.elapsedGameSeconds(),
    liveTicks: game.ticks() - tape.before.tick, hash: game.hash(), alive: human.isAlive(),
    tiles: human.numTilesOwned(), troops_internal: human.troops(), gold: human.gold().toString() };
  assert.deepEqual(after, tape.after, "Historical final engine state/hash mismatch");
  assert.deepEqual(world.events.conquests, tape.conquests, "Historical conquest event drift");
  assert.equal(world.events.winEvents, tape.engine_win_events);
  assert.equal(verifiedInputs, 90);
  assert.equal(replayedIntents, tape.emitted_intents.length);
  assert.equal(captures.length, 2);
  const assets: Record<string, string> = {};
  for (const name of ["map4x.bin", "map16x.bin", "manifest.json"])
    assets[name] = sha(await readFile(resolve(root, "resources/maps/europe", name)));
  const result = { schema_version: 1,
    label: "historical-real-Jev-normal-intent-replay-plus-posthoc-geometry",
    model_calls_this_analysis: 0, new_policy_choices: 0, heldout_seeds_used: 0,
    input: { file: INPUT, sha256: sha(bytes), policy: tape.policy,
      historical_decisions: 90, historical_choice_counts: choices },
    reproduction: { verified: true, metadata_and_roster_equal: true,
      historical_physical_inputs_equal: verifiedInputs,
      normal_intents_replayed: replayedIntents, final: after,
      conquests_equal: true, win_events_equal: true },
    metadata: world.metadata, asset_sha256: assets, snapshots: captures,
    caveats: ["Historical action replay, not a new Jev game or strategy result.",
      "Native AI still executes normally; only the human's recorded intents are replayed.",
      "Geometry describes only ticks 891 and 901, not causes of all 79 waits.",
      "Cardinal neutral reachability is a static upper bound, not guaranteed capture, ROI or enough attack troops.",
      "All map cells classified exactly under 4.2M bound; no sampling. Not a deployed observation or model override."] };
  await mkdir("logs", { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n");
  console.log(`Historical replay hash ${after.hash} at tick ${after.tick} verified; ${verifiedInputs} inputs matched`);
  for (const s of captures) console.log(`tick ${s.source_stamp.snapshot_tick}: ` +
    `${s.raw_border_edges.wilderness_edges} wilderness edges / ${s.distinct_border_seed_tiles} distinct seeds; ` +
    `${s.reachable_component_count} components / ${s.reachable_passable_tiles} reachable neutral tiles; ` +
    `${s.map_unclaimed.owner0_passable_land_tiles} global unclaimed passable land`);
  console.log(`Saved ignored ${OUTPUT}`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") selfTest();
  else if (args.length === 1 && args[0] === "--replay") await replayRecordedWilderness();
  else throw new Error("Choose explicit --self-test or --replay; no live/provider mode exists");
}
