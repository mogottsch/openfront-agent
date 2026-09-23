// Future hybrid observation/action contract. No new live actions are enabled by
// importing this module. Geometry and legality originate in the game adapter;
// the model only receives bounded, opaque candidate IDs and measured features.
import {
  buildActions,
  modelState,
  validateObservation,
} from "./observation.js";

const integer = (n, max = 10_000_000) =>
  Number.isSafeInteger(n) && n >= 0 && n <= max;
const id = (s) =>
  typeof s === "string" &&
  s.length >= 1 &&
  s.length <= 200 &&
  /^[A-Za-z0-9:@#._/\-]+$/.test(s);
const gold = (s) => typeof s === "string" && /^(0|[1-9]\d{0,39})$/.test(s);
const only = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((k) => keys.includes(k)) &&
  keys.every((k) => Object.hasOwn(value, k));
const distance = (n) => Number.isSafeInteger(n) && n >= -1 && n <= 10_000_000;
const omissionKeys = [
  "not_examined",
  "prefilter_limit",
  "worker_unchecked",
  "pending_intent",
  "not_buildable",
  "relocated",
  "upgrade_not_city_build",
  "unaffordable",
  "unaffordable_after_check",
  "invalid_worker_result",
  "invalid_gold",
  "shortlist_limit",
];

export function validateHybridInput(input) {
  if (
    !only(input, ["game_id", "snapshot_tick", "land", "building", "plan"]) ||
    !id(input.game_id) ||
    !integer(input.snapshot_tick) ||
    (input.plan !== null &&
      !only(input.plan, [
        "game_id",
        "plan_version",
        "source_tick",
        "expires_tick",
        "objective",
      ]))
  ) {
    throw new Error("Invalid hybrid decision input");
  }
  const land = validateObservation(input.land);
  const b = input.building;
  if (
    !only(b, [
      "snapshot_id",
      "source_tick",
      "current_tick",
      "map_id",
      "available_gold",
      "city_counts",
      "candidates",
      "save_gold",
      "coverage",
      "omissions",
    ]) ||
    !id(b.snapshot_id) ||
    !id(b.map_id) ||
    !b.map_id.startsWith(`${input.game_id}/`) ||
    !b.snapshot_id.startsWith(`${b.map_id}@${b.source_tick}#`) ||
    !integer(b.source_tick) ||
    !integer(b.current_tick) ||
    b.source_tick > b.current_tick ||
    b.current_tick > input.snapshot_tick ||
    input.snapshot_tick - b.source_tick > 20 ||
    !gold(b.available_gold) ||
    !only(b.city_counts, ["owned", "pending"]) ||
    !(b.city_counts.owned === null || integer(b.city_counts.owned)) ||
    !integer(b.city_counts.pending) ||
    !Array.isArray(b.candidates) ||
    b.candidates.length > 24 ||
    !only(b.save_gold, ["id", "kind"]) ||
    b.save_gold.id !== `${b.snapshot_id}:save_gold` ||
    b.save_gold.kind !== "save_gold" ||
    !only(b.coverage, [
      "total_eligible",
      "total_examined",
      "worker_checked",
      "offered_count",
      "omitted_count",
      "model",
    ]) ||
    !Object.entries(b.coverage).every(([key, value]) =>
      key === "model"
        ? typeof value === "string" && value.length <= 160
        : integer(value, 100_000_000),
    ) ||
    b.coverage.offered_count !== b.candidates.length ||
    b.coverage.total_examined > b.coverage.total_eligible ||
    b.coverage.worker_checked > b.coverage.total_examined ||
    b.coverage.offered_count > b.coverage.worker_checked ||
    b.coverage.omitted_count !==
      b.coverage.total_eligible - b.candidates.length ||
    !only(b.omissions, omissionKeys) ||
    Object.values(b.omissions).some((value) => !integer(value, 100_000_000)) ||
    Object.values(b.omissions).reduce((a, n) => a + n, 0) !==
      b.coverage.omitted_count
  ) {
    throw new Error("Invalid hybrid building proposal");
  }
  const ids = new Set([b.save_gold.id]);
  for (const c of b.candidates) {
    if (
      !only(c, [
        "id",
        "kind",
        "region_id",
        "front_id",
        "water_ids",
        "distance_to_land_border",
        "distance_to_player_border",
        "marginal_coverage_tiles",
        "cost_gold",
        "gold_after_estimate",
      ]) ||
      !id(c.id) ||
      ids.has(c.id) ||
      !/^c[1-9]\d*$/.test(c.id.slice(`${b.snapshot_id}:`.length)) ||
      !c.id.startsWith(`${b.snapshot_id}:`) ||
      c.kind !== "build_city" ||
      !id(c.region_id) ||
      !c.region_id.startsWith(`${b.snapshot_id}:r`) ||
      !(
        c.front_id === null ||
        (id(c.front_id) && c.front_id.startsWith(`${b.snapshot_id}:f`))
      ) ||
      !Array.isArray(c.water_ids) ||
      c.water_ids.length > 8 ||
      c.water_ids.some((w) => !id(w) || !w.startsWith(`${b.snapshot_id}:w`)) ||
      !distance(c.distance_to_land_border) ||
      !distance(c.distance_to_player_border) ||
      !integer(c.marginal_coverage_tiles) ||
      !gold(c.cost_gold) ||
      !gold(c.gold_after_estimate) ||
      BigInt(c.cost_gold) + BigInt(c.gold_after_estimate) !==
        BigInt(b.available_gold)
    ) {
      throw new Error("Invalid hybrid city candidate");
    }
    ids.add(c.id);
  }
  const p = input.plan;
  if (
    p !== null &&
    (!id(p.game_id) ||
      p.game_id !== input.game_id ||
      !integer(p.plan_version) ||
      p.plan_version === 0 ||
      !integer(p.source_tick) ||
      p.source_tick > input.snapshot_tick ||
      !integer(p.expires_tick) ||
      p.expires_tick <= input.snapshot_tick ||
      p.expires_tick > p.source_tick + 300 ||
      typeof p.objective !== "string" ||
      !p.objective.trim() ||
      p.objective.length > 240)
  )
    throw new Error("Invalid hybrid plan");
  return { ...input, land };
}

export function hybridChoices(input) {
  const o = validateHybridInput(input);
  const land = buildActions(o.land);
  const branch = {
    wait: {
      action: "Do not issue a new land attack or city construction intent.",
    },
  };
  if (Object.keys(land).length > 1)
    branch.land_attack = {
      action:
        "Consider a normal land attack or wait after reviewing attack target/size choices.",
    };
  const city = {
    save_gold: { action: "Do not construct a city; keep all current gold." },
  };
  for (const [index, c] of o.building.candidates.entries()) {
    const key = `build_city_${index + 1}`;
    const available = BigInt(o.building.available_gold);
    city[key] = {
      action:
        "Build one City via a normal game intent at this worker-checked site.",
      candidate_id: c.id,
      cost_gold: c.cost_gold,
      gold_after_estimate: c.gold_after_estimate,
      gold_spend_percent:
        available > 0n
          ? Number((BigInt(c.cost_gold) * 10_000n) / available) / 100
          : 0,
      region_id: c.region_id,
      front_id: c.front_id,
      water_ids: c.water_ids,
      distance_to_land_border: c.distance_to_land_border,
      distance_to_player_border: c.distance_to_player_border,
      marginal_coverage_tiles: c.marginal_coverage_tiles,
      coverage_model: o.building.coverage.model,
    };
  }
  if (o.building.candidates.length)
    branch.city_build = {
      action:
        "Consider construction of one currently worker-checked City site, or save the gold.",
    };
  return { branch, land, city };
}

export function hybridModelState(input) {
  const o = validateHybridInput(input);
  return {
    ...modelState(o.land),
    game_id: o.game_id,
    snapshot_tick: o.snapshot_tick,
    economy: {
      available_gold: o.building.available_gold,
      cities: o.building.city_counts,
      city_sites_checked: o.building.coverage.worker_checked,
      city_sites_offered: o.building.candidates.length,
      city_sites_omitted: o.building.coverage.omitted_count,
      offered_city_sites: o.building.candidates.map((c) => ({
        id: c.id,
        cost_gold: c.cost_gold,
        gold_after_estimate: c.gold_after_estimate,
        distance_to_player_border: c.distance_to_player_border,
        distance_to_land_border: c.distance_to_land_border,
        region_id: c.region_id,
      })),
      // All offered sites, not an extra strategically filtered top-k; branch
      // Choice cannot see the independent site Choice criteria/answer.
      building_snapshot_id: o.building.snapshot_id,
    },
    objective:
      o.plan === null
        ? null
        : {
            text: o.plan.objective,
            version: o.plan.plan_version,
            source_tick: o.plan.source_tick,
            expires_tick: o.plan.expires_tick,
          },
  };
}
