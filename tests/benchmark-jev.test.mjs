import test from "node:test";
import assert from "node:assert/strict";
import { modelState } from "../web/observation.js";
import { createGameAdapter } from "../web/game-adapter.js";
import { createAgentServer } from "../src/server.mjs";
import { buildRequest } from "../src/policy.mjs";
import {
  createPacedDecisionClient,
  createTickPacer,
  observeCore,
  recheckCoreAction,
  startBenchmarkSession,
  timedWinCheckBoundary,
} from "../scripts/benchmark-jev-observation.mjs";

function fixture() {
  const owners = [3, 2, 0, 0, 1, 0, 0, 0, 0];
  const players = new Map();
  let tick = 100;
  const attack = (id, attacker, target, troops) => ({
    id: () => id, attacker: () => players.get(attacker),
    target: () => target === 0 ? game.terraNullius() : players.get(target),
    troops: () => troops, retreating: () => false,
  });
  const game = {
    ticks: () => tick, width: () => 3, height: () => 3,
    ref: (x, y) => y * 3 + x,
    ownerID: (t) => owners[t],
    isLand: (t) => t !== 3,
    isImpassable: (t) => t === 7,
    neighbors: (t) => {
      const x = t % 3, y = Math.floor(t / 3);
      return [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]]
        .filter(([a, b]) => a >= 0 && a < 3 && b >= 0 && b < 3)
        .map(([a, b]) => b * 3 + a);
    },
    config: () => ({ maxTroops: (p) => p.capacity }),
    playerBySmallID: (id) => players.get(id),
    terraNullius: () => wilderness,
  };
  const wilderness = { smallID: () => 0, isPlayer: () => false };
  for (const id of [1, 2, 3]) {
    players.set(id, {
      smallID: () => id,
      isPlayer: () => true,
      hasSpawned: () => true,
      isAlive: () => true,
      type: () => id === 1 ? "HUMAN" : id === 3 ? "NATION" : "BOT",
      troops: () => id === 1 ? 25000 : id === 2 ? 10000 : 15000,
      capacity: id === 1 ? 120000 : 50000,
      numTilesOwned: () => owners.filter((owner) => owner === id).length,
      isOnSameTeam: () => false,
      isAlliedWith: () => false,
      canAttackPlayer: () => true,
      canAttack: (t) => t !== 3 && t !== 7 && owners[t] !== 1,
      borderTiles: () => new Set([4]),
      incomingAttacks: () => [],
      outgoingAttacks: () => [],
    });
  }
  const me = players.get(1);
  const contested = players.get(2);
  const theirs = attack("other1", 3, 2, 3000);
  const mine = attack("mine1", 1, 2, 5000);
  const attackingUs = attack("incoming1", 2, 1, 4000);
  contested.incomingAttacks = () => [mine, theirs];
  me.incomingAttacks = () => [attackingUs];
  me.outgoingAttacks = () => [mine];
  return { game, me, owners, advance: () => tick++ };
}

test("core observation mirrors v4.1 border units and all neighbor attackers", () => {
  const f = fixture();
  const { observation: o, actions } = observeCore(f.game, f.me);
  assert.deepEqual(o.border, {
    total_edges: 4, wilderness_edges: 1, player_edges: 1,
    water_edges: 1, blocked_edges: 1,
  });
  assert.deepEqual(o.self, {
    id: 1, troops: 2500, troop_capacity: 12000, territory_tiles: 1,
  });
  assert.equal(o.neighbors[0].incoming_attacks[0].attacker_id, 1);
  assert.deepEqual(o.neighbors[0].incoming_attacks[1], {
    id: "other1", attacker_id: 3, attacker_type: "nation",
    attacker_reserve_troops: 1500, troops: 300, retreating: false,
  });
  assert.equal(o.incoming_attacks[0].attacker_reserve_troops, 1000);
  assert.deepEqual(o.outgoing_attacks[0], {
    id: "mine1", target_id: 2, troops: 500, retreating: false,
  });
  assert.equal(modelState(o).neighbors[0].attacked_by_other_humans_or_nations, true);
  assert.equal(actions.attack_player_2_20.fraction, 0.2);
  assert.equal(actions.attack_player_2_30, undefined); // tribe ceiling
});

test("core observation is field-for-field equal to browser GameView adapter on the same state", async () => {
  const { game, me } = fixture();
  const browser = Object.create(game);
  const wrapped = new Map();
  const asUpdate = (a) => ({
    id: a.id(), attackerID: a.attacker().smallID(),
    targetID: a.target().smallID(), troops: a.troops(),
    retreating: a.retreating(),
  });
  for (const id of [1, 2, 3]) {
    const core = game.playerBySmallID(id);
    wrapped.set(id, {
      smallID: core.smallID, isPlayer: core.isPlayer, isAlive: core.isAlive,
      type: core.type, troops: core.troops, capacity: core.capacity,
      numTilesOwned: core.numTilesOwned,
      isOnSameTeam: core.isOnSameTeam, isAlliedWith: core.isAlliedWith,
      borderTiles: async () => ({ borderTiles: core.borderTiles() }),
      actions: async (tile) => ({ canAttack: core.canAttack(tile) }),
      incomingAttacks: () => core.incomingAttacks().map(asUpdate),
      outgoingAttacks: () => core.outgoingAttacks().map(asUpdate),
    });
  }
  browser.myPlayer = () => wrapped.get(me.smallID());
  browser.playerBySmallID = (id) => wrapped.get(id);
  const adapter = createGameAdapter({ game: browser,
    read: () => ({ tick: game.ticks(), ready: true, ended: false }),
    sendAttack: () => { throw new Error("read-only test"); },
  });
  assert.deepEqual(observeCore(game, me).observation, (await adapter.observe()).observation);
});

test("only selected offered action passes core tick, border and legality recheck", () => {
  for (const reason of ["tick", "ownership", "immunity"]) {
    const f = fixture();
    const snap = observeCore(f.game, f.me);
    assert.equal(recheckCoreAction(f.game, f.me, snap, "attack_player_2_20").fraction, 0.2);
    if (reason === "tick") f.advance();
    if (reason === "ownership") f.owners[1] = 0;
    if (reason === "immunity") f.me.canAttackPlayer = () => false;
    assert.throws(() => recheckCoreAction(f.game, f.me, snap, "attack_player_2_20"));
  }
  const f = fixture();
  const snap = observeCore(f.game, f.me);
  assert.throws(() => recheckCoreAction(f.game, f.me, snap, "attack_player_2_50"));
  assert.equal(recheckCoreAction(f.game, f.me, snap, "wait").kind, "wait");
});

test("local decision transport is single-flight and starts at least a real second apart", async () => {
  let clock = 0;
  let release;
  const starts = [];
  const client = createPacedDecisionClient({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: (url, init) => {
      assert.equal(url, "http://127.0.0.1:8788/decision");
      assert.equal(init.method, "POST");
      starts.push(clock);
      if (starts.length === 1)
        return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ action: "wait" }) }); });
      return Promise.resolve({ ok: true, json: async () => ({ action: "wait" }) });
    },
  });
  const first = client({ self: 1 });
  await assert.rejects(client({ self: 1 }), /already pending/);
  release();
  await first;
  await client({ self: 1 });
  assert.deepEqual(starts, [0, 1000]);
});

test("early timer wakeups cannot abort or accelerate ticks; slow work never catches up", async () => {
  let clock = 0;
  const pace = createTickPacer({
    now: () => clock,
    // A timer can resolve slightly before its requested deadline.
    sleep: async (ms) => { clock += Math.max(0.5, ms - 0.3); },
  });
  const starts = [await pace(), await pace()];
  clock += 350; // Slow model or engine work between tick starts.
  starts.push(await pace(), await pace());
  assert.equal(starts[0], 0);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 100, `tick ${i} advanced too quickly`);
  assert.ok(starts[2] - starts[1] > 300, "slow work was not preserved");
});

test("early timer wakeups cannot issue a sidecar request before 1s", async () => {
  let clock = 0;
  const starts = [];
  const client = createPacedDecisionClient({
    now: () => clock,
    sleep: async (ms) => { clock += Math.max(0.5, ms - 0.4); },
    fetchImpl: async () => {
      starts.push(clock);
      return { ok: true, json: async () => ({ action: "wait" }) };
    },
  });
  await client({});
  await client({});
  clock += 2300; // Do not schedule catch-up requests after a long gap.
  await client({});
  await client({});
  assert.equal(starts[0], 0);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 1000, `call ${i} was too early`);
  assert.ok(starts[2] - starts[1] > 2000);
});

test("explicit benchmark Start authenticates each decision and revokes once without serializing token", async () => {
  const secret = "A".repeat(32);
  const events = [];
  const fetchImpl = async (url, init) => {
    events.push({ path: new URL(url).pathname, method: init.method, headers: init.headers });
    if (init.method === "POST" && url.endsWith("/session")) {
      assert.deepEqual(JSON.parse(init.body), { mode: "benchmark", limit: 2 });
      assert.equal(init.headers["X-Agent-Session"], undefined);
      return { ok: true, json: async () => ({ token: secret, mode: "benchmark", limit: 2, expires_in_ms: 900000 }) };
    }
    if (url.endsWith("/decision")) {
      assert.equal(init.headers["X-Agent-Session"], secret);
      return { ok: true, json: async () => ({ action: "wait", model: "fake" }) };
    }
    assert.equal(init.method, "DELETE");
    assert.equal(init.headers["X-Agent-Session"], secret);
    return { ok: true };
  };
  const session = await startBenchmarkSession({ limit: 2, fetchImpl });
  assert.equal(JSON.stringify(session).includes(secret), false);
  const ask = createPacedDecisionClient({ fetchImpl, sessionHeaders: session.headers,
    now: () => 0, timeoutMs: 1000 });
  const answer = await ask({ self: 1 });
  assert.equal(answer.decision.action, "wait");
  assert.equal(JSON.stringify(answer).includes(secret), false);
  await session.stop();
  await session.stop(); // idempotent, exactly one Stop request
  assert.deepEqual(events.map((e) => [e.path, e.method]), [
    ["/session", "POST"], ["/decision", "POST"], ["/session", "DELETE"],
  ]);
  assert.throws(session.headers, /already stopped/);
});

test("real local server gate blocks before Start and after Stop; fake upstream sees one authenticated call", async () => {
  const f = fixture();
  const observation = observeCore(f.game, f.me).observation;
  const criteria = buildRequest(observation).questions.action.criteria;
  let upstreamCalls = 0;
  const logs = [];
  const server = createAgentServer({
    apiKey: "fake-key-not-a-credential",
    minimumIntervalMs: 0,
    log: async (record) => logs.push(record),
    fetchImpl: async () => {
      upstreamCalls++;
      return { ok: true, json: async () => ({
        model: "fake", answers: { action: { type: "choice", choice: "wait",
          confidence: 1, probabilities: Object.fromEntries(Object.keys(criteria)
            .map((id) => [id, id === "wait" ? 1 : 0])) } },
      }) };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await fetch(`${baseUrl}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(observation),
    });
    assert.equal(before.status, 403);
    assert.equal(upstreamCalls, 0);
    const session = await startBenchmarkSession({ limit: 1, baseUrl });
    try {
      const ask = createPacedDecisionClient({ baseUrl,
        sessionHeaders: session.headers });
      const answer = await ask(observation);
      assert.equal(answer.decision.action, "wait");
      assert.equal(upstreamCalls, 1);
      const spent = await fetch(`${baseUrl}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json",
          ...session.headers() }, body: JSON.stringify(observation),
      });
      assert.equal(spent.status, 403);
      assert.equal(upstreamCalls, 1);
    } finally {
      await session.stop();
    }
    const after = await fetch(`${baseUrl}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(observation),
    });
    assert.equal(after.status, 403);
    assert.equal(logs.length, 1);
    assert.equal(JSON.stringify(logs[0]).includes("fake-key-not-a-credential"), false);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("Start refuses invalid caps; failed Stop blocks decisions but allows revoke retry", async () => {
  let requests = 0;
  await assert.rejects(startBenchmarkSession({ limit: 301,
    fetchImpl: () => { requests++; throw new Error("must not fetch"); },
  }), /1\.\.300/);
  assert.equal(requests, 0);
  let deletes = 0;
  const session = await startBenchmarkSession({ limit: 1, fetchImpl: async (_url, init) =>
    init.method === "POST"
      ? { ok: true, json: async () => ({ token: "B".repeat(32), mode: "benchmark", limit: 1 }) }
      : (++deletes === 1 ? { ok: false, status: 503 } : { ok: true }),
  });
  await assert.rejects(session.stop(), /Local session Stop HTTP 503/);
  assert.throws(session.headers, /already stopped/);
  await session.stop();
  assert.equal(deletes, 2);
});

test("only configured timer boundary may advance engine without a model decision", () => {
  assert.equal(timedWinCheckBoundary(299.9, 5), false);
  assert.equal(timedWinCheckBoundary(300, 5), true);
  assert.equal(timedWinCheckBoundary(301, 5), true);
  assert.throws(() => timedWinCheckBoundary(302.1, 5), /WinCheck did not fire/);
  assert.throws(() => timedWinCheckBoundary(300, 0), /Invalid engine timer/);
});

test("sidecar failure does not invent a wait or attack", async () => {
  const client = createPacedDecisionClient({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(client({}), /Local decision HTTP 503/);
});
