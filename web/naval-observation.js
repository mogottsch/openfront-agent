// Strict bridge between worker-checked naval candidates and bounded Jev
// Choices. No clicked tile/source shore is ever sent to the model. The actual
// game worker and current tick remain authoritative at execution time.
import { fractionsForTarget } from "./observation.js";

const only = (v, keys) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const id = (s) =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 220 &&
  /^[A-Za-z0-9:@#._/\-]+$/.test(s);
const count = (v, max = 100_000_000) =>
  Number.isSafeInteger(v) && v >= 0 && v <= max;
const gold = (s) => typeof s === "string" && /^(0|[1-9]\d{0,39})$/.test(s);
const reserve = (n) =>
  Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const reasons = [
  "coast_budget_unexamined",
  "pair_budget_unexamined",
  "geometry_shortlist_limit",
  "worker_unchecked",
  "shortlist_limit",
  "pending_intent",
  "cap_blocked",
  "invalid_target",
  "not_buildable",
  "invalid_worker_result",
  "invalid_source",
  "invalid_gold",
  "unaffordable",
];
const coastKeys = [
  "source_water_components",
  "eligible_target_owner_regions",
  "coast_budget_truncated_owner_regions",
  "eligible_region_component_coasts",
  "sampled_region_component_coasts",
  "eligible_coast_contacts",
  "sample_budget",
  "shore_source",
];
const candidateKeys = [
  "source_region_id",
  "target_region_id",
  "target_owner_id",
  "target_region_tiles",
  "water_component_id",
  "water_ocean_status",
  "source_shore_tiles",
  "target_shore_tiles",
  "water_span_estimate_tiles",
  "water_span_method",
  "id",
  "kind",
  "target_type",
  "status",
  "geometry_status",
  "cost_gold",
  "worker_source_confirmed",
];

export function validateNavalProposal(value, { gameId, snapshotTick }) {
  if (value === null) return null;
  if (
    !only(value, [
      "snapshot_id",
      "source_tick",
      "current_tick",
      "map_id",
      "available_troops_internal",
      "boats",
      "candidates",
      "coverage",
      "omissions",
    ]) ||
    !id(value.map_id) ||
    !value.map_id.startsWith(`${gameId}/`) ||
    !count(value.source_tick) ||
    !count(value.current_tick) ||
    value.source_tick > value.current_tick ||
    value.current_tick > snapshotTick ||
    snapshotTick - value.source_tick > 20 ||
    value.snapshot_id !== value.snapshot_id?.trim() ||
    !id(value.snapshot_id) ||
    !value.snapshot_id.startsWith(`${value.map_id}@${value.source_tick}#`) ||
    !reserve(value.available_troops_internal) ||
    !only(value.boats, ["cap", "active_count", "active_transports"]) ||
    !(value.boats.cap === null || count(value.boats.cap, 100)) ||
    !(
      value.boats.active_count === null || count(value.boats.active_count, 100)
    ) ||
    !Array.isArray(value.boats.active_transports) ||
    value.boats.active_transports.length > 100 ||
    value.boats.active_transports.some(
      (b) =>
        !only(b, ["destination_tile", "troops_internal"]) ||
        !(
          b.destination_tile === null ||
          count(b.destination_tile, 1_000_000_000)
        ) ||
        !(b.troops_internal === null || reserve(b.troops_internal)),
    ) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 16 ||
    !only(value.coverage, [
      "total_eligible",
      "worker_checked",
      "offered_count",
      "omitted_count",
      "coast",
      "certainty",
    ]) ||
    !count(value.coverage.total_eligible) ||
    !count(value.coverage.worker_checked) ||
    !count(value.coverage.offered_count) ||
    !count(value.coverage.omitted_count) ||
    value.coverage.offered_count !== value.candidates.length ||
    value.coverage.offered_count > value.coverage.worker_checked ||
    value.coverage.omitted_count !==
      value.coverage.total_eligible - value.candidates.length ||
    !only(value.coverage.coast, coastKeys) ||
    Object.entries(value.coverage.coast).some(([k, v]) =>
      k === "shore_source" ? typeof v !== "string" || v.length > 80 : !count(v),
    ) ||
    typeof value.coverage.certainty !== "string" ||
    value.coverage.certainty.length > 220 ||
    !only(value.omissions, reasons) ||
    Object.values(value.omissions).some((n) => !count(n)) ||
    Object.values(value.omissions).reduce((a, n) => a + n, 0) !==
      value.coverage.omitted_count
  ) {
    throw new Error("Invalid naval proposal");
  }
  if (
    value.boats.cap !== null &&
    value.boats.active_count !== null &&
    value.boats.active_count >= value.boats.cap &&
    value.candidates.length
  )
    throw new Error("Naval boat cap reached in proposal");
  const seen = new Set();
  for (const c of value.candidates) {
    if (
      !only(c, candidateKeys) ||
      !id(c.id) ||
      seen.has(c.id) ||
      !c.id.startsWith(`${value.snapshot_id}:boat`) ||
      c.kind !== "boat" ||
      !["wilderness", "human", "nation", "tribe"].includes(c.target_type) ||
      !count(c.target_owner_id, 4095) ||
      (c.target_type === "wilderness") !== (c.target_owner_id === 0) ||
      !count(c.target_region_tiles) ||
      c.target_region_tiles === 0 ||
      !id(c.source_region_id) ||
      !c.source_region_id.startsWith(`${value.snapshot_id}:r`) ||
      !id(c.target_region_id) ||
      !c.target_region_id.startsWith(`${value.snapshot_id}:nr`) ||
      !id(c.water_component_id) ||
      !c.water_component_id.startsWith(`${value.snapshot_id}:w`) ||
      !["ocean", "inland", "unknown"].includes(c.water_ocean_status) ||
      !count(c.source_shore_tiles) ||
      !count(c.target_shore_tiles) ||
      !count(c.water_span_estimate_tiles) ||
      c.water_span_method !== "shore_manhattan_separation_not_water_path" ||
      c.status !== "worker_checked_not_executed" ||
      c.geometry_status !== "geometric_only_not_engine_legal" ||
      c.worker_source_confirmed !== true ||
      !gold(c.cost_gold)
    )
      throw new Error("Invalid naval destination candidate");
    seen.add(c.id);
  }
  return value;
}

export function navalChoices(value, land) {
  if (value === null) return { wait: { kind: "wait" } };
  const output = { wait: { kind: "wait" } };
  for (const [index, c] of value.candidates.entries()) {
    for (const fraction of fractionsForTarget(c.target_type)) {
      // Land observation was taken after the infrequent topology scan. Its
      // display reserve is the fresher bounded estimate; execution still uses
      // the real current internal reserve through the worker-checked adapter.
      const amount = Math.floor(land.self.troops * 10 * fraction);
      if (amount < 1) continue;
      const key = `boat_${index + 1}_${Math.round(fraction * 100)}`;
      output[key] = {
        kind: "boat",
        candidate_id: c.id,
        fraction,
        target_type: c.target_type,
        target_owner_id: c.target_owner_id,
        target_region_tiles: c.target_region_tiles,
        source_region_id: c.source_region_id,
        target_region_id: c.target_region_id,
        water_ocean_status: c.water_ocean_status,
        water_span_estimate_tiles: c.water_span_estimate_tiles,
        water_span_method: c.water_span_method,
        troops_committed_estimate: amount / 10,
        troops_remaining_estimate:
          Math.round((land.self.troops - amount / 10) * 10) / 10,
        cost_gold: c.cost_gold,
      };
    }
  }
  return output;
}

export function navalCriteria(actions) {
  return Object.fromEntries(
    Object.entries(actions).map(([key, a]) => [
      key,
      a.kind === "wait"
        ? {
            action:
              "Send no new transport boat; existing ships and troop regeneration continue.",
          }
        : {
            action:
              "Send a normal TransportShip attack toward this geometric coast with worker-confirmed launch source. Water route and successful landing are NOT guaranteed.",
            candidate_id: a.candidate_id,
            target_type: a.target_type,
            target_owner_id: a.target_owner_id,
            target_region_tiles: a.target_region_tiles,
            water_ocean_status: a.water_ocean_status,
            water_span_estimate_tiles: a.water_span_estimate_tiles,
            water_span_method: a.water_span_method,
            percent_of_available_troops: a.fraction * 100,
            troops_committed_estimate: a.troops_committed_estimate,
            troops_remaining_estimate: a.troops_remaining_estimate,
            cost_gold: a.cost_gold,
          },
    ]),
  );
}

export function navalModelState(value) {
  if (value === null) return { status: "not_currently_scanned" };
  const known = value.boats.active_transports.filter(
    (b) => b.troops_internal !== null,
  );
  return {
    status: "worker_checked_snapshot_not_guaranteed_landing",
    snapshot_id: value.snapshot_id,
    fleet: {
      cap: value.boats.cap,
      active_count: value.boats.active_count,
      known_active_troops_display: Math.floor(
        known.reduce((n, b) => n + b.troops_internal, 0) / 10,
      ),
      unknown_active_troops_count:
        value.boats.active_transports.length - known.length,
    },
    offered_destinations: value.candidates.length,
    omitted_destinations: value.coverage.omitted_count,
    geographic_uncertainty: value.coverage.certainty,
    coast_summary: value.coverage.coast,
    offered_boat_sites: value.candidates.map((c) => ({
      id: c.id,
      target_type: c.target_type,
      target_owner_id: c.target_owner_id,
      target_region_tiles: c.target_region_tiles,
      water_span_estimate_tiles: c.water_span_estimate_tiles,
      water_ocean_status: c.water_ocean_status,
      cost_gold: c.cost_gold,
    })),
  };
}
