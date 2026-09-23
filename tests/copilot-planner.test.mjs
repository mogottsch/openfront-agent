import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCopilotPlanner, validatePlan } from '../src/copilot-planner.mjs';

const snapshot = () => ({
  game_id: 'solo-1', tick: 420, observed_at_ms: 1000,
  region_ids: ['r1', 'r2'], summary: { phase: 'opening', economy: { gold: 950 } },
});
const answer = () => ({
  schema_version: 1, plan_version: 1, game_id: 'solo-1', source_tick: 420,
  expires_tick: 450, objective: 'Prepare a defensible economic foothold',
  region_priorities: [{ region_id: 'r1', priority: 'high', reason: 'Potential connection' }],
  replan_on: ['border_change'],
});

function harness({ reply = answer(), now = () => 1100 } = {}) {
  const calls = [];
  let current = { game_id: 'solo-1', tick: 420, plan_version: 0 };
  const client = {
    async start() { calls.push('start'); },
    async createSession(config) {
      calls.push(['createSession', config]);
      return {
        async sendAndWait(message, timeout) {
          calls.push(['sendAndWait', message, timeout]);
          return { data: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } };
        },
        async disconnect() { calls.push('disconnect'); },
      };
    },
    async stop() { calls.push('stop'); },
  };
  const createClient = async () => { calls.push('createClient'); return client; };
  const plan = createCopilotPlanner({ createClient, model: 'test-model', now });
  return { calls, plan, getCurrentState: () => current, setCurrent(value) { current = value; } };
}

test('no Copilot activity until explicitly invoked; zero tools and strict structured output', async () => {
  const h = harness();
  assert.deepEqual(h.calls, []);
  const plan = await h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState });
  assert.deepEqual(plan, answer());
  assert.deepEqual(h.calls.map((entry) => Array.isArray(entry) ? entry[0] : entry),
    ['createClient', 'start', 'createSession', 'sendAndWait', 'disconnect', 'stop']);
  const config = h.calls[2][1];
  assert.deepEqual(config.availableTools, []);
  assert.deepEqual(config.onPermissionRequest({ kind: 'shell' }), { kind: 'reject', feedback: 'Planner has no tool permissions.' });
  assert.deepEqual(config.hooks.onPreToolUse({ toolName: 'shell' }), { permissionDecision: 'deny' });
  const [,, timeout] = h.calls[3];
  assert.equal(timeout, 10_000);
  const request = h.calls[3][1];
  assert.equal(request.responseSchema.additionalProperties, false);
  assert.equal(JSON.parse(request.prompt).expected_plan_version, 1);
  assert.equal(JSON.parse(request.prompt).state.summary.economy.gold, 950);
});

test('rejects unsourced, excess, stale and invalid plans, with cleanup', async () => {
  const invalid = [
    { ...answer(), extra: true },
    { ...answer(), plan_version: 2 },
    { ...answer(), game_id: 'other' },
    { ...answer(), source_tick: 421 },
    { ...answer(), expires_tick: 420 },
    { ...answer(), expires_tick: 99999 },
    { ...answer(), region_priorities: [{ region_id: 'unknown', priority: 'high', reason: 'x' }] },
    { ...answer(), region_priorities: [answer().region_priorities[0], answer().region_priorities[0]] },
    { ...answer(), replan_on: ['unknown'] },
    { ...answer(), replan_on: ['border_change', 'border_change'] },
  ];
  for (const reply of invalid) {
    const h = harness({ reply });
    await assert.rejects(h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState }), /Invalid or stale/);
    assert.deepEqual(h.calls.slice(-2), ['disconnect', 'stop']);
  }
  const h = harness({ reply: 'not json' });
  await assert.rejects(h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState }), /invalid JSON/);
  assert.deepEqual(h.calls.slice(-2), ['disconnect', 'stop']);
});

test('rejects outdated observations without opening a session', async () => {
  const h = harness({ now: () => 5000 });
  await assert.rejects(h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState }), /Stale planner snapshot/);
  assert.deepEqual(h.calls, []);
});

test('rejects changed plan version or game tick before and after inference', async () => {
  const h = harness();
  h.setCurrent({ game_id: 'solo-1', tick: 421, plan_version: 0 });
  await assert.rejects(h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState }), /superseded before/);
  assert.deepEqual(h.calls, []);

  const after = harness();
  const originalCreateClient = after.plan; // use a callback that changes after its first read
  let reads = 0;
  await assert.rejects(originalCreateClient({ snapshot: snapshot(), getCurrentState: () => {
    reads++;
    return { game_id: 'solo-1', tick: reads === 1 ? 420 : 441, plan_version: 0 };
  } }), /superseded during/);
  assert.deepEqual(after.calls.slice(-2), ['disconnect', 'stop']);

  const version = harness();
  let seen = 0;
  await assert.rejects(version.plan({ snapshot: snapshot(), getCurrentState: () =>
    ({ game_id: 'solo-1', tick: 420, plan_version: seen++ ? 1 : 0 }) }), /superseded during/);
});

test('missing fresh-state callback fails before opening a client', async () => {
  const h = harness();
  await assert.rejects(h.plan({ snapshot: snapshot() }), /fresh-state callback/);
  assert.deepEqual(h.calls, []);
});

test('snapshot is bounded and cannot contain unknown root fields', async () => {
  const h = harness();
  await assert.rejects(h.plan({ snapshot: { ...snapshot(), private_key: 'do not send' }, getCurrentState: h.getCurrentState }), /Invalid planner snapshot/);
  await assert.rejects(h.plan({ snapshot: { ...snapshot(), summary: { huge: 'x'.repeat(17000) } }, getCurrentState: h.getCurrentState }), /16 KiB/);
  assert.deepEqual(h.calls, []);
});

test('an SDK failure still disconnects and stops the client', async () => {
  const calls = [];
  const planner = createCopilotPlanner({ model: 'test-model', now: () => 1100, createClient: async () => ({
    async start() { calls.push('start'); },
    async createSession() { return {
      async sendAndWait() { throw new Error('runtime unavailable'); },
      async disconnect() { calls.push('disconnect'); },
    }; },
    async stop() { calls.push('stop'); },
  }) });
  await assert.rejects(planner({ snapshot: snapshot(), getCurrentState: () =>
    ({ game_id: 'solo-1', tick: 420, plan_version: 0 }) }), /runtime unavailable/);
  assert.deepEqual(calls, ['start', 'disconnect', 'stop']);
});

test('previous plan version increments and is reflected in prompt', async () => {
  const response = { ...answer(), plan_version: 2, source_tick: 425, expires_tick: 455 };
  const h = harness({ reply: response });
  h.setCurrent({ game_id: 'solo-1', tick: 425, plan_version: 1 });
  const snap = { ...snapshot(), tick: 425 };
  assert.deepEqual(await h.plan({ snapshot: snap, previousPlan: answer(), getCurrentState: h.getCurrentState }), response);
  assert.equal(JSON.parse(h.calls[3][1].prompt).expected_plan_version, 2);
  assert.throws(() => validatePlan({ ...answer(), objective: '' }, {
    snapshot: snapshot(), previousVersion: 0, maxPlanTicks: 300,
  }), /Invalid or stale/);
});

test('previous-plan input cannot smuggle extra fields or context across games', async () => {
  const h = harness();
  await assert.rejects(h.plan({ snapshot: snapshot(), previousPlan: { ...answer(), token: 'secret' },
    getCurrentState: h.getCurrentState }), /Invalid previous plan/);
  await assert.rejects(h.plan({ snapshot: snapshot(), previousPlan: { ...answer(), game_id: 'another-game' },
    getCurrentState: h.getCurrentState }), /Invalid previous plan/);
  assert.deepEqual(h.calls, []);
});

test('expired previous plan is not forwarded, but its version still protects against races', async () => {
  const old = { ...answer(), expires_tick: 421 };
  const reply = { ...answer(), plan_version: 2, source_tick: 425, expires_tick: 450 };
  const h = harness({ reply });
  h.setCurrent({ game_id: 'solo-1', tick: 425, plan_version: 1 });
  await h.plan({ snapshot: { ...snapshot(), tick: 425 }, previousPlan: old, getCurrentState: h.getCurrentState });
  assert.equal(JSON.parse(h.calls[3][1].prompt).previous_plan, null);
});
