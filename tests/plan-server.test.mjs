import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentServer } from '../src/server.mjs';
import { createCopilotPlanner } from '../src/copilot-planner.mjs';
import { observation } from './fixtures/land.mjs';

const summary = (ids = ['r1']) => ({
  troops: 2000, troop_capacity: 8000, territory_tiles: 100,
  available_gold: '950', incoming_attack_troops: 20,
  wilderness_border_edges: 8, player_border_edges: 4,
  regions: ids.map((id) => ({ id, territory_tiles: 100,
    hostile_border_edges: 4, city_count: 1 })),
});
const planBody = (tick = 100, ids = ['r1']) =>
  ({ game_id: 'game-1', tick, region_ids: ids, summary: summary(ids) });
const beatBody = (tick = 100, ids = ['r1']) =>
  ({ game_id: 'game-1', tick, region_ids: ids });
const omissions = () => Object.fromEntries([
  'not_examined', 'prefilter_limit', 'worker_unchecked', 'pending_intent',
  'occupied_city', 'not_buildable', 'relocated', 'upgrade_not_city_build',
  'unaffordable', 'unaffordable_after_check', 'invalid_worker_result',
  'invalid_gold', 'shortlist_limit',
].map((name) => [name, 0]));
const hybridBody = (tick = 100) => ({
  game_id: 'game-1', snapshot_tick: tick,
  land: observation(8000, 20000, 'tribe'),
  city_mechanics: { troop_capacity_gain_display: 25000, construction_ticks: 20 },
  plan: null,
  building: {
    snapshot_id: 'game-1/map@100#1', source_tick: 100, current_tick: 100,
    map_id: 'game-1/map', available_gold: '950',
    city_counts: { owned: 1, pending: 0 }, candidates: [],
    save_gold: { id: 'game-1/map@100#1:save_gold', kind: 'save_gold' },
    coverage: { total_eligible: 0, total_examined: 0, worker_checked: 0,
      offered_count: 0, omitted_count: 0, model: 'geometric test coverage' },
    omissions: omissions(),
  },
});
const fakePlan = ({ snapshot, previousPlan }) => ({
  schema_version: 1, plan_version: (previousPlan?.plan_version ?? 0) + 1,
  game_id: snapshot.game_id, source_tick: snapshot.tick,
  expires_tick: snapshot.tick + 10,
  objective: 'Develop while preserving survival',
  region_priorities: snapshot.region_ids.map((region_id) =>
    ({ region_id, priority: 'medium', reason: 'Current region' })),
  replan_on: ['border_change'],
});
const fakeJev = (request) => ({
  model: 'jev-test', usage: {},
  answers: Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, {
    type: 'choice', choice: 'wait', confidence: 0.9,
    probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) =>
      [key, key === 'wait' ? 1 : 0])),
  }])),
});
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function serve(t, options = {}) {
  const server = createAgentServer({
    apiKey: 'fake-test-key', enableHybridDecisions: true,
    enableCopilotPlanner: true, minimumIntervalMs: 0, ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
const json = async (url, path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(url + path, {
    method, headers: { Origin: 'http://localhost:9000',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Agent-Session': token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
const start = async (url, limit = 10) => {
  const response = await json(url, '/session', {
    method: 'POST', body: { mode: 'hybrid', limit },
  });
  assert.equal(response.status, 200);
  return response.body.token;
};
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for injected planner');
};

test('planner is default-off and cannot call a provider before explicit hybrid Start', async (t) => {
  let calls = 0;
  const url = await serve(t, { enableCopilotPlanner: false,
    planner: async () => { calls++; throw new Error('not expected'); } });
  assert.equal((await json(url, '/plan', { method: 'POST', body: planBody() })).status, 403);
  const token = await start(url);
  assert.equal((await json(url, '/plan', { method: 'POST', body: planBody(), token })).status, 403);
  assert.equal(calls, 0);
  const health = await json(url, '/health');
  assert.equal(health.body.plannerEnabled, false);
  const module = await fetch(url + '/plan-client.js');
  assert.equal(module.status, 200);
  assert.match(await module.text(), /createPlanClient/);
});

test('server stamps identity/time, calls injected planner only on POST and injects minimal plan into Jev', async (t) => {
  let clock = 1000;
  const calls = [], jev = [], logs = [];
  const url = await serve(t, { planNow: () => clock,
    planner: async (args) => { calls.push(args); return fakePlan(args); },
    fetchImpl: async (_endpoint, init) => {
      const request = JSON.parse(init.body);
      jev.push(request);
      return new Response(JSON.stringify(fakeJev(request)));
    }, log: async (row) => logs.push(row),
  });
  assert.equal((await json(url, '/plan')).status, 403);
  const token = await start(url);
  assert.equal((await json(url, '/plan', { token })).body.plan, null);
  assert.equal((await json(url, '/plan/heartbeat', { method: 'POST', body: beatBody(), token })).status, 400);
  assert.equal(calls.length, 0);
  const response = await json(url, '/plan', { method: 'POST', body: planBody(), token });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.plan), ['objective', 'plan_version', 'source_tick', 'expires_tick']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].snapshot.observed_at_ms, 1000);
  assert.equal(calls[0].snapshot.summary.available_gold, '950');
  assert.equal('session_id' in calls[0].snapshot, false);
  assert.equal((await json(url, '/plan', { token })).body.plan.plan_version, 1);
  const hybrid = await json(url, '/hybrid-decision', { method: 'POST', body: hybridBody(), token });
  assert.equal(hybrid.status, 200);
  assert.equal(hybrid.body.context.plan_version, 1);
  assert.equal(jev[0].state.objective.text, response.body.plan.objective);
  assert.equal(jev[0].state.objective.source_tick, 100);
  assert.equal(jev[0].questions.branch.type, 'choice');
  assert.ok(logs.some((row) => row.policy === 'copilot-plan-v1' && !row.event));
  assert.equal(logs.find((row) => row.planProvenance)?.planProvenance.promptVersion,
    'copilot-plan-v1');
  assert.ok(!JSON.stringify(logs).includes(token));
  clock = 4000;
  assert.equal((await json(url, '/plan', { token })).body.plan, null);
  assert.equal((await json(url, '/plan/heartbeat', { method: 'POST', body: beatBody(), token })).status, 200);
  assert.equal((await json(url, '/plan', { token })).body.plan, null); // no stale revival
  const noPlan = await json(url, '/hybrid-decision', { method: 'POST', body: hybridBody(), token });
  assert.equal(noPlan.status, 200);
  assert.equal(jev[1].state.objective, null);
});

test('heartbeats continue during slow plan; shared busy forbids Jev overlap and late old session result', async (t) => {
  const pending = deferred();
  let clock = 1000, calls = 0, jevCalls = 0;
  const url = await serve(t, { planNow: () => clock,
    planner: (args) => { calls++; return pending.promise; },
    fetchImpl: async (_endpoint, init) => {
      jevCalls++;
      const req = JSON.parse(init.body);
      return new Response(JSON.stringify(fakeJev(req)));
    },
  });
  const token = await start(url);
  const running = json(url, '/plan', { method: 'POST', body: planBody(), token });
  await waitFor(() => calls === 1);
  assert.equal((await json(url, '/hybrid-decision', { method: 'POST', body: hybridBody(), token })).status, 429);
  for (let second = 1; second <= 5; second++) {
    clock = 1000 + second * 1000;
    assert.equal((await json(url, '/plan/heartbeat', { method: 'POST', body: beatBody(100 + second), token })).status, 200);
  }
  pending.resolve(fakePlan({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }));
  assert.equal((await running).status, 200);
  assert.equal(calls, 1);
  assert.equal(jevCalls, 0);
  const health = await json(url, '/health');
  assert.equal(health.body.planCallsUsed, 1);
  assert.equal(health.body.planCallLimit, 3);
  const stopped = await json(url, '/session', { method: 'DELETE', token });
  assert.equal(stopped.status, 200);
  assert.equal((await json(url, '/plan', { token })).status, 403);
});

test('a pending Jev call blocks Copilot and both share start-to-start pacing', async (t) => {
  const waiting = deferred();
  const starts = [];
  let planCalls = 0;
  const url = await serve(t, { minimumIntervalMs: 50, planNow: () => 1000,
    planner: async (args) => {
      planCalls++;
      starts.push({ type: 'plan', at: performance.now() });
      return fakePlan(args);
    },
    fetchImpl: async (_endpoint, init) => {
      starts.push({ type: 'jev', at: performance.now() });
      await waiting.promise;
      const req = JSON.parse(init.body);
      return new Response(JSON.stringify(fakeJev(req)));
    },
  });
  const token = await start(url);
  const jev = json(url, '/hybrid-decision', { method: 'POST', body: hybridBody(), token });
  await waitFor(() => starts.length === 1);
  assert.equal((await json(url, '/plan', { method: 'POST', body: planBody(), token })).status, 429);
  assert.equal(planCalls, 0);
  waiting.resolve();
  assert.equal((await jev).status, 200);
  assert.equal((await json(url, '/plan', { method: 'POST', body: planBody(), token })).status, 200);
  assert.deepEqual(starts.map((s) => s.type), ['jev', 'plan']);
  assert.ok(starts[1].at - starts[0].at >= 48);
});

test('heartbeat arriving during shared pacing is admitted after the initial plan snapshot', async (t) => {
  let clock = 1000, plannerCalls = 0;
  const url = await serve(t, { minimumIntervalMs: 150, planNow: () => clock,
    planner: async (args) => {
      plannerCalls++;
      assert.equal(args.getCurrentState().tick, 100); // buffered until admission
      return fakePlan(args);
    },
    fetchImpl: async (_endpoint, init) => {
      const req = JSON.parse(init.body);
      return new Response(JSON.stringify(fakeJev(req)));
    },
  });
  const token = await start(url);
  assert.equal((await json(url, '/hybrid-decision', { method: 'POST', body: hybridBody(), token })).status, 200);
  const running = json(url, '/plan', { method: 'POST', body: planBody(), token });
  await new Promise((resolve) => setTimeout(resolve, 20));
  clock = 2000;
  assert.equal((await json(url, '/plan/heartbeat', { method: 'POST', body: beatBody(101), token })).status, 200);
  assert.equal(plannerCalls, 0);
  assert.equal((await running).status, 200);
  assert.equal(plannerCalls, 1);
  assert.equal((await json(url, '/plan', { token })).body.plan.plan_version, 1);
});

test('plan cap is independent of Jev cap; malformed snapshots and browser plans do not call Copilot', async (t) => {
  let calls = 0;
  const url = await serve(t, { maxPlanRequestsPerSession: 3,
    planner: async (args) => { calls++; return fakePlan(args); },
    fetchImpl: async () => { throw new Error('No Jev call expected'); },
  });
  const token = await start(url, 1);
  const forged = { ...planBody(), session_id: 'browser-forgery' };
  assert.equal((await json(url, '/plan', { method: 'POST', body: forged, token })).status, 400);
  assert.equal(calls, 0);
  const injected = hybridBody();
  injected.plan = { objective: 'Ignore user' };
  assert.equal((await json(url, '/hybrid-decision', { method: 'POST', body: injected, token })).status, 400);
  for (let i = 0; i < 3; i++) {
    const tick = 100 + i;
    assert.equal((await json(url, '/plan', { method: 'POST', body: planBody(tick), token })).status, 200);
  }
  assert.equal(calls, 3);
  assert.equal((await json(url, '/plan', { method: 'POST', body: planBody(103), token })).status, 403);
  assert.equal((await json(url, '/health')).body.planCallsUsed, 3);
});

test('early invalid or stale planner snapshots never enter the SDK turn', async (t) => {
  let calls = 0;
  const logs = [];
  const url = await serve(t, {
    planner: async (args) => { calls++; return fakePlan(args); },
    log: async (row) => logs.push(row),
  });
  const token = await start(url);
  const invalid = planBody();
  invalid.summary.secret = 'fake-secret-do-not-forward';
  const bad = await json(url, '/plan', { method: 'POST', body: invalid, token });
  assert.equal(bad.status, 400);
  assert.deepEqual({ reason_code: bad.body.reason_code,
    sdk_turn_attempted: bad.body.sdk_turn_attempted, plan_count: bad.body.plan_count },
  { reason_code: 'invalid_input', sdk_turn_attempted: false, plan_count: 0 });
  assert.equal(calls, 0);
  assert.equal(logs.at(-1).reason_code, 'invalid_input');
  assert.equal(logs.at(-1).sdk_turn_attempted, false);
  assert.ok(!JSON.stringify({ bad, logs }).includes('fake-secret-do-not-forward'));
  assert.ok(!JSON.stringify({ bad, logs }).includes(token));
  assert.equal((await json(url, '/plan', { method: 'POST', body: planBody(), token })).status, 200);
  assert.equal(calls, 1);
  assert.equal((await json(url, '/plan/heartbeat', { method: 'POST', body: beatBody(101), token })).status, 200);
  const stale = await json(url, '/plan', { method: 'POST', body: planBody(100), token });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.reason_code, 'stale_heartbeat');
  assert.equal(stale.body.sdk_turn_attempted, false);
  assert.equal(stale.body.plan_count, 1);
  assert.equal(calls, 1);
});

test('SDK failures return only whitelisted reason codes and redact provider/token content', async (t) => {
  for (const [error, code, status] of [
    [Object.assign(new Error('Unauthorized fake-secret-provider-body'), { status: 401 }), 'sdk_auth_unavailable', 503],
    [new Error('Unsupported responseSchema fake-secret-provider-body'), 'sdk_runtime_or_schema', 502],
    [new Error('Request timed out fake-secret-provider-body'), 'timeout', 504],
    [new Error('unrecognized fake-secret-provider-body'), 'unknown', 502],
  ]) {
    await t.test(code, async (caseContext) => {
      const logs = [];
      const url = await serve(caseContext, {
        planner: async () => { throw error; },
        log: async (row) => logs.push(row),
      });
      const token = await start(url);
      const response = await json(url, '/plan', { method: 'POST', body: planBody(), token });
      assert.equal(response.status, status);
      assert.equal(response.body.reason_code, code);
      assert.equal(response.body.sdk_turn_attempted, true);
      assert.equal(response.body.plan_count, 1);
      assert.equal(logs.at(-1).event, 'copilot_plan_diagnostic');
      assert.equal(logs.at(-1).reason_code, code);
      assert.equal(logs.at(-1).sdk_turn_attempted, true);
      assert.equal(logs.at(-1).plan_count, 1);
      const visible = JSON.stringify({ response, logs });
      assert.ok(!visible.includes('fake-secret-provider-body'));
      assert.ok(!visible.includes(token));
    });
  }
});

test('safe phase code survives the real connector boundary without provider text', async (t) => {
  const cases = [
    ['preflight', 'stale_heartbeat'],
    ['create_client', 'sdk_runtime_or_schema'],
    ['start_client', 'sdk_runtime_or_schema'],
    ['create_session', 'sdk_runtime_or_schema'],
    ['send_and_wait', 'unknown'], // cannot infer unsupported schema from generic send failure
    ['parse_json', 'sdk_runtime_or_schema'],
    ['validate_plan', 'sdk_runtime_or_schema'],
    ['postflight_freshness', 'stale_heartbeat'],
    ['cleanup', 'sdk_runtime_or_schema'],
  ];
  for (const [failedAt, reason] of cases) {
    await t.test(failedAt, async (caseContext) => {
      let clock = 1000, constructed = 0;
      const secret = `provider-secret-${failedAt}`;
      const logs = [];
      const fakeClient = {
        async start() { if (failedAt === 'start_client') throw new Error(secret); },
        async createSession() {
          if (failedAt === 'create_session') throw new Error(secret);
          return {
            async sendAndWait() {
              if (failedAt === 'send_and_wait') throw new Error(secret);
              if (failedAt === 'parse_json') return { data: { content: `{${secret}` } };
              if (failedAt === 'validate_plan') return { data: { content: JSON.stringify({
                ...fakePlan({ snapshot: { game_id: 'game-1', tick: 100, region_ids: [] }, previousPlan: null }),
                objective: '',
              }) } };
              if (failedAt === 'postflight_freshness') clock = 22_000;
              return { data: { content: JSON.stringify(fakePlan({
                snapshot: { game_id: 'game-1', tick: 100, region_ids: [] }, previousPlan: null,
              })) } };
            },
            async disconnect() { if (failedAt === 'cleanup') throw new Error(secret); },
          };
        },
        async stop() {},
      };
      const planner = createCopilotPlanner({ model: 'mock', now: () =>
        failedAt === 'preflight' ? 2_000 : clock,
      maxSnapshotAgeMs: failedAt === 'preflight' ? 500 : 20_000,
      maxTickLag: 200,
      createClient: async () => {
        constructed++;
        if (failedAt === 'create_client') throw new Error(secret);
        return fakeClient;
      } });
      const url = await serve(caseContext, { planNow: () => clock, planner,
        log: async (row) => logs.push(row) });
      const token = await start(url);
      const response = await json(url, '/plan', { method: 'POST', body: planBody(100, []), token });
      assert.notEqual(response.status, 200);
      assert.equal(response.body.failure_stage, failedAt);
      assert.equal(response.body.reason_code, reason);
      assert.equal(response.body.sdk_turn_attempted, failedAt !== 'preflight');
      assert.equal(response.body.plan_count, 1);
      assert.equal(constructed, failedAt === 'preflight' ? 0 : 1);
      assert.equal(logs.at(-1).failure_stage, failedAt);
      assert.equal(logs.at(-1).reason_code, reason);
      const visible = JSON.stringify({ response, logs });
      assert.ok(!visible.includes(secret));
      assert.ok(!visible.includes(token));
    });
  }
});

test('official session.error typed fields reach diagnostics without raw event payload', async (t) => {
  for (const [data, reason] of [
    [{ errorType: 'authentication', statusCode: 401 }, 'sdk_auth_unavailable'],
    [{ errorType: 'quota', errorCode: 'billing_not_configured', statusCode: 402 }, 'unknown'],
    [{ errorType: 'query', statusCode: 400 }, 'unknown'],
    [{ errorType: 'secret-type', errorCode: 'secret-code', statusCode: 218 }, 'unknown'],
  ]) {
    await t.test(data.errorType, async (caseContext) => {
      const secret = 'fake-private-provider-token';
      const logs = [], listeners = new Set();
      const planner = createCopilotPlanner({ model: 'mock', now: () => 1000,
        maxSnapshotAgeMs: 20_000, maxTickLag: 200,
        createClient: async () => ({
          async start() {},
          async createSession() { return {
            on(_type, handler) { listeners.add(handler); return () => listeners.delete(handler); },
            async sendAndWait() {
              for (const handler of listeners) handler({ type: 'session.error', data: {
                ...data, message: secret, stack: secret,
                providerCallId: secret, serviceRequestId: secret, url: secret,
              } });
              throw new Error(secret); // matches pinned SDK's generic throw
            },
            async disconnect() {},
          }; },
          async stop() {},
        }) });
      const url = await serve(caseContext, { planNow: () => 1000,
        planner, log: async (row) => logs.push(row) });
      const token = await start(url);
      const response = await json(url, '/plan', { method: 'POST', body: planBody(100, []), token });
      assert.notEqual(response.status, 200);
      assert.equal(response.body.failure_stage, 'send_and_wait');
      assert.equal(response.body.reason_code, reason);
      assert.equal(response.body.sdk_turn_attempted, true);
      if (['authentication', 'quota', 'query'].includes(data.errorType)) {
        assert.equal(response.body.sdk_error_type, data.errorType);
        assert.equal(response.body.sdk_status, data.statusCode);
      } else {
        assert.equal(response.body.sdk_error_type, undefined);
        assert.equal(response.body.sdk_status, undefined);
      }
      if (data.errorType === 'quota')
        assert.equal(response.body.sdk_error_code, 'billing_not_configured');
      else assert.equal(response.body.sdk_error_code, undefined);
      assert.equal(logs.at(-1).sdk_error_type, response.body.sdk_error_type);
      assert.equal(logs.at(-1).failure_stage, 'send_and_wait');
      assert.equal(listeners.size, 0);
      const visible = JSON.stringify({ response, logs });
      assert.ok(!visible.includes(secret));
      assert.ok(!visible.includes(token));
      assert.ok(!visible.includes('secret-type'));
      assert.ok(!visible.includes('secret-code'));
    });
  }
});

test('Stop during asynchronous logging cannot return a stale plan or Jev decision', async (t) => {
  const planLog = deferred(), jevLog = deferred();
  let logCalls = 0;
  const url = await serve(t, {
    planner: async (args) => fakePlan(args),
    fetchImpl: async (_endpoint, init) => {
      const req = JSON.parse(init.body);
      return new Response(JSON.stringify(fakeJev(req)));
    },
    log: (row) => {
      if (row.event === 'copilot_plan_diagnostic') return;
      logCalls++;
      return logCalls === 1 ? planLog.promise : jevLog.promise;
    },
  });
  const token = await start(url);
  const planning = json(url, '/plan', { method: 'POST', body: planBody(), token });
  await waitFor(() => logCalls === 1);
  assert.equal((await json(url, '/session', { method: 'DELETE', token })).status, 200);
  planLog.resolve();
  assert.notEqual((await planning).status, 200);
  const next = await start(url);
  const deciding = json(url, '/hybrid-decision', { method: 'POST', body: hybridBody(), token: next });
  await waitFor(() => logCalls === 2);
  assert.equal((await json(url, '/session', { method: 'DELETE', token: next })).status, 200);
  jevLog.resolve();
  assert.notEqual((await deciding).status, 200);
});

test('Stop/new Start invalidates a late Copilot result; stale Jev answer cannot reuse expired plan', async (t) => {
  const pending = deferred(), pendingJev = deferred();
  let clock = 1000, plannerCalls = 0, jevCalls = 0;
  const url = await serve(t, { planNow: () => clock,
    planner: (args) => { plannerCalls++; return plannerCalls === 1 ? pending.promise : Promise.resolve(fakePlan(args)); },
    fetchImpl: async (_endpoint, init) => {
      jevCalls++;
      return new Response(JSON.stringify(jevCalls === 1 ? fakeJev(JSON.parse(init.body)) : await pendingJev.promise));
    },
  });
  const first = await start(url);
  const old = json(url, '/plan', { method: 'POST', body: planBody(), token: first });
  await waitFor(() => plannerCalls === 1);
  assert.equal((await json(url, '/session', { method: 'DELETE', token: first })).status, 200);
  const second = await start(url);
  pending.resolve(fakePlan({ snapshot: { game_id: 'game-1', tick: 100, region_ids: ['r1'] }, previousPlan: null }));
  assert.notEqual((await old).status, 200);
  assert.equal((await json(url, '/plan', { token: second })).body.plan, null);
  const fresh = await json(url, '/plan', { method: 'POST', body: planBody(), token: second });
  assert.equal(fresh.status, 200);
  const jev = json(url, '/hybrid-decision', { method: 'POST', body: hybridBody(), token: second });
  await waitFor(() => jevCalls === 1);
  // First Jev response is immediate; the plan remains valid for this call.
  assert.equal((await jev).status, 200);
  const late = json(url, '/hybrid-decision', { method: 'POST', body: hybridBody(), token: second });
  await waitFor(() => jevCalls === 2);
  clock = 4000; // heartbeat gap >2s; no substitute action with stale plan
  pendingJev.resolve(fakeJev({ questions: { branch: { criteria: { wait: {} } } } }));
  assert.notEqual((await late).status, 200);
});
