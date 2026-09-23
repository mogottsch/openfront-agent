// OFFLINE/PROBE-ONLY alternative to the flat boat action menu. One TypeSafe
// request asks an independent boat target Choice plus one speculative size
// Choice PER target. Code composes only the selected branch/site/size; every
// wait is honored. Nothing imports this from the live game controller yet.
import { buildHybridRequest } from "./hybrid-policy.mjs";
import { parseDecision } from "./policy.mjs";
import { validateHybridInput } from "../web/hybrid-observation.js";

export const NAVAL_DECOMPOSED_POLICY_VERSION =
  "hybrid-boat-target-size-probe-v1";

export function buildNavalDecomposedRequest(input, model = "jev-latest") {
  const clean = validateHybridInput(input);
  const base = buildHybridRequest(clean, model);
  if (!base.questions.boat_action || !clean.naval?.candidates.length)
    throw new Error(
      "Decomposed probe requires fresh worker-checked boat choices",
    );
  const original = base.questions.boat_action.criteria;
  const questions = { ...base.questions };
  delete questions.boat_action;
  const targets = { wait: { action: "Do not start a new transport boat." } };
  for (const [index, c] of clean.naval.candidates.entries()) {
    const targetKey = `boat_target_${index + 1}`;
    const offered = Object.entries(original).filter(([key]) =>
      key.startsWith(`boat_${index + 1}_`),
    );
    if (!offered.length) continue; // not executable with current reserve
    targets[targetKey] = {
      action:
        "Propose this worker-confirmed launch to a geometric target coast; not a route guarantee.",
      candidate_id: c.id,
      target_type: c.target_type,
      target_region_tiles: c.target_region_tiles,
      water_ocean_status: c.water_ocean_status,
      water_span_estimate_tiles: c.water_span_estimate_tiles,
      water_span_method: c.water_span_method,
    };
    const sizes = {
      wait: { action: "Do not commit troops to this particular target." },
    };
    for (const [key, criterion] of offered) {
      const percent = Number(key.split("_").at(-1));
      sizes[`send_${percent}`] = {
        action: `Commit ${percent}% of current available troops if this coastal target is selected.`,
        candidate_id: c.id,
        percent_of_available_troops: percent,
        troops_committed_estimate: criterion.troops_committed_estimate,
        troops_remaining_estimate: criterion.troops_remaining_estimate,
      };
    }
    questions[`boat_size_${index + 1}`] = {
      type: "choice",
      instructions: [
        `Premise: IF boat_attack is selected AND the chosen boat target is ${c.id}, decide how much available reserve to commit to that specific target, or wait. This is independent of the target Choice; ignore it for every other target.`,
        {
          candidate_id: c.id,
          target_type: c.target_type,
          target_region_tiles: c.target_region_tiles,
          geometric_shore_separation: c.water_span_estimate_tiles,
          known_fleet: base.state.naval.fleet,
          question:
            "Is this trip worth a modest or larger commitment now, while preserving survival at home? Route, landing and later combat are not guaranteed.",
        },
        "Sizes are percentages of current available troops, not a capacity target. Tribes cannot receive more than 20%; do not blindly reinforce an existing transport. A wait means send nothing.",
      ],
      criteria: sizes,
    };
  }
  if (Object.keys(targets).length === 1)
    throw new Error("No executable naval targets");
  questions.boat_target = {
    type: "choice",
    instructions: [
      "Premise: IF boat_attack is chosen, select ONE of these worker-confirmed launch destinations or wait. A geometry candidate is not a guarantee of sea route, landfall, conquest or safety.",
      "Compare offered target region size and geometric shore separation; the latter is Manhattan distance, NOT computed water-path length. Existing boats and home reserves matter. No target has been silently chosen by code.",
      "Troop percentage will be a separate, independent Choice specifically for the selected target. Returning wait at either stage means no boat intent.",
    ],
    criteria: targets,
  };
  return { ...base, questions };
}

export function parseNavalDecomposedDecision(response, request) {
  const names = Object.keys(request?.questions ?? {});
  if (
    !names.includes("branch") ||
    !names.includes("boat_target") ||
    !response?.answers ||
    typeof response.answers !== "object" ||
    Object.keys(response.answers).length !== names.length ||
    !names.every((name) => Object.hasOwn(response.answers, name))
  )
    throw new Error("Invalid decomposed Jev response questions");
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
  let selected = "wait",
    kind = "wait",
    candidate_id = null,
    fraction = null;
  if (branch === "land_attack") {
    selected = decisions.land_action.action;
    if (selected !== "wait") kind = "land";
  } else if (branch === "city_build") {
    selected = decisions.city_site.action;
    if (selected !== "save_gold") {
      kind = "city";
      candidate_id =
        request.questions.city_site.criteria[selected]?.candidate_id;
      if (typeof candidate_id !== "string")
        throw new Error("City candidate lost its registry ID");
    }
  } else if (branch === "boat_attack") {
    const targetKey = decisions.boat_target.action;
    if (targetKey !== "wait") {
      const target = request.questions.boat_target.criteria[targetKey];
      const index = Number(targetKey.split("_").at(-1));
      const sizeKey = `boat_size_${index}`;
      const size = decisions[sizeKey]?.action;
      if (!target || typeof target.candidate_id !== "string" || !size)
        throw new Error("Boat target and size were not jointly offered");
      if (size !== "wait") {
        const sized = request.questions[sizeKey].criteria[size];
        if (
          !sized ||
          sized.candidate_id !== target.candidate_id ||
          !Number.isInteger(sized.percent_of_available_troops)
        )
          throw new Error("Boat size was not offered for the selected target");
        selected = `boat_${index}_${sized.percent_of_available_troops}`;
        kind = "boat";
        candidate_id = target.candidate_id;
        fraction = sized.percent_of_available_troops / 100;
      }
    }
  }
  return {
    branch,
    selected,
    kind,
    candidate_id,
    fraction,
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
