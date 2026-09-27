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

export function projectTribeFocus(snapshot, focusId, history = null) {
  if (!snapshot || !Number.isInteger(snapshot.tick))
    throw new Error("Missing GameView observation tick");
  if (focusId === null)
    return {
      kind: "none",
      observation: snapshot.observation,
      focusedId: null,
      history: null,
    };
  const status = snapshot.focus_status;
  const unavailable = (reason) => ({
    kind: "unavailable",
    reason,
    observation: null,
    focusedId: focusId,
    history,
  });
  if (
    !status ||
    status.tick !== snapshot.tick ||
    status.id !== focusId ||
    status.status === "unavailable"
  )
    return unavailable(status?.reason ?? "missing_focus_status");
  if (status.status === "dead") {
    if (status.alive !== false || status.type !== "tribe")
      return unavailable("focus_identity_changed");
    return {
      kind: "conquered",
      observation: snapshot.observation,
      focusedId: null,
      history: null,
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
  )
    return unavailable("focus_metadata_invalid");
  // A recovered/boat-triggered focus has unknown prior land send history.
  // Establish its first authoritative visible territory as the reference;
  // once Jev emits a NEW land send, reset to that send's genuine snapshot.
  const reference = history ?? {
    reference_kind: "first_authoritative_focus_observation",
    reference_tick: snapshot.tick,
    reference_tiles: status.territory_tiles,
    land_intents_emitted: null,
    last_land_send_percent: null,
  };
  if (
    !Number.isInteger(reference.reference_tick) ||
    reference.reference_tick > snapshot.tick ||
    !Number.isInteger(reference.reference_tiles) ||
    reference.reference_tiles < 0
  )
    return unavailable("focus_progress_not_current");
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
      progress: {
        ...reference,
        elapsed_ticks: snapshot.tick - reference.reference_tick,
      },
    },
  };
  try {
    validateObservation(projected);
  } catch {
    return unavailable("focus_did_not_match_observation");
  }
  return {
    kind: "active",
    observation: projected,
    focusedId: focusId,
    history: reference,
  };
}

export function recordTribeLandIntent(
  previousHistory,
  observation,
  targetId,
  fraction,
  tick,
) {
  const o = validateObservation(observation);
  const target = o.neighbors.find(
    (n) => n.id === targetId && n.type === "tribe",
  );
  const percent = Math.round(fraction * 100);
  if (
    !target ||
    ![10, 20].includes(percent) ||
    !Number.isInteger(tick) ||
    tick < 0
  )
    throw new Error(
      "Only a real emitted 10%/20% tribe land intent can update focus progress",
    );
  const wasEmitted =
    previousHistory?.reference_kind === "first_emitted_land_intent";
  return {
    reference_kind: "first_emitted_land_intent",
    reference_tick: wasEmitted ? previousHistory.reference_tick : tick,
    reference_tiles: wasEmitted
      ? previousHistory.reference_tiles
      : target.territory_tiles,
    land_intents_emitted: wasEmitted
      ? previousHistory.land_intents_emitted + 1
      : 1,
    last_land_send_percent: percent,
  };
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
