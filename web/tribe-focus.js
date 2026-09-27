// Persistent, Moritz-authored tribe-conquest focus. Code remembers Jev's
// OWN emitted tribe attack; it neither selects a target nor replaces a choice.
// The GameView adapter resolves life/identity even if the tribe leaves our
// neighbor list. An absent border or exhausted stack is not proof of conquest.
import { validateObservation } from "./observation.js";

export function recoverSingleActiveTribe(observation) {
  const o = validateObservation(observation);
  const tribes = new Set(
    o.neighbors
      .filter(
        (n) =>
          n.type === "tribe" &&
          n.relationship === "unallied" &&
          n.territory_tiles > 0,
      )
      .map((n) => n.id),
  );
  const active = new Set(
    o.outgoing_attacks
      .filter((a) => !a.retreating && a.troops > 0 && tribes.has(a.target_id))
      .map((a) => a.target_id),
  );
  // If a previous session left several ongoing fronts, do not choose among
  // them covertly. Jev can select one of the existing attacks in its menu.
  return active.size === 1 ? [...active][0] : null;
}

export function projectTribeFocus(snapshot, focusId) {
  if (!snapshot || !Number.isInteger(snapshot.tick))
    throw new Error("Missing GameView observation tick");
  if (focusId === null)
    return { kind: "none", observation: snapshot.observation, focusedId: null };
  const status = snapshot.focus_status;
  if (
    status?.tick !== snapshot.tick ||
    status.id !== focusId ||
    status.status === "unavailable" ||
    !status
  )
    return {
      kind: "unavailable",
      reason: status?.reason ?? "missing_focus_status",
      observation: null,
      focusedId: focusId,
    };
  if (status.status === "dead") {
    if (status.alive !== false || status.type !== "tribe")
      return {
        kind: "unavailable",
        reason: "focus_identity_changed",
        observation: null,
        focusedId: focusId,
      };
    return {
      kind: "conquered",
      observation: snapshot.observation,
      focusedId: null,
    };
  }
  if (
    status.status !== "available" ||
    status.alive !== true ||
    status.type !== "tribe" ||
    !status.game_id ||
    !status.player_id ||
    !Number.isInteger(status.target_reserve_troops) ||
    status.target_reserve_troops < 0 ||
    !Number.isInteger(status.territory_tiles) ||
    status.territory_tiles < 0 ||
    typeof status.adjacent !== "boolean" ||
    typeof status.can_attack !== "boolean" ||
    (status.adjacent && status.worker_checked !== true) ||
    (status.can_attack && !status.adjacent)
  ) {
    return {
      kind: "unavailable",
      reason: "focus_metadata_invalid",
      observation: null,
      focusedId: focusId,
    };
  }
  const projected = {
    ...snapshot.observation,
    tribe_focus: {
      id: focusId,
      alive: true,
      type: "tribe",
      troops: status.target_reserve_troops,
      territory_tiles: status.territory_tiles,
      adjacent: status.adjacent,
      can_attack: status.can_attack,
    },
  };
  try {
    validateObservation(projected);
  } catch {
    return {
      kind: "unavailable",
      reason: "focus_did_not_match_observation",
      observation: null,
      focusedId: focusId,
    };
  }
  return { kind: "active", observation: projected, focusedId: focusId };
}

export function selectedTribeForFocus(action, observation) {
  if (
    action?.kind !== "attack" ||
    !Number.isInteger(action.target_id) ||
    action.target_id < 1
  )
    return null;
  const o = validateObservation(observation);
  return o.neighbors.some(
    (n) =>
      n.id === action.target_id &&
      n.type === "tribe" &&
      n.relationship === "unallied" &&
      n.can_attack,
  )
    ? action.target_id
    : null;
}
