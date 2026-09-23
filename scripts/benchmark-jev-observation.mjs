// Read the *core* Game/Player at a turn boundary into the same v4.1 contract
// used by the browser GameView adapter. No new fields or hidden policy.
import { setTimeout as sleepMs } from "node:timers/promises";
import { summarizeBorders } from "../web/game-adapter.js";
import {
  buildActions,
  fractionsForTarget,
  validateObservation,
} from "../web/observation.js";

const typeName = { HUMAN: "human", NATION: "nation", BOT: "tribe" };
const relation = (me, other) =>
  me.isOnSameTeam(other) ? "teammate" :
    me.isAlliedWith(other) ? "ally" : "unallied";
const stats = (game, player) => ({
  id: player.smallID(),
  troops: Math.max(0, Math.floor(player.troops() / 10)),
  troop_capacity: Math.floor(game.config().maxTroops(player) / 10),
  territory_tiles: player.numTilesOwned(),
});
const attacksAgainst = (player) => player.incomingAttacks().map((a) => {
  // The attack's owner is authoritative. Do NOT substitute the target's
  // metadata: v4.1 gold-steal logic depends on *other* attacking players.
  const attacker = a.attacker();
  if (!attacker?.isAlive() || !typeName[attacker.type()])
    throw new Error("Attacker snapshot is unavailable");
  return {
    id: a.id(),
    attacker_id: attacker.smallID(),
    attacker_type: typeName[attacker.type()],
    attacker_reserve_troops: Math.max(0, Math.floor(attacker.troops() / 10)),
    troops: Math.max(0, Math.floor(a.troops() / 10)),
    retreating: a.retreating(),
  };
});

export function observeCore(game, me) {
  if (!me?.hasSpawned() || !me.isAlive() || me.type() !== "HUMAN")
    throw new Error("Human is not active for observation");
  const tick = game.ticks();
  const { border, contacts } = summarizeBorders(game, me.smallID(), me.borderTiles());
  const neighbors = [...contacts].sort((a, b) => a[0] - b[0]).map(([id, contact]) => {
    const other = game.playerBySmallID(id);
    if (!other?.isPlayer() || !typeName[other.type()])
      throw new Error("Neighbor disappeared during observation");
    const friendship = relation(me, other);
    const legal = friendship === "unallied" && other.isAlive() &&
      me.canAttack(contact.tile) && me.canAttackPlayer(other) &&
      game.ownerID(contact.tile) === id;
    return {
      ...stats(game, other),
      type: typeName[other.type()],
      relationship: friendship,
      shared_border_edges: contact.edges,
      can_attack: legal,
      incoming_attacks: attacksAgainst(other),
    };
  });
  const observation = validateObservation({
    self: stats(game, me),
    border,
    neighbors,
    incoming_attacks: attacksAgainst(me),
    outgoing_attacks: me.outgoingAttacks().map((a) => ({
      id: a.id(),
      target_id: a.target().smallID() === 0 ? null : a.target().smallID(),
      troops: Math.max(0, Math.floor(a.troops() / 10)),
      retreating: a.retreating(),
    })),
  });
  if (game.ticks() !== tick) throw new Error("Game advanced during observation");
  return { tick, observation, actions: buildActions(observation) };
}

// Resolve only the model's offered candidate. Recheck current core legality
// at the exact same tick; if invalid, skip rather than substituting a target.
export function recheckCoreAction(game, me, snapshot, choiceId) {
  if (game.ticks() !== snapshot.tick || !Object.hasOwn(snapshot.actions, choiceId))
    throw new Error("Decision is stale or not in the offered candidates");
  const action = snapshot.actions[choiceId];
  if (action.kind === "wait") return action;
  const target = action.target_id === null
    ? game.terraNullius() : game.playerBySmallID(action.target_id);
  if (!target || (target.isPlayer() && (
    !target.isAlive() || relation(me, target) !== "unallied" ||
    !me.canAttackPlayer(target) ||
    !fractionsForTarget(typeName[target.type()]).includes(action.fraction)
  ))) throw new Error("Selected target is no longer legal");
  const { contacts, wildernessTile } = summarizeBorders(game, me.smallID(), me.borderTiles());
  const tile = action.target_id === null ? wildernessTile : contacts.get(action.target_id)?.tile;
  if (tile === null || tile === undefined ||
      game.ownerID(tile) !== (action.target_id ?? 0) || !me.canAttack(tile) ||
      Math.floor(me.troops() * action.fraction) < 1)
    throw new Error("Selected target is no longer attackable");
  return action;
}

// Tick starts never exceed the 10Hz simulation rate. Base each new deadline
// on the *actual* start, not the previous deadline: a slow model cannot cause
// catch-up ticks. Timers may wake slightly early, so loop until the deadline.
export function createTickPacer({
  now = () => performance.now(),
  sleep = (ms) => sleepMs(ms),
} = {}) {
  let nextStart = -Infinity;
  return async () => {
    while (now() < nextStart) {
      await sleep(Math.max(1, Math.ceil(nextStart - now())));
    }
    const startedAtMs = now();
    nextStart = startedAtMs + 100;
    return startedAtMs;
  };
}

// Explicit Start for one benchmark match. The token stays in a closure; never
// return it as data that could be serialized into the benchmark report.
export async function startBenchmarkSession({
  limit,
  fetchImpl = fetch,
  baseUrl = "http://127.0.0.1:8788",
  timeoutMs = 2000,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 300)
    throw new Error("Benchmark Start limit must be 1..300");
  const url = `${baseUrl}/session`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "benchmark", limit }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Local session Start HTTP ${response.status}`);
  const data = await response.json();
  if (data?.mode !== "benchmark" || data.limit !== limit ||
      typeof data.token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(data.token))
    throw new Error("Local session Start returned an invalid contract");
  const token = data.token;
  let closed = false;
  let revoked = false;
  return {
    headers: () => {
      if (closed) throw new Error("Benchmark Start session already stopped");
      return { "X-Agent-Session": token };
    },
    async stop() {
      if (revoked) return;
      // Block further decisions before I/O; a failed DELETE can be retried.
      closed = true;
      const result = await fetchImpl(url, {
        method: "DELETE",
        headers: { "X-Agent-Session": token },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!result.ok) throw new Error(`Local session Stop HTTP ${result.status}`);
      revoked = true;
    },
  };
}

// Local sidecar only: never read a credential or call TypeSafe directly.
// One outstanding request, real monotonic >=1s between *starts*, no queue.
export function createPacedDecisionClient({
  fetchImpl = fetch,
  baseUrl = "http://127.0.0.1:8788",
  sessionHeaders = () => ({}),
  now = () => performance.now(),
  sleep = (ms) => sleepMs(ms),
  timeoutMs = 6500,
} = {}) {
  let busy = false;
  let lastStart = -Infinity;
  return async (observation) => {
    if (busy) throw new Error("A benchmark decision is already pending");
    busy = true;
    try {
      while (now() < lastStart + 1000) {
        await sleep(Math.max(1, Math.ceil(lastStart + 1000 - now())));
      }
      const startedAtMs = now();
      lastStart = startedAtMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...sessionHeaders() },
          body: JSON.stringify(observation),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Local decision HTTP ${response.status}`);
        const decision = await response.json();
        if (typeof decision?.action !== "string")
          throw new Error("Local decision did not return a Choice action");
        return { decision, startedAtMs, latencyMs: now() - startedAtMs };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      busy = false;
    }
  };
}
