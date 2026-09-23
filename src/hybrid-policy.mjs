// Proposed hybrid Jev decision: three narrow, independent Choice questions in
// ONE TypeSafe request. Answers are composed only after parsing all questions.
// No game controller imports this yet; the current land route remains unchanged.
import { actionCriteria } from "../web/observation.js";
import { navalCriteria } from "../web/naval-observation.js";
import {
  hybridChoices,
  hybridModelState,
  validateHybridInput,
} from "../web/hybrid-observation.js";
import { buildRequest as buildLandRequest, parseDecision } from "./policy.mjs";

export const HYBRID_POLICY_VERSION = "hybrid-branch-v2.1-nav-clarity";

export function buildHybridRequest(input, model = "jev-latest") {
  const clean = validateHybridInput(input);
  const actions = hybridChoices(clean);
  const land = buildLandRequest(clean.land, model);
  const questions = {
    branch: {
      type: "choice",
      instructions: [
        "Choose our immediate action family in OpenFront. Decide among waiting, a normal land attack, a geometric coastal transport-boat candidate with a worker-confirmed launch source, and building one City only when offered. Preserve survival and growth while gaining territory and developing our economy; a branch being feasible is not a command to take it.",
        "The optional objective is a strategic suggestion, not a game rule or legal permission. Use current reserve, existing attacks, pressure, available gold, City costs/capacity benefit and naval fleet/coast facts. An island with no land target cannot expand further without a boat. Worker-confirmed spawn is not guaranteed travel, landing or conquest. Other future moves and unprovided site effects are unknown; candidate omissions are disclosed.",
        "If choosing a branch, the independently answered land_action, city_site or boat_action Choice names the actual candidate; each can still choose wait/save gold. Never infer that an option was silently filtered because of strategic priority.",
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
        "Gold is available now, not additional capacity. A completed level-1 City increases troop capacity by city_mechanics.troop_capacity_gain_display (display units) after city_mechanics.construction_ticks simulation ticks; it does not directly increase the baseline gold-addition rate. Each option shows its cost, gold left and estimated capacity after construction. Site distances and marginal coverage are geometry, NOT verified City income, rail connectivity, combat protection or safety guarantees. Compare offered sites and exposure; save gold if building is not worth its cost now.",
        "Site candidates are bounded and may omit good locations; economy.city_sites_omitted counts unoffered sites. City construction remains subject to a fresh worker check and normal game rules.",
      ],
      criteria: actions.city,
    };
  if (actions.branch.boat_attack)
    questions.boat_action = {
      type: "choice",
      instructions: [
        "Premise: IF we choose boat_attack, select ONE offered geometric coastal target/size with a worker-confirmed source, or wait. This answer is independent of the branch; ignore it if another branch wins.",
        "A boat needs no Port in this engine. It commits the chosen percentage of CURRENT available troops to a normal naval transport intent; the engine rechecks legality, path, boat cap and route. Target-region size and shore separation are geometric facts, not combat or route guarantees. A successful landing starts a land attack. Existing boats still travel when we wait; do not blindly stack boats or empty the reserve. Tribes offer only 10%/20%; other targets offer up to 50%.",
        "When land expansion is exhausted on an island, consider a modest boat toward offered wilderness coast or a weak player coast if a usable home army remains; otherwise wait. An optional strategic objective is advice, not a legal override.",
      ],
      criteria: navalCriteria(actions.boat),
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
        : branch === "boat_attack"
          ? decisions.boat_action.action
          : "wait";
  const kind =
    selected === "wait" || selected === "save_gold"
      ? "wait"
      : branch === "city_build"
        ? "city"
        : branch === "boat_attack"
          ? "boat"
          : "land";
  const site =
    kind === "city"
      ? request.questions.city_site.criteria[selected]
      : kind === "boat"
        ? request.questions.boat_action.criteria[selected]
        : null;
  if (
    (kind === "city" || kind === "boat") &&
    typeof site?.candidate_id !== "string"
  )
    throw new Error(
      "Hybrid spatial choice lost its offered candidate identity",
    );
  // These refer to the SAME offered request, never a regenerated shortlist.
  // The controller must still compare them to the live game/plan and recheck
  // the opaque candidate through the building adapter before emitting an intent.
  return {
    branch,
    selected,
    kind,
    candidate_id: site?.candidate_id ?? null,
    fraction: kind === "boat" ? site?.percent_of_available_troops / 100 : null,
    context: {
      game_id: request.state.game_id,
      snapshot_tick: request.state.snapshot_tick,
      building_snapshot_id: request.state.economy.building_snapshot_id,
      naval_snapshot_id: request.state.naval.snapshot_id ?? null,
      plan_version: request.state.objective?.version ?? null,
    },
    decisions,
    model: response.model,
    usage: response.usage,
  };
}
