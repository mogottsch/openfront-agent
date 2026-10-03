import assert from "node:assert/strict";
import test from "node:test";
import { observeCore } from "../scripts/benchmark-jev-observation.mjs";
import { createGameAdapter } from "../web/game-adapter.js";
import { POLICY_VERSION } from "../src/policy.mjs";
import { buildHybridRequest, parseHybridDecision, HYBRID_POLICY_VERSION } from "../src/hybrid-policy.mjs";
import { createHybridEuropeFacade, parseHybridEuropeArgs, prepareCitySeam,
  mockCitySeamDecision, submitCitySeamDecision, runMockHybridCity,
  parseHybridLoopArgs, runHybridEuropeLoop,
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
    numTilesOwned: () => owner.filter((id) => id === 2).length,
    name: () => "Other", gold: () => 10000n, incomingAttacks: () => [] };
  const attack = { id: () => "observed1", attacker: () => other,
    target: () => human, troops: () => 19720.8, retreating: () => false };
  const human = {
    id: () => "human-core", smallID: () => 1, type: () => "HUMAN",
    isPlayer: () => true, isAlive: () => true, hasSpawned: () => true,
    name: () => "Human", gold: () => wallet, troops: () => 100000,
    numTilesOwned: () => owner.filter((id) => id === 1).length,
    units(type) { assert.equal(this, human); assert.equal(type, "City"); return cities; },
    incomingAttacks: () => withAttacks ? [attack] : [], outgoingAttacks: () => [],
    isOnSameTeam: () => false,
    isAlliedWith: (o) => { assert(o === human || o === other); return false; },
    isFriendly: (o) => { assert(o === human || o === other); return false; },
    borderTiles: () => new Set(Array.from(owner).flatMap((id, tile) => id === 1 &&
      game.neighbors(tile).some((n) => owner[n] !== 1) ? [tile] : [])),
  };
  const game = { width: () => 8, height: () => 8,
    ref: (x, y) => y * 8 + x, x: (t) => t % 8, y: (t) => Math.floor(t / 8),
    isValidRef: (t) => Number.isInteger(t) && t >= 0 && t < 64,
    ownerID: (t) => owner[t], isLand: () => true, isImpassable: () => false,
    ticks: () => tick, elapsedGameSeconds: () => tick / 10,
    getWinner: () => events.winEvents ? human : null, inSpawnPhase: () => false,
    allPlayers: () => [human, other], hash: () => tick,
    playerBySmallID: (id) => id === 1 ? human : other,
    neighbors: (t) => [t >= 8 ? t - 8 : null, t < 56 ? t + 8 : null,
      t % 8 > 0 ? t - 1 : null, t % 8 < 7 ? t + 1 : null].filter((n) => n !== null),
  };
  const config = { cityTroopIncrease: () => 250000,
    unitInfo: () => ({ constructionDuration: 20, cost: () => cost }),
    maxTroops: () => 500000 + cities.filter((u) => !u.isUnderConstruction()).length * 250000 };
  game.config = () => config;
  const runner = {
    playerBuildables: (id, x, y, types) => {
      calls.push({ id, x, y, types });
      workerHook();
      return [{ type: "City", cost, canUpgrade: false,
        canBuild: wallet >= cost ? game.ref(x, y) : false }];
    },
    playerActions: (_id, x, y, types) => ({ canAttack: owner[game.ref(x, y)] !== 1,
      buildableUnits: [] }),
    playerBorderTiles: () => ({ borderTiles: human.borderTiles() }),
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
        if (i.type === "build_unit") {
          assert.equal(i.unit, "City");
          cities.push(unit(i.tile));
          wallet -= cost;
        } else assert.equal(i.type, "attack");
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

function loopWorld(f) {
  return async (_options, { paceTick }) => {
    const original = f.world.step;
    f.world.tickStarts = [];
    f.world.step = async (intents) => {
      f.world.tickStarts.push(await paceTick());
      await original(intents);
    };
    f.world.metadata.roster = [{ id: "other-core", type: "BOT" }];
    return f.world;
  };
}

function sidecar({ fail = null, corrupt = null, onDecision = () => {}, startWrong = false,
  forceWait = false, healthWrong = false, stopFails = false } = {}) {
  const token = "H".repeat(32), calls = [];
  return { token, calls, fetchImpl: async (url, init) => {
    assert(url.startsWith("http://127.0.0.1:8788/"));
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/health")) return { ok: true, json: async () => ({
      policy: healthWrong ? "wrong-policy" : POLICY_VERSION, hybridPolicy: HYBRID_POLICY_VERSION, keyConfigured: true,
      hybridEnabled: true, requiresStart: true, sessionActive: false, plannerEnabled: false }) };
    if (url.endsWith("/session") && init.method === "POST") {
      const value = JSON.parse(init.body);
      assert.equal(value.mode, "hybrid");
      return { ok: true, json: async () => ({ token, mode: startWrong ? "bad" : "hybrid",
        limit: value.limit, plan_limit: 0 }) };
    }
    assert.equal(init.headers["X-Agent-Session"], token);
    if (init.method === "DELETE") return { ok: !stopFails };
    assert(url.endsWith("/hybrid-decision"));
    if (fail) return { ok: false, status: fail };
    const input = JSON.parse(init.body), request = buildHybridRequest(input);
    const city = Boolean(request.questions.branch.criteria.city_build);
    const branch = forceWait ? "wait" : city ? "city_build" : "land_attack";
    const answers = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => {
      const choice = name === "branch" ? branch :
        Object.keys(q.criteria).find((key) => !["wait", "save_gold"].includes(key));
      return [name, { type: "choice", choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === choice ? 1 : 0])) }];
    }));
    const decision = parseHybridDecision({ answers, model: "fake-local-hybrid" }, request);
    if (corrupt === "candidate") decision.candidate_id = "fabricated";
    if (corrupt === "context") decision.context.snapshot_tick--;
    onDecision(input);
    return { ok: true, json: async () => decision };
  } };
}

const loopOptions = (args = []) => parseHybridLoopArgs(["--loop", "--mock", ...args]);

test("full-loop CLI remains explicit, forbids live mock controls and needs explicit live quota", () => {
  assert.throws(() => parseHybridLoopArgs(["--loop", "--live"]), /explicit --max-calls/);
  assert.throws(() => parseHybridLoopArgs(["--loop", "--live", "--max-calls", "1",
    "--mock-choice", "wait-city"]), /forbidden/);
  assert.equal(loopOptions(["--mock-choice", "wait-city"]).mockChoice, "wait-city");
});

test("mock full loop executes offered tribe land actions and promotes history AFTER submission", async () => {
  const f = fixture({ gold: 100n });
  f.owner[5] = 2;
  const view = createHybridEuropeFacade(f.world, "europe-focus-001");
  const adapter = createGameAdapter({ game: view.game, read: f.world.read,
    sendAttack: () => { throw new Error("read-only facade precheck"); } });
  await adapter.observe({ focusId: null });
  const r = await runHybridEuropeLoop(loopOptions(["--max-calls", "2", "--max-ticks", "30"]), {
    worldFactory: loopWorld(f), ...clock(),
    fetchImpl: async () => { throw new Error("No network in mock loop"); } });
  assert.equal(r.status, "censored-call-cap", JSON.stringify({ error: r.error, decisions: r.decisions }));
  assert.equal(r.counts.mock_requests, 2);
  assert.equal(r.submitted_normal_intents.length, 2);
  assert(r.submitted_normal_intents.every((i) => i.type === "attack" && i.targetID === "other-core"));
  assert.equal(r.decisions[1].input.land.tribe_focus.progress.land_intents_emitted, 1);
  assert.equal(r.decisions[0].model_reply.kind, "land");
  assert.equal(r.city_scans.length, 0); // actual gold/cost preflight, no map scan
  assert.equal(r.complete, false);
  assert.equal(r.win, null);
  assert(r.standings.some((p) => p.id === "other-core"));
  const starts = r.timing.request_starts_ms;
  assert(starts[1] - starts[0] >= 1000);
  for (let i = 1; i < r.timing.tick_starts_ms.length; i++)
    assert(r.timing.tick_starts_ms[i] - r.timing.tick_starts_ms[i - 1] >= 100);
});

test("persistent City adapter records synthetic construction/completion, not merely returned Choice", async () => {
  const f = fixture();
  const r = await runHybridEuropeLoop(loopOptions(["--max-ticks", "30"]), {
    worldFactory: loopWorld(f), ...clock() });
  assert.equal(r.decisions[0].model_reply.kind, "city");
  assert.equal(r.submitted_normal_intents.length, 1);
  assert.equal(r.submitted_normal_intents[0].type, "build_unit");
  assert(r.observed_city_events.some((e) => e.stage === "first-observed-owned-city" && e.city.under_construction));
  assert(r.observed_city_events.some((e) => e.stage === "observed-completed-city"));
  assert.equal(r.after.troop_capacity_internal - r.before.troop_capacity_internal, 250000);
  assert.equal(r.city_scans.length, 1);
  assert.equal(r.win, null);
});

test("fake live hybrid Start/quota/pacing/Stop with every offered land branch implemented", async () => {
  const f = fixture({ gold: 100n }); f.owner[5] = 2;
  const s = sidecar();
  const options = parseHybridLoopArgs(["--loop", "--live", "--max-calls", "2", "--max-ticks", "30"]);
  const r = await runHybridEuropeLoop(options, { worldFactory: loopWorld(f), ...clock(), fetchImpl: s.fetchImpl });
  assert.equal(r.status, "censored-call-cap", JSON.stringify({ error: r.error, decisions: r.decisions }));
  assert.equal(r.counts.local_decision_attempts, 2);
  assert.equal(r.counts.successful_local_responses, 2);
  assert.equal(r.submitted_normal_intents.length, 2);
  assert.equal(r.session.started, true);
  assert.equal(r.session.revoked, true);
  assert.equal(s.calls.at(-1).method, "DELETE");
  assert.equal(JSON.stringify(r).includes(s.token), false);
});

test("live-compatible normalized wait is honored even with legal City candidates", async () => {
  const f = fixture(); const s = sidecar({ forceWait: true });
  const r = await runHybridEuropeLoop({ ...loopOptions(["--max-calls", "1", "--max-ticks", "30"]), mode: "live" }, {
    worldFactory: loopWorld(f), ...clock(), fetchImpl: s.fetchImpl });
  assert.equal(r.status, "censored-call-cap");
  assert.equal(r.decisions[0].model_reply.kind, "wait");
  assert.equal(r.submitted_normal_intents.length, 0);
  assert.equal(r.observed_city_events.length, 0);
  assert.equal(r.session.revoked, true);
});

test("policy mismatch prevents Start; Stop failure is explicit; exact land identity/type rechecked", async () => {
  const f = fixture(); const mismatch = sidecar({ healthWrong: true });
  await assert.rejects(runHybridEuropeLoop({ ...loopOptions(), mode: "live" }, {
    worldFactory: loopWorld(f), ...clock(), fetchImpl: mismatch.fetchImpl }), /state mismatch/);
  assert.equal(mismatch.calls.filter((c) => c.method === "POST").length, 0);
  const g = fixture(); const stop = sidecar({ forceWait: true, stopFails: true });
  const result = await runHybridEuropeLoop({ ...loopOptions(["--max-ticks", "1"]), mode: "live" }, {
    worldFactory: loopWorld(g), ...clock(), fetchImpl: stop.fetchImpl });
  assert.equal(result.session.revoked, false);
  assert.equal(result.session.stop_error, "Local Stop failed; no retry");
  const h = fixture({ gold: 100n }); h.owner[5] = 2;
  const changed = sidecar({ onDecision: () => { h.other.type = () => "NATION"; } });
  const invalid = await runHybridEuropeLoop({ ...loopOptions(), mode: "live" }, {
    worldFactory: loopWorld(h), ...clock(), fetchImpl: changed.fetchImpl });
  assert.equal(invalid.status, "censored-invalid-choice");
  assert.equal(invalid.submitted_normal_intents.length, 0);
  assert.equal(invalid.session.revoked, true);
});

test("City reply discarded for stale context/false candidate/cost drift; no replacement", async () => {
  for (const corruption of ["candidate", "context", "cost"]) {
    const f = fixture();
    const s = sidecar({ corrupt: corruption, onDecision: () => {
      if (corruption === "cost") f.setCost(150000n);
    } });
    const r = await runHybridEuropeLoop({ ...loopOptions(), mode: "live" }, {
      worldFactory: loopWorld(f), ...clock(), fetchImpl: s.fetchImpl });
    assert.equal(r.status, "censored-invalid-choice", corruption);
    assert.equal(r.submitted_normal_intents.length, 0, corruption);
    assert.equal(r.decisions[0].model_reply.kind, "city", corruption);
    assert.equal(r.observed_city_events.length, 0, corruption);
    assert.equal(r.session.revoked, true, corruption);
  }
});

test("paused tick does not waive 2s wall freshness: delayed reply sends zero intents and Stops", async () => {
  for (const family of ["city", "land"]) {
    const f = fixture({ gold: family === "city" ? 400000n : 100n });
    if (family === "land") f.owner[5] = 2;
    const timers = clock();
    const transport = sidecar({ onDecision: () => { timers.sleep(2100); } });
    const r = await runHybridEuropeLoop({ ...loopOptions(["--max-calls", "1"]), mode: "live" }, {
      worldFactory: loopWorld(f), ...timers, fetchImpl: transport.fetchImpl });
    assert.equal(r.status, "censored-stale", family);
    assert.equal(r.decisions[0].tick, 100, family);
    assert.equal(r.after.tick, 100, family); // engine paused throughout
    assert.equal(r.submitted_normal_intents.length, 0, family);
    assert.equal(r.decisions[0].model_reply.kind, family, family);
    assert.equal(r.session.revoked, true, family);
  }
});

test("preparation and final worker latency count in the same captured deadline", async () => {
  const f = fixture(); const timers = clock();
  f.setWorkerHook(() => { timers.sleep(200); }); // 4 offered-site scan calls = 800ms preparation
  const s = sidecar({ onDecision: () => { timers.sleep(1250); } });
  const old = await runHybridEuropeLoop({ ...loopOptions(["--max-calls", "1"]), mode: "live" }, {
    worldFactory: loopWorld(f), ...timers, fetchImpl: s.fetchImpl });
  assert.equal(old.status, "censored-stale");
  assert.equal(old.submitted_normal_intents.length, 0);
  for (const delay of [100, 1100]) {
    const g = fixture(); const time = clock();
    let n = 0;
    const fake = sidecar({ onDecision: () => {
      time.sleep(900);
      g.setWorkerHook(() => { time.sleep(++n === 1 ? 100 : delay); });
    } });
    const r = await runHybridEuropeLoop({ ...loopOptions(["--max-ticks", "1"]), mode: "live" }, {
      worldFactory: loopWorld(g), ...time, fetchImpl: fake.fetchImpl });
    assert.equal(r.submitted_normal_intents.length, delay === 100 ? 1 : 0);
    if (delay === 1100) assert.equal(r.status, "censored-stale");
    assert.equal(r.session.revoked, true);
  }
});

test("model/engine failure still saves partial evidence and attempts Stop without retry", async () => {
  const f = fixture(); const s = sidecar({ fail: 529 });
  const r = await runHybridEuropeLoop({ ...loopOptions(), mode: "live" }, {
    worldFactory: loopWorld(f), ...clock(), fetchImpl: s.fetchImpl });
  assert.equal(r.status, "censored-decision-error");
  assert.equal(r.counts.local_decision_attempts, 1);
  assert.equal(s.calls.filter((c) => c.url.endsWith("/hybrid-decision")).length, 1);
  assert.equal(r.session.revoked, true);
  const g = fixture(); const transport = sidecar();
  g.world.step = async () => { throw new Error("synthetic engine failure"); };
  const failed = await runHybridEuropeLoop({ ...loopOptions(), mode: "live" }, {
    worldFactory: loopWorld(g), ...clock(), fetchImpl: transport.fetchImpl });
  assert.equal(failed.status, "censored-runtime-error");
  assert.equal(failed.error.phase, "tick");
  assert.equal(failed.decisions[0].model_reply.kind, "city");
  assert.equal(failed.decisions[0].normal_intent_queued, true);
  assert.equal(failed.submitted_normal_intents.length, 0);
  assert.equal(failed.session.revoked, true);
});

test("known malformed Start token is revoked, cancellation sends nothing, human death is not WinCheck", async () => {
  const f = fixture(); const bad = sidecar({ startWrong: true });
  const r = await runHybridEuropeLoop({ ...loopOptions(), mode: "live" }, {
    worldFactory: loopWorld(f), ...clock(), fetchImpl: bad.fetchImpl });
  assert.equal(r.session.revoked, true);
  assert.equal(r.counts.local_decision_attempts, 0);
  const g = fixture(); let current = true;
  const s = sidecar({ onDecision: () => { current = false; } });
  const canceled = await runHybridEuropeLoop({ ...loopOptions(), mode: "live" }, {
    worldFactory: loopWorld(g), ...clock(), fetchImpl: s.fetchImpl, isCurrent: () => current });
  assert.equal(canceled.status, "canceled-or-stale");
  assert.equal(canceled.submitted_normal_intents.length, 0);
  assert.equal(canceled.session.revoked, true);
  const h = fixture();
  const step = h.world.step;
  h.world.step = async (intents) => { await step(intents); h.world.human.isAlive = () => false; };
  const dead = await runHybridEuropeLoop(loopOptions(), { worldFactory: loopWorld(h), ...clock() });
  assert.equal(dead.status, "human-eliminated-before-win-event");
  assert.equal(dead.human_eliminated_before_win, true);
  assert.equal(dead.complete, false);
  assert.equal(dead.win, null);
});
