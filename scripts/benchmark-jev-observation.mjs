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

// Local sidecar only: never read a credential or call TypeSafe directly.
// One outstanding request, real monotonic >=1s between *starts*, no queue.
export function createPacedDecisionClient({
  fetchImpl = fetch,
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
      const wait = lastStart + 1000 - now();
      if (wait > 0) await sleep(Math.ceil(wait));
      const startedAtMs = now();
      if (startedAtMs < lastStart + 1000)
        throw new Error("Decision pacing clock did not advance by one second");
      lastStart = startedAtMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl("http://127.0.0.1:8788/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
