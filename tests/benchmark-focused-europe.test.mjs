import assert from "node:assert/strict";
import test from "node:test";
import { POLICY_VERSION } from "../src/policy.mjs";
import { buildActions } from "../web/observation.js";
import { parseFocusedEuropeArgs, observeFocusedCore, runFocusedEurope,
} from "../scripts/benchmark-focused-europe.mts";

const opts = (args = []) => parseFocusedEuropeArgs(["--mock", ...args]);

// Synthetic facade only: dependency-free tests never load native terrain or
// any upstream code. The CLI smoke separately verifies the real engine.
function fakeWorld() {
  let tick = 100;
  let failTick = false;
  const owners = [3, 2, 2, 2, 1, 2, 2, 2, 2];
  const events = { conquests: [], winEvents: 0, wireWinner: null };
  const players = new Map();
  const tileNeighbors = (t) => {
    const x = t % 3, y = Math.floor(t / 3);
    return [y > 0 ? t - 3 : null, y < 2 ? t + 3 : null,
      x > 0 ? t - 1 : null, x < 2 ? t + 1 : null].filter((n) => n !== null);
  };
  const wilderness = { id: () => "wilderness", smallID: () => 0, isPlayer: () => false };
  for (const id of [1, 2, 3]) players.set(id, {
    id: () => `p${id}`, smallID: () => id, name: () => `Player ${id}`,
    type: () => id === 1 ? "HUMAN" : id === 2 ? "BOT" : "NATION",
    isPlayer: () => true, alive: true, isAlive() { return this.alive; },
    hasSpawned: () => true, troops: () => 10000, gold: () => 100000n,
    numTilesOwned: () => owners.filter((n) => n === id).length,
    incomingAttacks: () => [], outgoingAttacks: () => [],
    isOnSameTeam: () => false, isAlliedWith: () => false,
    canAttackPlayer: () => true,
    canAttack: (tile) => owners[tile] !== id,
    borderTiles: () => new Set(owners.flatMap((n, t) =>
      n === id && tileNeighbors(t).some((a) => owners[a] !== id) ? [t] : [])),
  });
  const human = players.get(1);
  const game = { ticks: () => tick, elapsedGameSeconds: () => tick / 10,
    width: () => 3, height: () => 3, ref: (x, y) => y * 3 + x,
    ownerID: (t) => owners[t], isLand: () => true, isImpassable: () => false,
    neighbors: tileNeighbors, config: () => ({ maxTroops: () => 50000 }),
    playerBySmallID: (id) => {
      if (!players.has(id)) throw new Error("missing player");
      return players.get(id);
    }, terraNullius: () => wilderness, getWinner: () => events.winEvents ? human : null,
    hash: () => tick };
  const tickStarts = [];
  const submitted = [];
  const factory = async (_options, { paceTick }) => ({ game, human, events,
    clientID: "fake-human", tickStarts,
    metadata: { engineCommit: "fake", roster: [{ id: "p2", type: "BOT" }] },
    step: async (intents) => {
      if (failTick) throw new Error("test engine error");
      tickStarts.push(await paceTick());
      submitted.push(...intents);
      tick++;
    } });
  return { game, human, players, owners, events, submitted, factory,
    setTick: (n) => { tick = n; }, fail: () => { failTick = true; } };
}

function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += ms; } };
}

function fakeSidecar({ action = "wait", failure = null, stopFails = false,
  onDecision = () => {} } = {}) {
  const token = "s".repeat(32);
  const calls = [];
  return { calls, token, fetchImpl: async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    assert(url.startsWith("http://127.0.0.1:8788/"));
    if (url.endsWith("/health")) return { ok: true, json: async () => ({
      policy: POLICY_VERSION, keyConfigured: true, requiresStart: true, sessionActive: false }) };
    if (url.endsWith("/session") && init.method === "POST") {
      const request = JSON.parse(init.body);
      assert.equal(request.mode, "benchmark");
      return { ok: true, json: async () => ({ ...request, token }) };
    }
    assert.equal(init.headers["X-Agent-Session"], token);
    if (url.endsWith("/session")) return { ok: !stopFails, status: stopFails ? 500 : 200 };
    assert(url.endsWith("/decision"));
    assert.equal(init.method, "POST");
    onDecision(JSON.parse(init.body));
    if (failure !== null) return { ok: false, status: failure };
    return { ok: true, json: async () => ({ action, model: "test-local-fake" }) };
  } };
}

test("import-safe CLI requires explicit mode and live cap, bounded ignored output", () => {
  assert.throws(() => parseFocusedEuropeArgs([]), /Explicit --mock/);
  assert.throws(() => parseFocusedEuropeArgs(["--live"]), /explicit --max-calls/);
  assert.throws(() => parseFocusedEuropeArgs(["--mock", "--live"]), /exactly one/);
  for (const cap of ["0", "301", "1.5", "NaN"]) {
    assert.throws(() => parseFocusedEuropeArgs(["--live", "--max-calls", cap]));
  }
  assert.throws(() => opts(["--output", "result.json"]), /ignored logs/);
  assert.throws(() => opts(["--output", "logs/../secret.json"]), /ignored logs/);
  assert.throws(() => opts(["--seed", "../bad"]), /Invalid seed/);
  assert.equal(opts().mode, "mock");
  assert.equal(parseFocusedEuropeArgs(["--live", "--max-calls", "5"]).maxCalls, 5);
});

test("mock is zero-network, bounded, paced and focus history reflects submitted tribe intents", async () => {
  const w = fakeWorld();
  const report = await runFocusedEurope(opts(["--max-calls", "2", "--max-ticks", "30"]), {
    worldFactory: w.factory, ...clock(),
    fetchImpl: async () => { throw new Error("Mock must never reach network"); } });
  assert.equal(report.status, "censored-call-cap");
  assert.equal(report.counts.mock_requests, 2);
  assert.equal(report.counts.local_decision_attempts, 0);
  assert.equal(report.win, null);
  assert.equal(report.complete, false);
  assert.equal(report.counts.human_tribe_conquests, 0);
  assert.equal(report.conquest_gold, "0");
  assert.equal(report.session.started, false);
  assert.equal(report.emitted_intents.length, 2);
  assert(report.emitted_intents.every((i) => i.targetID === "p2"));
  const focused = report.decisions[1].observation.tribe_focus;
  assert.equal(focused.id, 2);
  assert.equal(focused.progress.land_intents_emitted, 1);
  assert.equal(focused.progress.last_land_send_percent, 10);
  assert.equal(focused.progress.reference_tiles, 7);
  const requests = report.timing.request_starts_ms;
  assert(requests[1] - requests[0] >= 1000);
  for (let i = 1; i < report.timing.tick_starts_ms.length; i++)
    assert(report.timing.tick_starts_ms[i] - report.timing.tick_starts_ms[i - 1] >= 100);
});

test("authoritative focus stays alive outside borders; missing/replaced identity never means dead", () => {
  const w = fakeWorld();
  const focus = { id: 2, player_id: "p2", game_id: "europe-focus-001" };
  w.owners.fill(1);
  const remote = observeFocusedCore(w.game, w.human, focus, null);
  assert.equal(remote.focusKind, "active");
  assert.equal(remote.observation.tribe_focus.alive, true);
  assert.equal(remote.observation.tribe_focus.adjacent, false);
  assert.equal(remote.observation.tribe_focus.territory_tiles, 0);
  assert.equal(Object.keys(buildActions(remote.observation)).length, 1);
  w.players.delete(2);
  const unresolved = observeFocusedCore(w.game, w.human, focus, null);
  assert.equal(unresolved.focusKind, "unavailable");
  assert.equal(unresolved.observation, null);
  assert.equal(unresolved.focusedId, 2);
  const other = fakeWorld();
  other.players.get(2).alive = false;
  other.owners.fill(1);
  const dead = observeFocusedCore(other.game, other.human, focus, null);
  assert.equal(dead.focusKind, "conquered");
  assert.equal(dead.focusedId, null);
});

test("fake live transport Starts once, respects quota and always Stops without exposing token", async () => {
  const w = fakeWorld();
  const side = fakeSidecar();
  const options = parseFocusedEuropeArgs(["--live", "--max-calls", "2", "--max-ticks", "30"]);
  const report = await runFocusedEurope(options, { worldFactory: w.factory, ...clock(),
    fetchImpl: side.fetchImpl });
  assert.equal(report.status, "censored-call-cap");
  assert.equal(report.counts.local_decision_attempts, 2);
  assert.equal(report.counts.successful_local_responses, 2);
  assert.equal(report.emitted_intents.length, 0); // fake decisions said wait
  assert.equal(report.session.revoked, true);
  assert.equal(JSON.stringify(report).includes(side.token), false);
  assert.deepEqual(side.calls.map((c) => c.method), ["GET", "POST", "POST", "POST", "DELETE"]);
});

test("model error has no retry, fabricated action has no substitution, Stop still happens", async () => {
  for (const [settings, expected] of [
    [{ failure: 529 }, "censored-decision-error"],
    [{ action: "attack_player_99_10" }, "censored-illegal-choice"],
    [{ action: "attack_player_2_50" }, "censored-illegal-choice"],
  ]) {
    const w = fakeWorld();
    const side = fakeSidecar(settings);
    const report = await runFocusedEurope({ ...opts(), mode: "live" }, {
      worldFactory: w.factory, ...clock(), fetchImpl: side.fetchImpl });
    assert.equal(report.status, expected);
    assert.equal(report.counts.local_decision_attempts, 1);
    assert.equal(report.emitted_intents.length, 0);
    assert.equal(side.calls.filter((c) => c.url.endsWith("/decision")).length, 1);
    assert.equal(side.calls.at(-1).method, "DELETE");
  }
});

test("policy mismatch starts no session; malformed Start with known token is revoked", async () => {
  const w = fakeWorld();
  let opened = false;
  await assert.rejects(runFocusedEurope({ ...opts(), mode: "live" }, {
    worldFactory: w.factory, ...clock(), fetchImpl: async (_url, init) => {
      opened ||= init?.method === "POST";
      return { ok: true, json: async () => ({ policy: "wrong-policy" }) };
    } }), /state mismatch/);
  assert.equal(opened, false);
  const side = fakeSidecar();
  const fetchImpl = async (url, init) => {
    const response = await side.fetchImpl(url, init);
    if (url.endsWith("/session") && init.method === "POST") {
      const data = await response.json();
      return { ok: true, json: async () => ({ ...data, mode: "not-benchmark" }) };
    }
    return response;
  };
  await assert.rejects(runFocusedEurope({ ...opts(), mode: "live" }, {
    worldFactory: w.factory, ...clock(), fetchImpl }), /invalid contract/);
  assert.equal(side.calls.at(-1).method, "DELETE");
  assert.equal(side.calls.filter((c) => c.url.endsWith("/decision")).length, 0);
});

test("current target type drift cannot turn a tribe Choice into a nation intent", async () => {
  const w = fakeWorld();
  const side = fakeSidecar({ action: "attack_player_2_10", onDecision: () => {
    w.players.get(2).type = () => "NATION";
  } });
  const report = await runFocusedEurope({ ...opts(), mode: "live" }, {
    worldFactory: w.factory, ...clock(), fetchImpl: side.fetchImpl });
  assert.equal(report.status, "censored-illegal-choice");
  assert.equal(report.emitted_intents.length, 0);
  assert.equal(report.session.revoked, true);
});

test("smallID reuse during a response cannot redirect the selected initial tribe", async () => {
  const w = fakeWorld();
  const side = fakeSidecar({ action: "attack_player_2_10", onDecision: () => {
    const previous = w.players.get(2);
    w.players.set(2, { ...previous, id: () => "replacement-player" });
  } });
  const report = await runFocusedEurope({ ...opts(), mode: "live" }, {
    worldFactory: w.factory, ...clock(), fetchImpl: side.fetchImpl });
  assert.equal(report.status, "censored-illegal-choice");
  assert.equal(report.emitted_intents.length, 0);
  assert.equal(report.session.revoked, true);
});

test("cleanup Stop on engine failure and report Stop failure explicitly", async () => {
  const w = fakeWorld();
  w.fail();
  const side = fakeSidecar();
  await assert.rejects(runFocusedEurope({ ...opts(), mode: "live" }, {
    worldFactory: w.factory, ...clock(), fetchImpl: side.fetchImpl }), /engine error/);
  assert.equal(side.calls.at(-1).method, "DELETE");
  const g = fakeWorld();
  const badStop = fakeSidecar({ stopFails: true });
  const report = await runFocusedEurope({ ...opts(), mode: "live", maxTicks: 1 }, {
    worldFactory: g.factory, ...clock(), fetchImpl: badStop.fetchImpl });
  assert.equal(report.session.revoked, false);
  assert.equal(report.session.stop_error, "Local session Stop failed; no retry");
});

test("bounded empty-turn WinCheck grace never sends another capped decision", async () => {
  const w = fakeWorld();
  w.setTick(2999);
  const factory = async (...args) => {
    const world = await w.factory(...args);
    const step = world.step;
    world.step = async (intents) => {
      await step(intents);
      if (w.game.ticks() === 3002) {
        w.events.winEvents = 1;
        w.events.wireWinner = "p1";
      }
    };
    return world;
  };
  const report = await runFocusedEurope(opts(["--max-calls", "1"]), {
    worldFactory: factory, ...clock() });
  assert.equal(report.complete, true);
  assert.equal(report.after.tick, 3002);
  assert.equal(report.counts.mock_requests, 1);
  assert.equal(report.emitted_intents.length, 1);
});

test("genuine conquest/winner events alone establish credited gold and a full result", async () => {
  const w = fakeWorld();
  const original = w.factory;
  const worldFactory = async (...args) => {
    const world = await original(...args);
    const step = world.step;
    world.step = async (intents) => {
      await step(intents);
      w.events.conquests.push({ tick: w.game.ticks(), conquerorId: "p1", conqueredId: "p2", gold: "1250" });
      w.events.winEvents = 1;
      w.events.wireWinner = "p1";
    };
    return world;
  };
  const report = await runFocusedEurope(opts(), { worldFactory, ...clock() });
  assert.equal(report.status, "engine-win");
  assert.equal(report.complete, true);
  assert.equal(report.win, true);
  assert.equal(report.counts.human_tribe_conquests, 1);
  assert.equal(report.conquest_gold, "1250");
  assert.equal(report.winner.id, "p1");
});
