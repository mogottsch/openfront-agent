import assert from "node:assert/strict";
import test from "node:test";
import { observeCore } from "../scripts/benchmark-jev-observation.mjs";
import { createHybridEuropeFacade, parseHybridEuropeArgs, prepareCitySeam,
  mockCitySeamDecision, submitCitySeamDecision, runMockHybridCity,
} from "../scripts/benchmark-hybrid-europe.mts";

// Synthetic CORE-shaped objects, not GameView fakes. Tests require the facade
// to translate Attack methods, preserve receivers and use worker coordinates.
function fixture({ gold = 400000n, withAttacks = false } = {}) {
  let tick = 100;
  let wallet = gold;
  let cost = 125000n;
  let workerHook = () => {};
  const owner = new Uint16Array(64).fill(1);
  const cities = [];
  const events = { conquests: [], winEvents: 0, wireWinner: null };
  const calls = [];
  const unit = (tile, construction = true) => ({
    pos: tile, construction, remaining: 20,
    id: () => 1, tile() { return this.pos; }, level: () => 1,
    isActive: () => true, isUnderConstruction() { return this.construction; },
    owner: () => human, type: () => "City",
  });
  const other = { id: () => "other-core", smallID: () => 2, type: () => "BOT",
    isPlayer: () => true, isAlive: () => true, troops: () => 31000,
    numTilesOwned: () => 0, incomingAttacks: () => [] };
  const attack = { id: () => "observed1", attacker: () => other,
    target: () => human, troops: () => 19720.8, retreating: () => false };
  const human = {
    id: () => "human-core", smallID: () => 1, type: () => "HUMAN",
    isPlayer: () => true, isAlive: () => true, hasSpawned: () => true,
    gold: () => wallet, troops: () => 100000, numTilesOwned: () => 64,
    units(type) { assert.equal(this, human); assert.equal(type, "City"); return cities; },
    incomingAttacks: () => withAttacks ? [attack] : [], outgoingAttacks: () => [],
    isOnSameTeam: () => false,
    isAlliedWith: (o) => { assert(o === human || o === other); return false; },
    isFriendly: (o) => { assert(o === human || o === other); return false; },
    borderTiles: () => new Set(),
  };
  const game = { width: () => 8, height: () => 8,
    ref: (x, y) => y * 8 + x, x: (t) => t % 8, y: (t) => Math.floor(t / 8),
    isValidRef: (t) => Number.isInteger(t) && t >= 0 && t < 64,
    ownerID: (t) => owner[t], isLand: () => true, isImpassable: () => false,
    ticks: () => tick, getWinner: () => null, inSpawnPhase: () => false,
    hash: () => tick,
    playerBySmallID: (id) => id === 1 ? human : other,
    neighbors: (t) => [t >= 8 ? t - 8 : null, t < 56 ? t + 8 : null,
      t % 8 > 0 ? t - 1 : null, t % 8 < 7 ? t + 1 : null].filter((n) => n !== null),
  };
  const config = { cityTroopIncrease: () => 250000,
    unitInfo: () => ({ constructionDuration: 20 }),
    maxTroops: () => 500000 + cities.filter((u) => !u.isUnderConstruction()).length * 250000 };
  game.config = () => config;
  const runner = {
    playerBuildables: (id, x, y, types) => {
      calls.push({ id, x, y, types });
      workerHook();
      return [{ type: "City", cost, canUpgrade: false,
        canBuild: wallet >= cost ? game.ref(x, y) : false }];
    },
    playerActions: (_id, x, y, types) => ({ canAttack: false, buildableUnits: [] }),
    playerBorderTiles: () => ({ borderTiles: new Set() }),
  };
  const world = { game, human, runner, config, UnitType: { City: "City" }, events,
    clientID: "human-client", metadata: { engineCommit: "synthetic-test-only", roster: [] },
    read: () => ({ tick, ready: true, ended: false }),
    step: async (intents) => {
      tick++;
      for (const city of cities) {
        if (city.remaining-- === 0) city.construction = false;
      }
      for (const i of intents) {
        assert.equal(i.type, "build_unit");
        assert.equal(i.unit, "City");
        cities.push(unit(i.tile));
        wallet -= cost;
      }
    } };
  return { world, calls, cities, owner, attack, other,
    setGold: (g) => { wallet = g; }, setCost: (c) => { cost = c; },
    advance: () => { tick++; }, setWorkerHook: (fn) => { workerHook = fn; } };
}

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

const options = parseHybridEuropeArgs(["--mock", "--max-ticks", "30"]);

test("first seam import-safe mock only; live and oversized run rejected before setup", () => {
  assert.throws(() => parseHybridEuropeArgs([]), /Explicit/);
  assert.throws(() => parseHybridEuropeArgs(["--live", "--max-calls", "1"]), /mock only/);
  assert.throws(() => parseHybridEuropeArgs(["--mock", "--max-ticks", "101"]), /100/);
  assert.equal(options.output, "logs/benchmark-hybrid-europe-city.json");
});

test("PlayerView proxy translates core-shaped Attack objects without mutating methods", async () => {
  const f = fixture({ withAttacks: true });
  const original = f.world.human.incomingAttacks;
  const view = createHybridEuropeFacade(f.world, "test-game");
  assert.equal(view.game.myPlayer(), view.player);
  assert.equal(view.game.playerBySmallID(1), view.player);
  assert.equal(view.player.incomingAttacks()[0].retreating, false);
  assert.deepEqual(view.player.incomingAttacks()[0], { id: "observed1",
    attackerID: 2, targetID: 1, troops: 19720.8, retreating: false });
  assert.equal(f.world.human.incomingAttacks, original);
  assert.equal(f.world.human.incomingAttacks()[0], f.attack);
  assert.equal(typeof f.attack.retreating, "function");
  assert.equal(f.world.human.buildables, undefined); // no monkeypatch
  assert.equal(view.player.isFriendly(view.game.playerBySmallID(2)), false);
  await view.player.buildables(0, ["City"]);
  assert.deepEqual(f.calls[0], { id: "human-core", x: 0, y: 0, types: ["City"] });
  assert.equal(view.workerQueries[0].tile, 0);
});

test("wilderness raw AttackUpdate targetID remains zero; strict land observation normalizes null", () => {
  const f = fixture();
  const wilderness = { smallID: () => 0, id: () => "terra-nullius" };
  const attack = { id: () => "wilderness1", attacker: () => f.world.human,
    target: () => wilderness, troops: () => 2533.2, retreating: () => false };
  f.world.human.outgoingAttacks = () => [attack];
  const view = createHybridEuropeFacade(f.world, "city-test");
  assert.equal(view.player.outgoingAttacks()[0].targetID, 0);
  assert.equal(f.world.human.outgoingAttacks()[0], attack);
  assert.equal(observeCore(f.world.game, f.world.human).observation
    .outgoing_attacks[0].target_id, null);
});

test("UnitView owner identity and worker-shaped result make funded synthetic City legal", async () => {
  const f = fixture();
  const seam = await prepareCitySeam(f.world, { gameId: "city-test" });
  assert(seam.input.building.candidates.length > 0);
  assert.equal(seam.input.land.self.gold, "400000");
  assert.equal(seam.input.snapshot_tick, 100);
  assert(seam.input.building.candidates.every((c) => c.cost_gold === "125000"));
  assert.equal(seam.claims.model_calls, 0);
  const d = mockCitySeamDecision(seam);
  assert.equal(d.kind, "city");
  assert.equal(seam.queued.length, 0);
  const result = await submitCitySeamDecision(d, seam);
  assert.equal(result.submitted, true);
  assert.equal(seam.queued.length, 1);
  assert.equal(f.cities.length, 0); // queued intent is not observed construction
  await f.world.step(seam.queued.splice(0));
  assert.equal(f.cities.length, 1);
  const wrapped = seam.view.player.units("City")[0];
  assert.equal(wrapped.owner(), seam.view.player);
  assert.equal(wrapped.isUnderConstruction(), true);
});

test("underfunded worker-shaped result exposes omissions and waits without gold edits", async () => {
  const f = fixture({ gold: 100n });
  const seam = await prepareCitySeam(f.world, { gameId: "underfunded-test" });
  assert.equal(seam.input.building.available_gold, "100");
  assert.equal(seam.input.building.candidates.length, 0);
  assert(seam.input.building.omissions.not_buildable > 0);
  assert.equal(seam.request.questions.branch.criteria.city_build, undefined);
  const d = mockCitySeamDecision(seam);
  assert.equal(d.kind, "wait");
  assert.equal((await submitCitySeamDecision(d, seam)).submitted, false);
  assert.equal(seam.queued.length, 0);
  assert.equal(f.world.human.gold(), 100n);
});

test("fabricated candidate/context and changed funds/ownership fail closed without substitute", async () => {
  for (const change of ["candidate", "context", "gold", "owner", "cost"]) {
    const f = fixture();
    const seam = await prepareCitySeam(f.world, { gameId: "city-test" });
    const d = mockCitySeamDecision(seam);
    if (change === "candidate") d.candidate_id = "invented-id";
    if (change === "context") d.context.snapshot_tick = 99;
    if (change === "gold") f.setGold(100n);
    if (change === "owner") f.owner.fill(2);
    if (change === "cost") f.setCost(150000n);
    await assert.rejects(submitCitySeamDecision(d, seam), undefined, change);
    assert.equal(seam.queued.length, 0, change);
    assert.equal(f.cities.length, 0, change);
  }
});

test("Stop/generation change during final worker check cannot queue late City", async () => {
  const f = fixture();
  const seam = await prepareCitySeam(f.world, { gameId: "city-test" });
  const d = mockCitySeamDecision(seam);
  let running = true;
  let n = 0;
  // canExecute's worker result passes; execute's final worker loses generation.
  f.setWorkerHook(() => { if (++n === 2) running = false; });
  await assert.rejects(submitCitySeamDecision(d, seam, () => running), /no substitute/);
  assert.equal(seam.queued.length, 0);
});

test("synthetic engine records mock Choice, normal submission, construction and completion separately", async () => {
  const f = fixture();
  const report = await runMockHybridCity(options, { worldFactory: async () => f.world, ...clock() });
  assert.equal(report.stage, "narrow-city-only");
  assert.equal(report.mode, "mock");
  assert.equal(report.claims.model_calls, 0);
  assert.equal(report.submitted_normal_intents.length, 1);
  assert(report.observed_city_states.some((s) => s.cities[0]?.under_construction));
  assert(report.observed_city_states.some((s) => s.cities[0] && !s.cities[0].under_construction));
  assert.equal(report.before.cities.length, 0);
  assert.equal(report.observed_city_states.at(-1).troop_capacity_internal -
    report.before.troop_capacity_internal, 250000);
  assert.equal(report.complete, false);
  assert.equal(report.win, null);
  assert.equal(report.win_events, 0);
});
