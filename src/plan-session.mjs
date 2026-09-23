// Server-owned, opt-in plan lifecycle. Importing/starting/heartbeating never
// calls a model. Only explicit plan(snapshot) invokes the injected planner.
// The controller must separately approve which game facts enter this projection.
import { validatePlan } from './copilot-planner.mjs';

const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const number = (value, max = 1_000_000_000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const id = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 200 &&
  /^[A-Za-z0-9:@#._/\-]+$/.test(value);
const gold = (value) => typeof value === 'string' && /^(0|[1-9]\d{0,39})$/.test(value);
const equalIds = (left, right) => left.length === right.length &&
  left.every((value) => right.includes(value));
const clone = (value) => JSON.parse(JSON.stringify(value));
const heartbeatKeys = ['session_id', 'game_id', 'tick', 'observed_at_ms', 'region_ids'];
const summaryKeys = ['troops', 'troop_capacity', 'territory_tiles', 'available_gold',
  'incoming_attack_troops', 'wilderness_border_edges', 'player_border_edges', 'regions'];
const regionKeys = ['id', 'territory_tiles', 'hostile_border_edges', 'city_count'];

function validateHeartbeat(heartbeat) {
  if (!exact(heartbeat, heartbeatKeys) || !id(heartbeat.session_id) || !id(heartbeat.game_id) ||
      !number(heartbeat.tick) || !Number.isSafeInteger(heartbeat.observed_at_ms) ||
      heartbeat.observed_at_ms < 0 || !Array.isArray(heartbeat.region_ids) ||
      heartbeat.region_ids.length > 16 || heartbeat.region_ids.some((region) => !id(region)) ||
      new Set(heartbeat.region_ids).size !== heartbeat.region_ids.length) {
    throw new Error('Invalid plan heartbeat');
  }
  return clone(heartbeat);
}

function validateSnapshot(input) {
  if (!exact(input, [...heartbeatKeys, 'summary'])) throw new Error('Invalid plan snapshot');
  const heartbeat = validateHeartbeat(Object.fromEntries(heartbeatKeys.map((key) => [key, input[key]])));
  const s = input.summary;
  if (!exact(s, summaryKeys) || !number(s.troops) || !number(s.troop_capacity) ||
      !number(s.territory_tiles) || !gold(s.available_gold) ||
      !number(s.incoming_attack_troops) || !number(s.wilderness_border_edges) ||
      !number(s.player_border_edges) || !Array.isArray(s.regions) ||
      s.regions.length !== heartbeat.region_ids.length || s.regions.some((r) =>
        !exact(r, regionKeys) || !id(r.id) || !number(r.territory_tiles) ||
        !number(r.hostile_border_edges) || !number(r.city_count)) ||
      !equalIds(s.regions.map((r) => r.id), heartbeat.region_ids) ||
      new Set(s.regions.map((r) => r.id)).size !== s.regions.length) {
    throw new Error('Invalid plan snapshot summary');
  }
  const modelSnapshot = {
    game_id: heartbeat.game_id, tick: heartbeat.tick,
    observed_at_ms: heartbeat.observed_at_ms, region_ids: heartbeat.region_ids,
    summary: clone(s),
  };
  if (Buffer.byteLength(JSON.stringify(modelSnapshot), 'utf8') > 16_384) {
    throw new Error('Plan snapshot exceeds 16 KiB');
  }
  return { heartbeat, modelSnapshot };
}

const publicPlan = (plan) => ({
  objective: plan.objective, plan_version: plan.plan_version,
  source_tick: plan.source_tick, expires_tick: plan.expires_tick,
});

/**
 * Contract:
 *   start(snapshot) begins a new session without inference.
 *   heartbeat({session_id,game_id,tick,observed_at_ms,region_ids}) advances
 *     the authoritative game clock; a region-set change invalidates the active
 *     plan and aborts the in-flight request, but retains version history.
 *   plan(snapshot) is the ONLY model-call entrypoint; at most one in flight.
 *   getPlan({session_id,game_id}) returns a minimal copy only while fresh.
 *   stop() invalidates both the plan and in-flight work.
 * maxSnapshotAgeMs bounds the inference snapshot from start through result;
 * maxHeartbeatGapMs separately bounds silence since the last received heartbeat.
 * An AbortSignal is offered to the injected planner. The current Copilot
 * connector does not yet forward it to its SDK transport, so generation and
 * freshness checks independently reject late results; abort is logical here.
 */
export function createPlanSession({
  planner, now = Date.now, maxSnapshotAgeMs = 20_000,
  maxHeartbeatGapMs = 2_000, maxTickLag = 20, maxPlanTicks = 300,
} = {}) {
  if (typeof planner !== 'function' || typeof now !== 'function' ||
      !number(maxSnapshotAgeMs) || maxSnapshotAgeMs === 0 ||
      !number(maxHeartbeatGapMs) || maxHeartbeatGapMs === 0 ||
      !number(maxTickLag) || !number(maxPlanTicks) || maxPlanTicks === 0) {
    throw new Error('Invalid plan-session configuration');
  }
  let active = null;
  let activePlan = null;
  let lastValidatedPlan = null;
  let generation = 0;
  let pending = null;

  function fresh(timestamp, limit = maxSnapshotAgeMs) {
    const time = now();
    return Number.isSafeInteger(time) && time >= timestamp && time - timestamp <= limit;
  }
  function live(heartbeat = active) {
    return heartbeat !== null && fresh(heartbeat.observed_at_ms) &&
      fresh(heartbeat.received_at_ms, maxHeartbeatGapMs);
  }
  function cancel() {
    generation++;
    pending?.abort();
    activePlan = null;
  }
  function advance(heartbeat) {
    if (!active || heartbeat.session_id !== active.session_id || heartbeat.game_id !== active.game_id) {
      throw new Error('Heartbeat belongs to a different plan session');
    }
    if (heartbeat.tick < active.tick || heartbeat.observed_at_ms < active.observed_at_ms ||
        !fresh(heartbeat.observed_at_ms)) throw new Error('Stale plan heartbeat');
    // A plan hidden by a heartbeat outage must not revive merely because the
    // game tick stayed constant while paused or disconnected.
    if (!live() || !equalIds(heartbeat.region_ids, active.region_ids)) cancel();
    active = { ...heartbeat, received_at_ms: now() };
    if (activePlan && active.tick >= activePlan.expires_tick) activePlan = null;
  }
  return {
    start(input) {
      const { heartbeat } = validateSnapshot(input);
      if (!fresh(heartbeat.observed_at_ms)) throw new Error('Stale plan start');
      cancel();
      active = { ...heartbeat, received_at_ms: now() };
      lastValidatedPlan = null;
      return true;
    },
    heartbeat(input) {
      const heartbeat = validateHeartbeat(input);
      advance(heartbeat);
      return true;
    },
    async plan(input) {
      const { heartbeat, modelSnapshot } = validateSnapshot(input);
      if (pending) throw new Error('Plan request already in flight');
      if (!live() || !fresh(heartbeat.observed_at_ms) || !active ||
          heartbeat.session_id !== active.session_id || heartbeat.game_id !== active.game_id ||
          heartbeat.tick !== active.tick || heartbeat.observed_at_ms !== active.observed_at_ms ||
          !equalIds(heartbeat.region_ids, active.region_ids)) {
        throw new Error('Plan snapshot is not the active fresh heartbeat');
      }
      const epoch = generation;
      const previousVersion = lastValidatedPlan?.plan_version ?? 0;
      const controller = new AbortController();
      pending = controller;
      try {
        const result = await planner({
          snapshot: clone(modelSnapshot),
          previousPlan: lastValidatedPlan ? clone(lastValidatedPlan) : null,
          getCurrentState: () => ({
            game_id: active?.game_id ?? '', tick: active?.tick ?? -1,
            plan_version: lastValidatedPlan?.plan_version ?? 0,
          }),
          signal: controller.signal,
        });
        if (controller.signal.aborted || epoch !== generation || !active || !live() ||
            active.session_id !== heartbeat.session_id || active.game_id !== heartbeat.game_id ||
            !equalIds(active.region_ids, heartbeat.region_ids) ||
            active.tick < heartbeat.tick || active.tick - heartbeat.tick > maxTickLag ||
            !fresh(heartbeat.observed_at_ms) || active.tick >= result?.expires_tick ||
            (lastValidatedPlan?.plan_version ?? 0) !== previousVersion) {
          throw new Error('Plan request cancelled or stale');
        }
        validatePlan(result, { snapshot: modelSnapshot, previousVersion, maxPlanTicks });
        lastValidatedPlan = clone(result);
        activePlan = lastValidatedPlan;
        return publicPlan(activePlan);
      } finally {
        if (pending === controller) pending = null;
      }
    },
    getPlan({ session_id, game_id } = {}) {
      if (!active || !activePlan || !live() || session_id !== active.session_id ||
          game_id !== active.game_id || active.tick >= activePlan.expires_tick) return null;
      return publicPlan(activePlan);
    },
    stop() {
      cancel();
      active = null;
      lastValidatedPlan = null;
    },
  };
}
