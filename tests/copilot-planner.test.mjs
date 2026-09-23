import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import { createCopilotPlanner, validatePlan, CopilotPhaseError,
  COPILOT_FAILURE_STAGES } from '../src/copilot-planner.mjs';

const phase = (expected) => (error) => {
  assert.ok(error instanceof CopilotPhaseError);
  assert.equal(error.failure_stage, expected);
  assert.ok(COPILOT_FAILURE_STAGES.includes(error.failure_stage));
  return true;
};

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

test('pinned official SDK exposes a local runtime and structured-output session API without starting it', () => {
  const app = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installed = JSON.parse(readFileSync(new URL('../node_modules/@github/copilot-sdk/package.json', import.meta.url), 'utf8'));
  assert.equal(app.dependencies['@github/copilot-sdk'], '1.0.15-preview.1');
  assert.equal(installed.version, '1.0.15-preview.1');
  const client = new CopilotClient({ mode: 'empty', baseDirectory: join(tmpdir(), 'openfront-copilot-test') });
  assert.equal(typeof client.start, 'function');
  assert.equal(typeof CopilotSession.prototype.sendAndWait, 'function');
  if (process.platform === 'linux' && process.arch === 'x64') {
    const runtime = readFileSync(new URL('../node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/copilot-runtime', import.meta.url));
    assert.ok(runtime.byteLength > 0);
  }
  // Constructing the client and inspecting package artifacts makes no request.
});

test('single-probe harness is inert by default and refuses partial authorization', () => {
  const path = new URL('../scripts/probe-copilot-plan.mjs', import.meta.url).pathname;
  const dry = spawnSync(process.execPath, [path], { encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /DRY RUN/);
  const refused = spawnSync(process.execPath, [path, '--run'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /explicit Moritz approval/);
});

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
    await assert.rejects(h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState }), phase('validate_plan'));
    assert.deepEqual(h.calls.slice(-2), ['disconnect', 'stop']);
  }
  const h = harness({ reply: 'not json' });
  await assert.rejects(h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState }), phase('parse_json'));
  assert.deepEqual(h.calls.slice(-2), ['disconnect', 'stop']);
});

test('rejects outdated observations without opening a session', async () => {
  const h = harness({ now: () => 5000 });
  await assert.rejects(h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState }), phase('preflight'));
  assert.deepEqual(h.calls, []);
});

test('rejects changed plan version or game tick before and after inference', async () => {
  const h = harness();
  h.setCurrent({ game_id: 'solo-1', tick: 421, plan_version: 0 });
  await assert.rejects(h.plan({ snapshot: snapshot(), getCurrentState: h.getCurrentState }), phase('preflight'));
  assert.deepEqual(h.calls, []);

  const after = harness();
  const originalCreateClient = after.plan; // use a callback that changes after its first read
  let reads = 0;
  await assert.rejects(originalCreateClient({ snapshot: snapshot(), getCurrentState: () => {
    reads++;
    return { game_id: 'solo-1', tick: reads === 1 ? 420 : 441, plan_version: 0 };
  } }), phase('postflight_freshness'));
  assert.deepEqual(after.calls.slice(-2), ['disconnect', 'stop']);

  const version = harness();
  let seen = 0;
  await assert.rejects(version.plan({ snapshot: snapshot(), getCurrentState: () =>
    ({ game_id: 'solo-1', tick: 420, plan_version: seen++ ? 1 : 0 }) }), phase('postflight_freshness'));
});

test('missing fresh-state callback fails before opening a client', async () => {
  const h = harness();
  await assert.rejects(h.plan({ snapshot: snapshot() }), phase('preflight'));
  assert.deepEqual(h.calls, []);
});

test('snapshot is bounded and cannot contain unknown root fields', async () => {
  const h = harness();
  await assert.rejects(h.plan({ snapshot: { ...snapshot(), private_key: 'do not send' }, getCurrentState: h.getCurrentState }), phase('preflight'));
  await assert.rejects(h.plan({ snapshot: { ...snapshot(), summary: { huge: 'x'.repeat(17000) } }, getCurrentState: h.getCurrentState }), phase('preflight'));
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
    ({ game_id: 'solo-1', tick: 420, plan_version: 0 }) }), phase('send_and_wait'));
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
    getCurrentState: h.getCurrentState }), phase('preflight'));
  await assert.rejects(h.plan({ snapshot: snapshot(), previousPlan: { ...answer(), game_id: 'another-game' },
    getCurrentState: h.getCurrentState }), phase('preflight'));
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

test('fixed SDK phase tags redact upstream errors and preserve cleanup ordering', async () => {
  for (const failedAt of ['create_client', 'start_client', 'create_session',
    'send_and_wait', 'parse_json', 'validate_plan', 'postflight_freshness', 'cleanup']) {
    const calls = [];
    let reads = 0;
    const secret = `raw-secret-${failedAt}`;
    const client = {
      async start() { calls.push('start'); if (failedAt === 'start_client') throw new Error(secret); },
      async createSession() {
        calls.push('session');
        if (failedAt === 'create_session') throw new Error(secret);
        return {
          async sendAndWait() {
            calls.push('send');
            if (failedAt === 'send_and_wait') throw new Error(secret);
            if (failedAt === 'parse_json') return { data: { content: `{${secret}` } };
            if (failedAt === 'validate_plan') return { data: { content: JSON.stringify({ ...answer(), objective: '' }) } };
            return { data: { content: JSON.stringify(answer()) } };
          },
          async disconnect() { calls.push('disconnect'); if (failedAt === 'cleanup') throw new Error(secret); },
        };
      },
      async stop() { calls.push('stop'); },
    };
    const planner = createCopilotPlanner({ model: 'mock', now: () => 1100,
      createClient: async () => {
        calls.push('create');
        if (failedAt === 'create_client') throw new Error(secret);
        return client;
      } });
    await assert.rejects(planner({ snapshot: snapshot(), getCurrentState: () => ({
      game_id: 'solo-1', tick: failedAt === 'postflight_freshness' && reads++ ? 441 : 420,
      plan_version: 0,
    }) }), (error) => {
      phase(failedAt)(error);
      assert.equal(error.cause, undefined);
      assert.ok(!String(error).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
    if (failedAt !== 'create_client') assert.equal(calls.at(-1), 'stop');
  }
});

test('cleanup cannot replace the first failed phase; only fixed auth/timeout metadata survives', async () => {
  const secret = 'raw-secret-provider-token';
  const auth = Object.assign(new Error(secret), { status: 401 });
  const client = {
    async start() {},
    async createSession() { return {
      async sendAndWait() { throw auth; },
      async disconnect() { throw new Error(secret); },
    }; },
    async stop() { throw new Error(secret); },
  };
  const planner = createCopilotPlanner({ model: 'mock', now: () => 1100,
    createClient: async () => client });
  await assert.rejects(planner({ snapshot: snapshot(), getCurrentState: () =>
    ({ game_id: 'solo-1', tick: 420, plan_version: 0 }) }), (error) => {
    phase('send_and_wait')(error);
    assert.equal(error.status, 401);
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
});
