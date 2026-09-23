import {
  actionCriteria,
  buildActions,
  modelState,
  validateObservation,
  OBSERVATION_ERROR,
  MAX_ACTIONS,
} from "../web/observation.js";
export { validateObservation, OBSERVATION_ERROR };
export const POLICY_VERSION = "land-strategy-v4.2";

export function buildRequest(observation, model = "jev-latest") {
  const clean = validateObservation(observation);
  return {
    model,
    state: modelState(clean),
    questions: {
      action: {
        type: "choice",
        instructions: [
          "Choose one action in OpenFront. Gain territory and conquest gold while preserving a growing army. Do not exhaust the available reserve just to keep expanding.",
          "Wilderness normally comes before untouched tribes, but available wilderness is NOT an instruction to attack every decision. If reserves are depleted, wait to regrow. An active wilderness push is NOT an automatic reason to wait: compare its remaining troops against our available reserve using self.active_wilderness_attack_to_available_reserve_ratio. If that push is only a tiny tail and reserves have recovered, consider another modest wilderness send to keep gaining land. If it is already strong relative to reserves, or a new send would drain home defense, wait rather than repeatedly topping it up. Compare the actual post-send reserve in each option; an attack percentage is a commitment, not a reserve target.",
          "The main exception is a tribe already being attacked by OTHER humans or nations: almost always try to take its conquest gold when this does not endanger us. Use neighbors[].attacked_by_other_humans_or_nations. Our own attack, retreating forces, and attacks by other tribes do not qualify.",
          "Once wilderness is unavailable, farm weak tribes when we can afford a useful attack. Do not wait forever with a healthy army and an easy tribe available. Against tribes use only a small commitment, at most twenty percent; otherwise wait and regrow. Do not blindly reinforce an already-funded attack on that tribe.",
          "Under attack, usually absorb until our available reserve is stronger than the attacker's reserve PLUS its active incoming force. Use attackers[].our_reserve_is_stronger, which includes that incoming force. Preserve home defense; do not full-send or chain large sends. Consider all incoming pressure, not just one favorable comparison. Do not assume that another player will rescue us.",
          "Top-level attackers threaten US. A neighbor's attackers target that NEIGHBOR. Outgoing troops are already committed and do not count as available home defense. Waiting leaves current attacks running. Counts use display units; shares/ratios and per-option remaining reserves are already calculated. No city-defense or encirclement strategy is assumed.",
        ],
        criteria: actionCriteria(buildActions(clean)),
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
