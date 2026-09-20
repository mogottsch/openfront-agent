export const ACTIONS = Object.freeze({
  wait: 0,
  attack_0: 0,
  attack_10: 0.1,
  attack_20: 0.2,
});
export const POLICY_VERSION = "wilderness-reserve-v2";
export const OBSERVATION_ERROR =
  "Expected exactly {troops, troop_capacity}: finite display-unit counts, troops >= 0, capacity > 0, both <= 1e9";

export function validateObservation(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "troops") ||
    !Object.hasOwn(value, "troop_capacity") ||
    !Number.isFinite(value.troops) ||
    value.troops < 0 ||
    value.troops > 1e9 ||
    !Number.isFinite(value.troop_capacity) ||
    value.troop_capacity <= 0 ||
    value.troop_capacity > 1e9
  ) {
    throw new Error(OBSERVATION_ERROR);
  }
  // Troops may temporarily exceed capacity after territory loss or a return.
  return { troops: value.troops, troop_capacity: value.troop_capacity };
}

export function buildRequest(observation, model = "jev-latest") {
  return {
    model,
    state: validateObservation(observation),
    questions: {
      action: {
        type: "choice",
        instructions: [
          "You are choosing an action during OpenFront's early wilderness-expansion phase. Expand while preserving a troop reserve that can keep growing.",
          "`troops` is our currently available troop count, excluding committed attacking troops. `troop_capacity` is our current maximum troop capacity. Both are in the same display units.",
          "Aim to leave approximately 30% of current troop capacity available after your action. Reserve percentage = 100 * troops / troop_capacity.",
          "Choose wait when the reserve is at or below 31.6% of capacity. Choose attack_10 when it is above 31.6% and at or below 35.3%. Choose attack_20 when it is above 35.3%.",
          "An attack commits the chosen percentage of available troops to wilderness, not that percentage of capacity. Waiting leaves existing attacks running; it only avoids committing additional troops. The attack_0 option has the same effect as waiting.",
          "No history, enemy state, or ongoing-attack information is provided; do not assume their values.",
        ],
        criteria: {
          wait: {
            when: "troops / troop_capacity is at most 0.316 (31.6%). The reserve needs to grow before committing more troops.",
            effect:
              "Do nothing; leave existing attacks running and let troops regenerate.",
          },
          attack_0: {
            when: "Same condition as wait: troops / troop_capacity is at most 0.316 (31.6%).",
            effect:
              "Commit 0% to wilderness. This has the same effect as waiting.",
          },
          attack_10: {
            when: "troops / troop_capacity is above 0.316 and at most 0.353 (more than 31.6%, up to 35.3%).",
            effect:
              "Launch a wilderness attack with 10% of currently available troops, retaining 90% of those troops.",
          },
          attack_20: {
            when: "troops / troop_capacity is above 0.353 (more than 35.3%). There is excess reserve to commit toward the 30% target.",
            effect:
              "Launch a wilderness attack with 20% of currently available troops, retaining 80% of those troops.",
          },
        },
      },
    },
  };
}

export function parseDecision(response) {
  const answer = response?.answers?.action;
  const isProbability = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
  if (
    answer?.type !== "choice" ||
    !Object.hasOwn(ACTIONS, answer.choice) ||
    !isProbability(answer.confidence) ||
    !answer.probabilities ||
    Object.keys(answer.probabilities).length !== Object.keys(ACTIONS).length ||
    !Object.keys(ACTIONS).every((key) =>
      isProbability(answer.probabilities[key]),
    ) ||
    Math.abs(
      Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1,
    ) > 0.02
  ) {
    throw new Error("Invalid TypeSafe Choice response");
  }
  return {
    action: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model: response.model,
    usage: response.usage,
  };
}
