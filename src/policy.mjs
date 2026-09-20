export const ACTIONS = Object.freeze({
  wait: 0,
  attack_0: 0,
  attack_10: 0.1,
  attack_20: 0.2,
});
export const POLICY_VERSION = "wilderness-v1";

export function validateObservation(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "troops") ||
    !Number.isFinite(value.troops) ||
    value.troops < 0 ||
    value.troops > 1e9
  ) {
    throw new Error(
      "Expected exactly {troops: a finite number between 0 and 1e9}",
    );
  }
  return { troops: value.troops };
}

export function buildRequest(observation, model = "jev-latest") {
  return {
    model,
    state: validateObservation(observation),
    questions: {
      action: {
        type: "choice",
        instructions: [
          "Choose the next action in the opening wilderness-expansion stage of OpenFront.",
          "The goal is to acquire unclaimed land quickly while retaining troops for continued expansion.",
          "`troops` is our currently available troop count in the units displayed by the game (not committed attacking troops).",
          "Troops regenerate over time. An attack commits a percentage of the available pool; the game automatically conquers adjacent wilderness with those troops.",
          "Choose only from the supplied actions using this troop count. No capacity, history, enemy state, or ongoing-attack information is provided; do not assume their values.",
          "Waiting and attacking with 0% both leave the game running without sending a new attack.",
        ],
        criteria: {
          wait: "Do nothing this decision; let the existing simulation continue and troops regenerate.",
          attack_0:
            "Commit 0% to wilderness. This has the same effect as waiting.",
          attack_10:
            "Launch a wilderness attack with 10% of currently available troops, retaining 90%.",
          attack_20:
            "Launch a wilderness attack with 20% of currently available troops, retaining 80%.",
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
