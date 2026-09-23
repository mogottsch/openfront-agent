import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlanSession } from '../src/plan-session.mjs';

const snapshot = ({ session_id = 'run-1', game_id = 'game-1', tick = 100,
  observed_at_ms = 1000, region_ids = ['r1'], gold = '950' } = {}) => ({
  session_id, game_id, tick, observed_at_ms, region_ids,
  summary: {
    troops: 2000, troop_capacity: 8000, territory_tiles: 100,
    available_gold: gold, incoming_attack_troops: 40,
    wilderness_border_edges: 8, player_border_edges: 4,
    regions: region_ids.map((id) => ({ id, territory_tiles: 100,
      hostile_border_edges: 4, city_count: 1 })),
  },
});
const beat = (s) => ({ session_id: s.session_id, game_id: s.game_id,
  tick: s.tick, observed_at_ms: s.observed_at_ms, region_ids: s.region_ids });
const result = ({ snapshot: s, previousPlan }) => ({
  schema_version: 1, plan_version: (previousPlan?.plan_version ?? 0) + 1,
  game_id: s.game_id, source_tick: s.tick, expires_tick: s.tick + 10,
  objective: 'Improve our position without inventing new actions',
  region_priorities: s.region_ids.map((region_id) =>
    ({ region_id, priority: 'medium', reason: 'Current owned region' })),
  replan_on: ['border_change'],
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('start/heartbeat/getPlan are inert; only explicit plan calls the injected planner', async () => {
  let time = 1000;
  const calls = [];
  const session = createPlanSession({ now: () => time, planner: async (args) => {
    calls.push(args);
    return result(args);
  } });
  const first = snapshot();
  session.start(first);
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  session.heartbeat(beat(first));
  assert.equal(calls.length, 0);
  const publicResult = await session.plan(first);
  assert.deepEqual(publicResult, {
    objective: 'Improve our position without inventing new actions',
    plan_version: 1, source_tick: 100, expires_tick: 110,
  });
  assert.deepEqual(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), publicResult);
  assert.equal(session.getPlan({ session_id: 'wrong', game_id: 'game-1' }), null);
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'other' }), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].snapshot.summary.available_gold, '950');
  assert.ok(!Object.hasOwn(calls[0].snapshot, 'session_id'));
  assert.equal(calls[0].signal.aborted, false);
  time = 3001;
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
});

test('versions rise monotonically, expiry and changed regions hide old plan', async () => {
  let time = 1000;
  const session = createPlanSession({ now: () => time, planner: async (args) => result(args) });
  const first = snapshot();
  session.start(first);
  assert.equal((await session.plan(first)).plan_version, 1);
  time = 1100;
  const next = snapshot({ tick: 101, observed_at_ms: time });
  session.heartbeat(beat(next));
  assert.equal((await session.plan(next)).plan_version, 2);
  time = 1200;
  session.heartbeat(beat(snapshot({ tick: 111, observed_at_ms: time })));
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  const changed = snapshot({ tick: 112, observed_at_ms: 1300, region_ids: ['r2'] });
  time = 1300;
  session.heartbeat(beat(changed));
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  assert.equal((await session.plan(changed)).plan_version, 3);
  session.stop();
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  const newRun = snapshot({ session_id: 'run-2', tick: 200, observed_at_ms: 1400 });
  time = 1400;
  session.start(newRun);
  assert.equal((await session.plan(newRun)).plan_version, 1);
});

test('strict numeric/gold/region projection rejects extra fields and inconsistent IDs', () => {
  let calls = 0;
  const session = createPlanSession({ now: () => 1000, planner: async () => { calls++; } });
  for (const bad of [
    { ...snapshot(), secret: 'do not forward' },
    { ...snapshot(), summary: { ...snapshot().summary, extra: 'text' } },
    { ...snapshot(), summary: { ...snapshot().summary, available_gold: '09' } },
    { ...snapshot(), summary: { ...snapshot().summary, troops: -1 } },
    { ...snapshot(), region_ids: ['r1', 'r1'] },
    { ...snapshot(), region_ids: ['r2'] },
  ]) assert.throws(() => session.start(bad));
  assert.equal(calls, 0);
});

test('stale heartbeats/snapshots and different session cannot trigger inference', async () => {
  let time = 1000;
  let calls = 0;
  const session = createPlanSession({ now: () => time, planner: async (args) => {
    calls++;
    return result(args);
  } });
  const first = snapshot();
  session.start(first);
  assert.throws(() => session.heartbeat(beat(snapshot({ session_id: 'old-run' }))), /different/);
  assert.throws(() => session.heartbeat(beat(snapshot({ tick: 99 }))), /Stale/);
  assert.throws(() => session.heartbeat(beat(snapshot({ observed_at_ms: 1001 }))), /Stale/);
  time = 1100;
  session.heartbeat(beat(snapshot({ tick: 101, observed_at_ms: 1100 })));
  await assert.rejects(session.plan(first), /not the active fresh heartbeat/);
  time = 3500;
  await assert.rejects(session.plan(snapshot({ tick: 101, observed_at_ms: 1100 })), /not the active fresh heartbeat/);
  assert.equal(calls, 0);
});

test('in-flight result cannot install after stop or new session, even if planner ignores abort', async () => {
  const outstanding = deferred();
  let signal;
  const session = createPlanSession({ now: () => 1000, planner: ({ signal: s }) => {
    signal = s;
    return outstanding.promise;
  } });
  const s = snapshot();
  session.start(s);
  const pending = session.plan(s);
  await assert.rejects(session.plan(s), /already in flight/);
  session.stop();
  assert.equal(signal.aborted, true);
  session.start(snapshot({ session_id: 'run-2' }));
  outstanding.resolve(result({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }));
  await assert.rejects(pending, /cancelled or stale/);
  assert.equal(session.getPlan({ session_id: 'run-2', game_id: 'game-1' }), null);
});

test('an expired heartbeat permanently invalidates its plan, even if the game tick did not move', async () => {
  let time = 1000;
  const session = createPlanSession({ now: () => time, planner: async (args) => result(args) });
  const s = snapshot();
  session.start(s);
  await session.plan(s);
  time = 3100;
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  const revived = snapshot({ observed_at_ms: time });
  session.heartbeat(beat(revived));
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  assert.equal((await session.plan(revived)).plan_version, 2);
});

test('region change hides an active plan without reverting version history', async () => {
  let time = 1000;
  const session = createPlanSession({ now: () => time, planner: async (args) => result(args) });
  const s = snapshot();
  session.start(s);
  await session.plan(s);
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }).plan_version, 1);
  time = 1100;
  const changed = snapshot({ tick: 101, observed_at_ms: time, region_ids: ['r2'] });
  session.heartbeat(beat(changed));
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  assert.equal((await session.plan(changed)).plan_version, 2);
});

test('region change cancels a slow result and prevents stale installation', async () => {
  const outstanding = deferred();
  let time = 1000;
  let signal;
  const session = createPlanSession({ now: () => time, planner: ({ signal: s }) => {
    signal = s;
    return outstanding.promise;
  } });
  const s = snapshot();
  session.start(s);
  const pending = session.plan(s);
  time = 1100;
  session.heartbeat(beat(snapshot({ tick: 101, observed_at_ms: time, region_ids: ['r2'] })));
  assert.equal(signal.aborted, true);
  outstanding.resolve(result({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }));
  await assert.rejects(pending, /cancelled or stale/);
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
});

test('inference result is rejected after too many game ticks despite fresh wall-clock time', async () => {
  const outstanding = deferred();
  let time = 1000;
  const session = createPlanSession({ now: () => time, maxTickLag: 1,
    planner: () => outstanding.promise });
  const s = snapshot();
  session.start(s);
  const pending = session.plan(s);
  time = 1100;
  session.heartbeat(beat(snapshot({ tick: 102, observed_at_ms: time })));
  outstanding.resolve(result({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }));
  await assert.rejects(pending, /cancelled or stale/);
});

test('5-second inference succeeds with 1Hz heartbeats and a 20-second snapshot window', async () => {
  const outstanding = deferred();
  let time = 1000;
  const session = createPlanSession({ now: () => time, planner: () => outstanding.promise });
  const s = snapshot();
  session.start(s);
  const pending = session.plan(s);
  for (let second = 1; second <= 5; second++) {
    time = 1000 + second * 1000;
    session.heartbeat(beat(snapshot({ tick: 100 + second, observed_at_ms: time })));
  }
  outstanding.resolve(result({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }));
  assert.equal((await pending).plan_version, 1);
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }).plan_version, 1);
});

test('3-second heartbeat outage rejects slow result and cannot revive the old plan', async () => {
  const outstanding = deferred();
  let time = 1000;
  const session = createPlanSession({ now: () => time, planner: () => outstanding.promise });
  const s = snapshot();
  session.start(s);
  const pending = session.plan(s);
  time = 2000;
  session.heartbeat(beat(snapshot({ tick: 101, observed_at_ms: time })));
  time = 5001; // 3001 ms since the last received heartbeat, within snapshot-age window
  outstanding.resolve(result({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }));
  await assert.rejects(pending, /cancelled or stale/);
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  session.heartbeat(beat(snapshot({ tick: 102, observed_at_ms: time })));
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
});

test('slow result exceeding snapshot age fails even with continuous heartbeats; invalid plan never persists', async () => {
  const outstanding = deferred();
  let time = 1000;
  const session = createPlanSession({ now: () => time, maxTickLag: 100,
    planner: () => outstanding.promise });
  const s = snapshot();
  session.start(s);
  const pending = session.plan(s);
  for (let second = 1; second <= 21; second++) {
    time = 1000 + second * 1000;
    session.heartbeat(beat(snapshot({ tick: 100 + second, observed_at_ms: time })));
  }
  outstanding.resolve({ ...result({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }), expires_tick: 400 });
  await assert.rejects(pending, /cancelled or stale/);
  assert.equal(session.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
  const wrong = createPlanSession({ now: () => 1000, planner: async (args) => ({
    ...result(args), region_priorities: [{ region_id: 'invented', priority: 'high', reason: 'no' }],
  }) });
  wrong.start(s);
  await assert.rejects(wrong.plan(s), /Invalid or stale Copilot plan/);
  assert.equal(wrong.getPlan({ session_id: 'run-1', game_id: 'game-1' }), null);
});

test('cancelled old session cannot overlap new provider work or install later', async () => {
  const outstanding = deferred();
  let calls = 0;
  const session = createPlanSession({ now: () => 1000, planner: (args) => {
    calls++;
    return calls === 1 ? outstanding.promise : Promise.resolve(result(args));
  } });
  const old = snapshot();
  session.start(old);
  const pending = session.plan(old);
  session.stop();
  const next = snapshot({ session_id: 'run-2' });
  session.start(next);
  await assert.rejects(session.plan(next), /already in flight/);
  assert.equal(calls, 1);
  outstanding.resolve(result({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }));
  await assert.rejects(pending, /cancelled or stale/);
  assert.equal((await session.plan(next)).plan_version, 1);
  assert.equal(calls, 2);
});
