// Isolated, opt-in server-side planner prototype. Nothing imports or calls Copilot
// until plan() is explicitly invoked by a future, separately approved controller.
// Official SDK: https://github.com/github/copilot-sdk/tree/main/nodejs
// Backend isolation: https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPLAN_EVENTS = ['border_change', 'incoming_attack', 'structure_change', 'economy_change'];
const PRIORITIES = ['high', 'medium', 'low'];
const keysAre = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

// Provider-compatible JSON Schema subset. Lengths, bounds, uniqueness,
// references and freshness are enforced by validatePlan below; providers may
// reject these constraint keywords even when they accept structured output.
export const PLAN_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'plan_version', 'game_id', 'source_tick', 'expires_tick', 'objective', 'region_priorities', 'replan_on'],
  properties: {
    schema_version: { type: 'integer', enum: [1] },
    plan_version: { type: 'integer' },
    game_id: { type: 'string' },
    source_tick: { type: 'integer' },
    expires_tick: { type: 'integer' },
    objective: { type: 'string' },
    region_priorities: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['region_id', 'priority', 'reason'],
      properties: { region_id: { type: 'string' }, priority: { type: 'string', enum: PRIORITIES }, reason: { type: 'string' } },
    } },
    replan_on: { type: 'array', items: { type: 'string', enum: REPLAN_EVENTS } },
  },
});

export const COPILOT_FAILURE_STAGES = Object.freeze([
  'preflight', 'create_client', 'start_client', 'create_session',
  'build_prompt', 'send_and_wait', 'parse_json', 'validate_plan',
  'postflight_freshness', 'cleanup', 'unexpected',
]);

// SDK ErrorData also contains free-form message/stack/URL/request IDs. Never
// copy those into application errors or logs, even indirectly via cause.
const SDK_ERROR_TYPES = Object.freeze([
  'authentication', 'authorization', 'quota', 'rate_limit',
  'context_limit', 'query',
]);
const SDK_QUOTA_CODES = Object.freeze([
  'quota_exceeded', 'session_quota_exceeded', 'billing_not_configured',
]);
const SDK_RATE_CODES = Object.freeze([
  'user_weekly_rate_limited', 'user_global_rate_limited', 'rate_limited',
  'user_model_rate_limited', 'integration_rate_limited',
]);
const SDK_HTTP_STATUSES = Object.freeze([400, 401, 402, 403, 404, 408, 409,
  413, 422, 429, 500, 502, 503, 504]);
function safeSdkErrorData(data) {
  const type = SDK_ERROR_TYPES.includes(data?.errorType) ? data.errorType : null;
  const codes = type === 'quota' ? SDK_QUOTA_CODES :
    type === 'rate_limit' ? SDK_RATE_CODES : [];
  const code = codes.includes(data?.errorCode) ? data.errorCode : null;
  const status = SDK_HTTP_STATUSES.includes(data?.statusCode) ? data.statusCode : null;
  return { type, code, status };
}

export class CopilotPhaseError extends Error {
  constructor(stage, original) {
    if (!COPILOT_FAILURE_STAGES.includes(stage)) throw new Error('Invalid Copilot phase');
    // Never retain raw error messages, causes, provider bodies or credentials.
    super(`Copilot planner failed (${stage})`);
    this.name = 'CopilotPhaseError';
    this.failure_stage = stage;
    const status = Number(original?.status ?? original?.statusCode);
    if (status === 401 || status === 403) this.status = status;
    if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_MODULE_NOT_FOUND',
      'MODULE_NOT_FOUND'].includes(original?.code)) this.code = original.code;
    if (original?.name === 'TimeoutError') this.diagnostic_kind = 'timeout';
    if (original?.name === 'AuthenticationError') this.diagnostic_kind = 'auth';
  }
  attachSdkError(safe) {
    if (this.failure_stage !== 'send_and_wait' || !safe) return;
    if (SDK_ERROR_TYPES.includes(safe.type)) this.sdk_error_type = safe.type;
    if ([...SDK_QUOTA_CODES, ...SDK_RATE_CODES].includes(safe.code))
      this.sdk_error_code = safe.code;
    if (SDK_HTTP_STATUSES.includes(safe.status)) this.sdk_status = safe.status;
  }
}

const atPhase = async (stage, fn) => {
  try { return await fn(); } catch (error) { throw new CopilotPhaseError(stage, error); }
};
const atPhaseSync = (stage, fn) => {
  try { return fn(); } catch (error) { throw new CopilotPhaseError(stage, error); }
};

function validateSnapshot(snapshot) {
  if (!keysAre(snapshot, ['game_id', 'tick', 'observed_at_ms', 'region_ids', 'summary']) ||
      !text(snapshot.game_id, 100) || !integer(snapshot.tick) ||
      !Number.isFinite(snapshot.observed_at_ms) || snapshot.observed_at_ms < 0 ||
      !Array.isArray(snapshot.region_ids) || snapshot.region_ids.length > 16 ||
      snapshot.region_ids.some((id) => !text(id, 100)) ||
      new Set(snapshot.region_ids).size !== snapshot.region_ids.length ||
      snapshot.summary === null || typeof snapshot.summary !== 'object' || Array.isArray(snapshot.summary)) {
    throw new Error('Invalid planner snapshot');
  }
  // Prevent arbitrarily large or unserializable observations. Only an approved
  // server-side projection should ever be passed here; this module does not gather game data.
  const json = JSON.stringify(snapshot);
  if (!json || Buffer.byteLength(json, 'utf8') > 16_384) throw new Error('Planner snapshot exceeds 16 KiB');
  return json;
}

export function validatePlan(plan, { snapshot, previousVersion, maxPlanTicks }) {
  if (!keysAre(plan, PLAN_SCHEMA.required) || plan.schema_version !== 1 ||
      !integer(plan.plan_version) || plan.plan_version !== previousVersion + 1 ||
      plan.game_id !== snapshot.game_id || plan.source_tick !== snapshot.tick ||
      !integer(plan.expires_tick) || plan.expires_tick <= snapshot.tick ||
      plan.expires_tick > snapshot.tick + maxPlanTicks ||
      !text(plan.objective, 240) || !Array.isArray(plan.region_priorities) || plan.region_priorities.length > 16 ||
      plan.region_priorities.some((entry) => !keysAre(entry, ['region_id', 'priority', 'reason']) ||
        !text(entry.region_id, 100) || !snapshot.region_ids.includes(entry.region_id) ||
        !PRIORITIES.includes(entry.priority) || !text(entry.reason, 180)) ||
      new Set(plan.region_priorities.map((entry) => entry.region_id)).size !== plan.region_priorities.length ||
      !Array.isArray(plan.replan_on) || plan.replan_on.length > REPLAN_EVENTS.length ||
      plan.replan_on.some((event) => !REPLAN_EVENTS.includes(event)) || new Set(plan.replan_on).size !== plan.replan_on.length) {
    throw new Error('Invalid or stale Copilot plan');
  }
  return plan;
}

export function hasCopilotServerToken(environment = process.env) {
  const token = environment?.COPILOT_GITHUB_TOKEN;
  return typeof token === 'string' && token.length > 0 && !/\s/.test(token);
}

export function buildCopilotClientOptions(environment = process.env) {
  if (!hasCopilotServerToken(environment)) {
    const error = new Error('Copilot server credential unavailable');
    error.name = 'AuthenticationError'; // safe typed hint, never the token
    throw error;
  }
  // The SDK defaults to inheriting process.env, which would also give its
  // runtime the TypeSafe sidecar key and lower-priority GH_TOKEN/GITHUB_TOKEN.
  // Give the child only ordinary process/network settings and the explicit
  // Copilot credential; no browser/CLI login, BYOK, or ambient GitHub fallback.
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'XDG_RUNTIME_DIR',
    'LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
  const env = Object.fromEntries(allowed.filter((key) =>
    typeof environment[key] === 'string').map((key) => [key, environment[key]]));
  env.COPILOT_GITHUB_TOKEN = environment.COPILOT_GITHUB_TOKEN;
  return {
    mode: 'empty', useLoggedInUser: false, logLevel: 'none',
    baseDirectory: join(tmpdir(), 'openfront-copilot-planner'), env,
  };
}

async function defaultClientFactory() {
  // Fail before importing or starting the bundled runtime when the explicit
  // credential is absent. Preview structured output is validated locally too.
  const options = buildCopilotClientOptions();
  const { CopilotClient } = await import('@github/copilot-sdk');
  return new CopilotClient(options);
}

/** The caller owns the approved input projection, lifecycle, and scheduling.
 * createClient injection supports network-free tests. Never call from the browser.
 */
export function createCopilotPlanner({
  createClient = defaultClientFactory, model, now = Date.now,
  timeoutMs = 10_000, maxSnapshotAgeMs = 2_000, maxTickLag = 20, maxPlanTicks = 300,
} = {}) {
  if (typeof createClient !== 'function' || typeof now !== 'function' || !text(model, 100) ||
      !integer(timeoutMs) || timeoutMs === 0 || !integer(maxSnapshotAgeMs) ||
      !integer(maxTickLag) || !integer(maxPlanTicks) || maxPlanTicks === 0) {
    throw new Error('Invalid Copilot planner configuration');
  }

  return async function plan({ snapshot, previousPlan = null, getCurrentState }) {
    const { snapshotJson, previousVersion } = atPhaseSync('preflight', () => {
      const snapshotJson = validateSnapshot(snapshot);
      if (typeof getCurrentState !== 'function') throw new Error('A fresh-state callback is required');
      const previousVersion = previousPlan === null ? 0 : previousPlan.plan_version;
      if (!integer(previousVersion)) throw new Error('Invalid previous plan version');
      if (previousPlan !== null) {
        if (previousVersion === 0 || !Array.isArray(previousPlan.region_priorities)) throw new Error('Invalid previous plan');
        // An earlier plan cannot smuggle arbitrary fields into the next prompt.
        try {
          validatePlan(previousPlan, {
            snapshot: { game_id: snapshot.game_id, tick: previousPlan.source_tick,
              region_ids: previousPlan.region_priorities.map((entry) => entry?.region_id) },
            previousVersion: previousVersion - 1, maxPlanTicks,
          });
        } catch { throw new Error('Invalid previous plan'); }
        if (previousPlan.source_tick > snapshot.tick) throw new Error('Previous plan comes from a future tick');
      }
      if (now() < snapshot.observed_at_ms || now() - snapshot.observed_at_ms > maxSnapshotAgeMs)
        throw new Error('Stale planner snapshot');
      const current = getCurrentState();
      if (!keysAre(current, ['game_id', 'tick', 'plan_version']) || current.game_id !== snapshot.game_id ||
          current.tick !== snapshot.tick || current.plan_version !== previousVersion)
        throw new Error('Planner snapshot superseded before request');
      return { snapshotJson, previousVersion };
    });

    let client;
    let session;
    let result;
    let failure = null;
    try {
      client = await atPhase('create_client', () => createClient());
      await atPhase('start_client', () => client.start());
      session = await atPhase('create_session', () => client.createSession({
        model, availableTools: [],
        // Defense in depth even if runtime defaults change; no CLI/shell/files/web tools.
        onPermissionRequest: () => ({ kind: 'reject', feedback: 'Planner has no tool permissions.' }),
        hooks: { onPreToolUse: () => ({ permissionDecision: 'deny' }) },
      }));
      const prompt = atPhaseSync('build_prompt', () => JSON.stringify({
        task: 'Propose one short-lived strategic objective from only the supplied approved state. Return only JSON conforming to responseSchema. No commands, tools or executable actions.',
        state: JSON.parse(snapshotJson),
        previous_plan: previousPlan?.expires_tick > snapshot.tick ? previousPlan : null,
        expected_plan_version: previousVersion + 1, max_expires_tick: snapshot.tick + maxPlanTicks,
      }));
      // SDK structured output is preview. Its sendAndWait converts a typed
      // session.error into a plain Error(message), dropping ErrorData fields.
      // Subscribe only for this one turn and retain ONLY fixed-code metadata.
      let captured = null;
      let unsubscribe;
      let sendFailure = null;
      let response;
      try {
        if (typeof session.on === 'function') {
          unsubscribe = atPhaseSync('send_and_wait', () => session.on('session.error', (event) => {
            if (event?.agentId) return; // not the root planning turn
            captured = safeSdkErrorData(event?.data);
          }));
        }
        response = await atPhase('send_and_wait', () =>
          session.sendAndWait({ prompt, responseSchema: PLAN_SCHEMA }, timeoutMs));
      } catch (error) {
        sendFailure = error instanceof CopilotPhaseError ? error :
          new CopilotPhaseError('send_and_wait', error);
        sendFailure.attachSdkError(captured);
        throw sendFailure;
      } finally {
        try { unsubscribe?.(); } catch (error) {
          if (!sendFailure) throw new CopilotPhaseError('cleanup', error);
        }
      }
      const candidate = atPhaseSync('parse_json', () => {
        const raw = response?.data?.content;
        if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192)
          throw new Error('Missing or oversized Copilot response');
        return JSON.parse(raw);
      });
      atPhaseSync('validate_plan', () => validatePlan(candidate, { snapshot, previousVersion, maxPlanTicks }));
      atPhaseSync('postflight_freshness', () => {
        const fresh = getCurrentState();
        if (!keysAre(fresh, ['game_id', 'tick', 'plan_version']) || fresh.game_id !== snapshot.game_id ||
            !integer(fresh.tick) || fresh.tick < snapshot.tick || fresh.tick > snapshot.tick + maxTickLag ||
            fresh.tick >= candidate.expires_tick || fresh.plan_version !== previousVersion ||
            now() < snapshot.observed_at_ms || now() - snapshot.observed_at_ms > maxSnapshotAgeMs)
          throw new Error('Copilot plan superseded during inference');
      });
      result = candidate;
    } catch (error) {
      failure = error instanceof CopilotPhaseError ? error : new CopilotPhaseError('unexpected', error);
    } finally {
      // Cleanup failures never mask the first failed phase; both resources are
      // still given a chance to close, and raw cleanup errors are discarded.
      try {
        if (session) await session.disconnect();
      } catch (error) {
        failure ??= new CopilotPhaseError('cleanup', error);
      }
      try {
        if (client) {
          const errors = await client.stop();
          if (Array.isArray(errors) && errors.length) throw new Error('SDK stop reported errors');
        }
      } catch (error) {
        failure ??= new CopilotPhaseError('cleanup', error);
      }
    }
    if (failure) throw failure;
    return result; // Caller must revalidate applicability again before any use.
  };
}
