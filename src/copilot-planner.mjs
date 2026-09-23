// Isolated, opt-in server-side planner prototype. Nothing imports or calls Copilot
// until plan() is explicitly invoked by a future, separately approved controller.
// Official SDK: https://github.com/github/copilot-sdk/tree/main/nodejs
// Backend isolation: https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md

const REPLAN_EVENTS = ['border_change', 'incoming_attack', 'structure_change', 'economy_change'];
const PRIORITIES = ['high', 'medium', 'low'];
const keysAre = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export const PLAN_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'plan_version', 'game_id', 'source_tick', 'expires_tick', 'objective', 'region_priorities', 'replan_on'],
  properties: {
    schema_version: { const: 1 },
    plan_version: { type: 'integer', minimum: 1 },
    game_id: { type: 'string' },
    source_tick: { type: 'integer', minimum: 0 },
    expires_tick: { type: 'integer', minimum: 1 },
    objective: { type: 'string', maxLength: 240 },
    region_priorities: { type: 'array', maxItems: 16, items: {
      type: 'object', additionalProperties: false, required: ['region_id', 'priority', 'reason'],
      properties: { region_id: { type: 'string' }, priority: { type: 'string', enum: PRIORITIES }, reason: { type: 'string', maxLength: 180 } },
    } },
    replan_on: { type: 'array', maxItems: REPLAN_EVENTS.length, uniqueItems: true, items: { type: 'string', enum: REPLAN_EVENTS } },
  },
});

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

async function defaultClientFactory() {
  // The official @github/copilot-sdk is intentionally optional until Moritz
  // approves an integration. Install it on the server before enabling this path.
  const { CopilotClient } = await import('@github/copilot-sdk');
  return new CopilotClient({ mode: 'empty', logLevel: 'none' });
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
    const snapshotJson = validateSnapshot(snapshot);
    if (typeof getCurrentState !== 'function') throw new Error('A fresh-state callback is required');
    const previousVersion = previousPlan === null ? 0 : previousPlan.plan_version;
    if (!integer(previousVersion)) throw new Error('Invalid previous plan version');
    if (previousPlan !== null) {
      if (previousVersion === 0 || !Array.isArray(previousPlan.region_priorities)) throw new Error('Invalid previous plan');
      // Validate before serializing: a caller must not smuggle arbitrary fields
      // (including secrets) into a previous plan forwarded to Copilot.
      try {
        validatePlan(previousPlan, {
          snapshot: {
            game_id: snapshot.game_id, tick: previousPlan.source_tick,
            region_ids: previousPlan.region_priorities.map((entry) => entry?.region_id),
          },
          previousVersion: previousVersion - 1, maxPlanTicks,
        });
      } catch { throw new Error('Invalid previous plan'); }
      if (previousPlan.source_tick > snapshot.tick) throw new Error('Previous plan comes from a future tick');
    }
    if (now() < snapshot.observed_at_ms || now() - snapshot.observed_at_ms > maxSnapshotAgeMs) {
      throw new Error('Stale planner snapshot');
    }
    const current = getCurrentState();
    if (!keysAre(current, ['game_id', 'tick', 'plan_version']) || current.game_id !== snapshot.game_id ||
        current.tick !== snapshot.tick || current.plan_version !== previousVersion) {
      throw new Error('Planner snapshot superseded before request');
    }

    let client;
    let session;
    try {
      client = await createClient();
      await client.start();
      session = await client.createSession({
        model, availableTools: [],
        // Defense in depth even if runtime defaults change; no CLI/shell/files/web tools.
        onPermissionRequest: () => ({ kind: 'reject', feedback: 'Planner has no tool permissions.' }),
        hooks: { onPreToolUse: () => ({ permissionDecision: 'deny' }) },
      });
      const prompt = JSON.stringify({
        task: 'Propose one short-lived strategic objective from only the supplied approved state. Return only JSON conforming to responseSchema. No commands, tools or executable actions.',
        state: JSON.parse(snapshotJson),
        previous_plan: previousPlan?.expires_tick > snapshot.tick ? previousPlan : null,
        expected_plan_version: previousVersion + 1, max_expires_tick: snapshot.tick + maxPlanTicks,
      });
      // responseSchema is the official SDK's structured-output preview; still
      // independently parse and validate because typed JSON is not permission to act.
      const response = await session.sendAndWait({ prompt, responseSchema: PLAN_SCHEMA }, timeoutMs);
      const raw = response?.data?.content;
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('Missing or oversized Copilot response');
      let candidate;
      try { candidate = JSON.parse(raw); } catch { throw new Error('Copilot returned invalid JSON'); }
      validatePlan(candidate, { snapshot, previousVersion, maxPlanTicks });
      const fresh = getCurrentState();
      if (!keysAre(fresh, ['game_id', 'tick', 'plan_version']) || fresh.game_id !== snapshot.game_id ||
          !integer(fresh.tick) || fresh.tick < snapshot.tick || fresh.tick > snapshot.tick + maxTickLag ||
          fresh.tick >= candidate.expires_tick || fresh.plan_version !== previousVersion ||
          now() < snapshot.observed_at_ms || now() - snapshot.observed_at_ms > maxSnapshotAgeMs) {
        throw new Error('Copilot plan superseded during inference');
      }
      return candidate; // Caller must revalidate applicability again before any use.
    } finally {
      try { await session?.disconnect(); } finally { await client?.stop(); }
    }
  };
}
