// Proposed hybrid Jev decision: three narrow, independent Choice questions in
// ONE TypeSafe request. Answers are composed only after parsing all questions.
// No game controller imports this yet; the current land route remains unchanged.
import { actionCriteria } from "../web/observation.js";
import {
  hybridChoices,
  hybridModelState,
  validateHybridInput,
} from "../web/hybrid-observation.js";
import { buildRequest as buildLandRequest, parseDecision } from "./policy.mjs";

export const HYBRID_POLICY_VERSION = "hybrid-branch-v1-proposed";

export function buildHybridRequest(input, model = "jev-latest") {
  const clean = validateHybridInput(input);
  const actions = hybridChoices(clean);
  const land = buildLandRequest(clean.land, model);
  const questions = {
    branch: {
      type: "choice",
      instructions: [
        "Choose our immediate action family in OpenFront. Decide among waiting, a normal land attack, and building one City only when offered. Preserve survival and growth while gaining territory and developing our economy; a branch being feasible is not a command to take it.",
        "The optional objective is a strategic suggestion, not a game rule or legal permission. Use the current reserve, existing attacks, pressure, available gold, offered build sites, and their omitted count. No opponent future moves or unprovided building effects are known.",
        "If choosing a branch, the independently answered land_action or city_site Choice names the actual candidate; either can still choose wait/save gold. Never infer that an option was silently filtered because of strategic priority.",
      ],
      criteria: actions.branch,
    },
  };
  if (actions.branch.land_attack)
    questions.land_action = {
      type: "choice",
      instructions: [
        "Premise: IF we choose the land_attack branch, select one of these legal land target/size options or wait. This question is independent of branch; ignore its answer if another branch wins.",
        ...land.questions.action.instructions,
      ],
      criteria: actionCriteria(actions.land),
    };
  if (actions.branch.city_build)
    questions.city_site = {
      type: "choice",
      instructions: [
        "Premise: IF we choose city_build, select ONE offered, currently worker-checked City site or save_gold. This question is independent of branch; ignore its answer otherwise.",
        "Gold is available now, not additional capacity. Each option shows exact cost and estimated gold left. Distances and marginal coverage are geometry, NOT verified City income, trade connectivity, combat coverage, or safety guarantees. Compare offered sites against the optional objective and exposure; if their effects are too uncertain, save gold.",
        "Site candidates are bounded and may omit good locations; economy.city_sites_omitted counts unoffered sites. City construction remains subject to a fresh worker check and normal game rules.",
      ],
      criteria: actions.city,
    };
  return { model, state: hybridModelState(clean), questions };
}

export function parseHybridDecision(response, request) {
  const names = Object.keys(request?.questions ?? {});
  if (
    !names.includes("branch") ||
    !response?.answers ||
    typeof response.answers !== "object" ||
    Object.keys(response.answers).length !== names.length ||
    !names.every((name) => Object.hasOwn(response.answers, name))
  ) {
    throw new Error("Invalid TypeSafe hybrid response questions");
  }
  const decisions = Object.fromEntries(
    names.map((name) => [
      name,
      parseDecision(
        { ...response, answers: { action: response.answers[name] } },
        request.questions[name].criteria,
      ),
    ]),
  );
  const branch = decisions.branch.action;
  const selected =
    branch === "land_attack"
      ? decisions.land_action.action
      : branch === "city_build"
        ? decisions.city_site.action
        : "wait";
  const kind =
    selected === "wait" || selected === "save_gold"
      ? "wait"
      : branch === "city_build"
        ? "city"
        : "land";
  const site =
    kind === "city" ? request.questions.city_site.criteria[selected] : null;
  if (kind === "city" && typeof site?.candidate_id !== "string")
    throw new Error("Hybrid City choice lost its offered candidate identity");
  // These refer to the SAME offered request, never a regenerated shortlist.
  // The controller must still compare them to the live game/plan and recheck
  // the opaque candidate through the building adapter before emitting an intent.
  return {
    branch,
    selected,
    kind,
    candidate_id: site?.candidate_id ?? null,
    context: {
      game_id: request.state.game_id,
      snapshot_tick: request.state.snapshot_tick,
      building_snapshot_id: request.state.economy.building_snapshot_id,
      plan_version: request.state.objective?.version ?? null,
    },
    decisions,
    model: response.model,
    usage: response.usage,
  };
}
