import {
  actionCriteria,
  buildActions,
  modelState,
  validateObservation,
  OBSERVATION_ERROR,
  MAX_ACTIONS,
} from "../web/observation.js";
export { validateObservation, OBSERVATION_ERROR };
export const POLICY_VERSION = "land-strategy-v4.3-tribe-focus";

// Only describe facts already in the approved land observation. These notes
// never filter, rerank, resize or replace a model-selected legal action.
function focusedCriteria(clean, state) {
  const criteria = actionCriteria(buildActions(clean));
  const tribes = state.neighbors.filter((n) =>
    n.type === "tribe" && n.can_attack && n.relationship === "unallied");
  const engaged = tribes.filter((n) => n.our_active_attack_troops > 0);
  const engagedIds = engaged.map((n) => n.id).join(", ");
  const neighbors = new Map(state.neighbors.map((n) => [n.id, n]));
  for (const [key, criterion] of Object.entries(criteria)) {
    if (key === "wait") {
      if (engaged.length) criterion.tribe_focus_context =
        `Active non-retreating attacks are already underway against bordering tribe IDs ${engagedIds}. Waiting lets them continue and troops regrow; do not open a different front just because wait looks passive.`;
      continue;
    }
    if (!key.startsWith("attack_")) continue;
    if (key.startsWith("attack_wilderness_")) {
      if (engaged.length) criterion.tribe_focus_context =
        `We are already attacking bordering tribe IDs ${engagedIds}. Finish that tribe before starting another wilderness push.`;
      continue;
    }
    const targetId = Number(key.match(/^attack_player_(\d+)_(?:10|20|30|40|50)$/)?.[1]);
    const neighbor = neighbors.get(targetId);
    if (!neighbor) continue;
    criterion.target_territory_tiles = neighbor.territory_tiles;
    criterion.target_available_troops = neighbor.troops;
    criterion.our_active_attack_troops_against_target =
      neighbor.our_active_attack_troops;
    if (neighbor.type === "tribe") {
      criterion.tribe_focus_context = engaged.length
        ? neighbor.our_active_attack_troops > 0
          ? "Already attacking this tribe. Finish its conquest before opening another target. If its committed attack can finish, wait for it; otherwise consider a modest legal reinforcement without exhausting home defense."
          : `Our attacks on bordering tribe IDs ${engagedIds} are unfinished. Do not open a new tribe front; wait or reinforce an existing target if necessary.`
        : "No currently observed active attack on a bordering tribe. This could be a new tribe target, after resolving any prior focus that is no longer observable here.";
    } else if (neighbor.type === "nation") {
      criterion.nation_conquest_context = tribes.length
        ? `There are ${tribes.length} attackable bordering tribes left. Do not start a nation attack until all those tribes are conquered. Its current reserve is not its entire territory, defenses or future reinforcements; a small send is not proof of a finish.`
        : "Nation attack only when a complete conquest is credibly achievable, ideally in one send; consider the whole target territory and strength, unknown defenses and lasting hostility. A favorable current-reserve ratio alone cannot establish that.";
    }
  }
  return criteria;
}

export function buildRequest(observation, model = "jev-latest") {
  const clean = validateObservation(observation);
  const state = modelState(clean);
  return {
    model,
    state,
    questions: {
      action: {
        type: "choice",
        instructions: [
          "Choose one action in OpenFront. Gain territory and conquest gold while preserving a growing army. Do not exhaust the available reserve just to keep expanding.",
          "Wilderness normally comes before untouched tribes, but available wilderness is NOT an instruction to attack every decision. If reserves are depleted, wait to regrow. An active wilderness push is NOT an automatic reason to wait: compare its remaining troops against our available reserve using self.active_wilderness_attack_to_available_reserve_ratio. If that push is only a tiny tail and reserves have recovered, consider another modest wilderness send to keep gaining land. If it is already strong relative to reserves, or a new send would drain home defense, wait rather than repeatedly topping it up. Compare the actual post-send reserve in each option; an attack percentage is a commitment, not a reserve target.",
          "Focus before spreading: if our own non-retreating attack is already underway against a bordering tribe (neighbors[].our_active_attack_troops > 0), finish that tribe before starting another tribe, wilderness or nation attack. Do not open another front while the current tribe is unfinished. A useful commitment may need time to conquer territory; wait and let it run if it can finish, or reinforce that SAME tribe with a legal 10%/20% send if the attack would otherwise fail and home defense permits. If several attacks are already underway, do not add another target; focus on bringing an existing tribe to conquest. Never mistake the existence of an attack for proof that more troops are needed, or a dwindling committed force for proof the target has been conquered.",
          "When no unfinished tribe is already our focus and wilderness is unavailable, choose an attackable bordering tribe we can afford to finish, then stay with it through conquest. Take all attackable bordering tribes before attacking any nation, not just the weakest one; wait/regrow or continue the current tribe instead of moving to a nation early. Against tribes use only a small commitment, at most twenty percent. The main exception to starting an otherwise untouched tribe is one already being attacked by OTHER humans or nations: consider taking its conquest gold when this does not endanger us, but do not abandon our own unfinished tribe just for that opportunity. Use neighbors[].attacked_by_other_humans_or_nations; our own attack, retreating forces and attacks by other tribes do not qualify.",
          "Only after all attackable bordering tribes are conquered should a nation attack be considered. Start one only if we are confident we can FINISH conquering the whole nation, ideally with one well-supported send, mindful of Moritz's concern about lasting hostility after war. The target's currently available troops or committed-to-defender ratio do NOT measure total territorial resistance, defensive structures, reinforcements or a full-conquest probability. If the observation cannot justify a credible finish, wait and preserve the army rather than launch a token 10% nation raid. Do not invent unobserved defense-post coverage or garrisons, and do not treat this as a numeric reserve threshold.",
          "Under attack, usually absorb until our available reserve is stronger than the attacker's reserve PLUS its active incoming force. Use attackers[].our_reserve_is_stronger, which includes that incoming force. Preserve home defense; do not full-send or chain large sends. Consider all incoming pressure, not just one favorable comparison. Do not assume that another player will rescue us.",
          "Top-level attackers threaten US. A neighbor's attackers target that NEIGHBOR. Outgoing troops are already committed and do not count as available home defense. Waiting leaves current attacks running. Counts use display units; shares/ratios and per-option remaining reserves are already calculated. No city-defense or encirclement strategy is assumed.",
        ],
        criteria: focusedCriteria(clean, state),
      },
    },
  };
}

export function parseDecision(response, criteria) {
  const answer = response?.answers?.action;
  const keys = Object.keys(criteria ?? {});
  const probability = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
  if (
    keys.length === 0 ||
    keys.length > MAX_ACTIONS ||
    answer?.type !== "choice" ||
    !Object.hasOwn(criteria, answer.choice) ||
    !probability(answer.confidence) ||
    !answer.probabilities ||
    Object.keys(answer.probabilities).length !== keys.length ||
    !keys.every((key) => probability(answer.probabilities[key])) ||
    Math.abs(
      Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1,
    ) > 0.02
  ) {
    throw new Error("Invalid TypeSafe Choice response for the offered actions");
  }
  return {
    action: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model: response.model,
    usage: response.usage,
  };
}
