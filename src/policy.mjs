import {
  actionCriteria,
  buildActions,
  modelState,
  validateObservation,
  OBSERVATION_ERROR,
} from "../web/observation.js";
export { validateObservation, OBSERVATION_ERROR };
export const POLICY_VERSION = "land-observation-v3";

export function buildRequest(observation, model = "jev-latest") {
  const clean = validateObservation(observation);
  return {
    model,
    state: modelState(clean),
    questions: {
      action: {
        type: "choice",
        instructions: [
          "Choose our next available action in OpenFront, a territorial strategy game. The goal is to survive and gain territory.",
          "The state describes us, our borders, directly bordering players, and land attacks incoming to us. All troop counts use display units. Troops are currently available reserves; capacity is the maximum reserve, not additional troops.",
          "Border shares count cardinal tile edges, not distinct tiles. Player IDs link neighbors and incoming attacks. Retreating incoming attacks are listed separately from the active-incoming total.",
          "The options describe the available land attacks and their estimated commitments at this snapshot. Strength ratios compare the proposed attacking force with the target's available troops, not our whole army. A null ratio means wilderness has no defending player or the denominator is zero.",
          "Waiting sends no new order; existing attacks and the game continue. No history or other game state is provided.",
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
    keys.length > 255 ||
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
