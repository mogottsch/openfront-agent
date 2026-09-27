// Strict, bounded projection of an explicitly worker-checked Defense Post
// proposal. No TileRef or attack path is forwarded to Jev. A potential front
// contact is geometry, NOT an observed route or a guaranteed defense outcome.
const exact = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const id = (value) => typeof value === 'string' && value.length > 0 &&
  value.length <= 220 && /^[A-Za-z0-9:@#._/\-]+$/.test(value);
const count = (value, max = 100_000_000) => Number.isSafeInteger(value) &&
  value >= 0 && value <= max;
const distance = (value) => Number.isSafeInteger(value) &&
  value >= -1 && value <= 10_000_000;
const gold = (value) => typeof value === 'string' &&
  /^(0|[1-9]\d{0,39})$/.test(value);
const uniqueSortedIds = (values) => Array.isArray(values) && values.length <= 256 &&
  values.every((value, i) => count(value, 4095) && value > 0 &&
    (i === 0 || values[i - 1] < value));

const omissionKeys = [
  'not_examined', 'geometry_shortlist_limit', 'worker_unchecked',
  'shortlist_limit', 'pending_intent', 'occupied_post', 'not_buildable',
  'relocated', 'upgrade_not_build', 'unaffordable',
  'unaffordable_after_check', 'invalid_worker_result', 'invalid_gold',
];
const candidateKeys = [
  'region_id', 'front_id', 'water_ids', 'distance_to_land_border',
  'distance_to_player_border', 'marginal_owned_territory_tiles',
  'marginal_hostile_front_contacts',
  'marginal_potential_incoming_front_contacts',
  'potential_incoming_contact_ids', 'id', 'kind', 'cost_gold',
  'gold_after_estimate',
];

export function validateDefensePostProposal(value, { gameId, snapshotTick }) {
  if (value === null) return null;
  if (!id(gameId) || !count(snapshotTick) ||
      !exact(value, ['snapshot_id', 'source_tick', 'current_tick', 'map_id',
        'available_gold', 'mechanics', 'posts', 'incoming', 'candidates',
        'save_gold', 'coverage', 'omissions']) ||
      !id(value.map_id) || !value.map_id.startsWith(`${gameId}/`) ||
      !count(value.source_tick) || !count(value.current_tick) ||
      value.source_tick > value.current_tick ||
      value.current_tick > snapshotTick || snapshotTick - value.source_tick > 20 ||
      !id(value.snapshot_id) ||
      !value.snapshot_id.startsWith(`${value.map_id}@${value.source_tick}#`) ||
      !gold(value.available_gold) ||
      !exact(value.mechanics, ['range_tiles', 'construction_ticks', 'coverage_model']) ||
      !count(value.mechanics.range_tiles, 2048) ||
      !(value.mechanics.construction_ticks === null ||
        count(value.mechanics.construction_ticks, 60_000)) ||
      typeof value.mechanics.coverage_model !== 'string' ||
      value.mechanics.coverage_model.length > 200 ||
      !exact(value.posts, ['active_completed', 'under_construction',
        'status_unknown', 'pending_unconfirmed']) ||
      Object.values(value.posts).some((n) => !count(n)) ||
      !exact(value.incoming, ['observed_attacker_ids',
        'non_retreating_attacker_ids', 'ids_without_land_contact',
        'contact_is_only_potential']) ||
      value.incoming.contact_is_only_potential !== true ||
      !uniqueSortedIds(value.incoming.observed_attacker_ids) ||
      !uniqueSortedIds(value.incoming.non_retreating_attacker_ids) ||
      !uniqueSortedIds(value.incoming.ids_without_land_contact) ||
      value.incoming.non_retreating_attacker_ids.some((n) =>
        !value.incoming.observed_attacker_ids.includes(n)) ||
      value.incoming.ids_without_land_contact.some((n) =>
        !value.incoming.observed_attacker_ids.includes(n)) ||
      !Array.isArray(value.candidates) || value.candidates.length > 24 ||
      !exact(value.save_gold, ['id', 'kind']) ||
      value.save_gold.kind !== 'save_gold' ||
      value.save_gold.id !== `${value.snapshot_id}:save_gold` ||
      !exact(value.coverage, ['total_eligible', 'total_examined',
        'worker_checked', 'offered_count', 'omitted_count',
        'uncovered_hostile_front_contacts',
        'uncovered_potential_incoming_front_contacts']) ||
      Object.values(value.coverage).some((n) => !count(n)) ||
      value.coverage.total_examined > value.coverage.total_eligible ||
      value.coverage.worker_checked > value.coverage.total_examined ||
      value.coverage.offered_count !== value.candidates.length ||
      value.coverage.offered_count > value.coverage.worker_checked ||
      value.coverage.omitted_count !==
        value.coverage.total_eligible - value.candidates.length ||
      value.coverage.uncovered_potential_incoming_front_contacts >
        value.coverage.uncovered_hostile_front_contacts ||
      !exact(value.omissions, omissionKeys) ||
      Object.values(value.omissions).some((n) => !count(n)) ||
      Object.values(value.omissions).reduce((sum, n) => sum + n, 0) !==
        value.coverage.omitted_count)
    throw new Error('Invalid Defense Post proposal');
  const ids = new Set([value.save_gold.id]);
  for (const c of value.candidates) {
    if (!exact(c, candidateKeys) || !id(c.id) || ids.has(c.id) ||
        !c.id.startsWith(`${value.snapshot_id}:`) ||
        !/^dp[1-9]\d*$/.test(c.id.slice(`${value.snapshot_id}:`.length)) ||
        c.kind !== 'build_defense_post' ||
        !id(c.region_id) || !c.region_id.startsWith(`${value.snapshot_id}:r`) ||
        !(c.front_id === null ||
          (id(c.front_id) && c.front_id.startsWith(`${value.snapshot_id}:f`))) ||
        !Array.isArray(c.water_ids) || c.water_ids.length > 8 ||
        c.water_ids.some((water) => !id(water) ||
          !water.startsWith(`${value.snapshot_id}:w`)) ||
        !distance(c.distance_to_land_border) ||
        !distance(c.distance_to_player_border) ||
        !count(c.marginal_owned_territory_tiles) ||
        !count(c.marginal_hostile_front_contacts) ||
        !count(c.marginal_potential_incoming_front_contacts) ||
        c.marginal_potential_incoming_front_contacts >
          c.marginal_hostile_front_contacts ||
        c.marginal_hostile_front_contacts >
          value.coverage.uncovered_hostile_front_contacts ||
        c.marginal_potential_incoming_front_contacts >
          value.coverage.uncovered_potential_incoming_front_contacts ||
        !uniqueSortedIds(c.potential_incoming_contact_ids) ||
        c.potential_incoming_contact_ids.some((n) =>
          !value.incoming.non_retreating_attacker_ids.includes(n) ||
          value.incoming.ids_without_land_contact.includes(n)) ||
        (c.marginal_potential_incoming_front_contacts === 0 &&
          c.potential_incoming_contact_ids.length !== 0) ||
        (c.marginal_potential_incoming_front_contacts > 0 &&
          c.potential_incoming_contact_ids.length === 0) ||
        !gold(c.cost_gold) || !gold(c.gold_after_estimate) ||
        BigInt(c.cost_gold) + BigInt(c.gold_after_estimate) !==
          BigInt(value.available_gold))
      throw new Error('Invalid Defense Post site');
    ids.add(c.id);
  }
  return value;
}

export function defensePostChoices(value) {
  const choices = {
    save_gold: { action: 'Do not build a new Defense Post; preserve gold.' },
  };
  if (value === null) return choices;
  for (const [index, c] of value.candidates.entries()) {
    choices[`build_defense_post_${index + 1}`] = {
      action: 'Build one worker-checked Defense Post via normal game intent.',
      candidate_id: c.id,
      cost_gold: c.cost_gold,
      gold_after_estimate: c.gold_after_estimate,
      range_tiles: value.mechanics.range_tiles,
      construction_ticks: value.mechanics.construction_ticks,
      region_id: c.region_id,
      distance_to_player_border: c.distance_to_player_border,
      marginal_owned_territory_tiles: c.marginal_owned_territory_tiles,
      marginal_hostile_front_contacts: c.marginal_hostile_front_contacts,
      marginal_potential_incoming_front_contacts:
        c.marginal_potential_incoming_front_contacts,
      potential_incoming_contact_ids: c.potential_incoming_contact_ids,
      coverage_model: value.mechanics.coverage_model,
    };
  }
  return choices;
}

export function defensePostModelState(value) {
  if (value === null) return { status: 'not_currently_scanned' };
  return {
    status: 'worker_checked_geometric_potential_not_guaranteed_protection',
    snapshot_id: value.snapshot_id,
    available_gold: value.available_gold,
    mechanics: value.mechanics,
    posts: value.posts,
    incoming: value.incoming,
    eligible_sites: value.coverage.total_eligible,
    worker_checked_sites: value.coverage.worker_checked,
    offered_sites: value.candidates.length,
    omitted_sites: value.coverage.omitted_count,
    uncovered_hostile_front_contacts:
      value.coverage.uncovered_hostile_front_contacts,
    uncovered_potential_incoming_front_contacts:
      value.coverage.uncovered_potential_incoming_front_contacts,
    offered_post_sites: value.candidates.map((c) => ({
      id: c.id,
      cost_gold: c.cost_gold,
      gold_after_estimate: c.gold_after_estimate,
      region_id: c.region_id,
      marginal_owned_territory_tiles: c.marginal_owned_territory_tiles,
      marginal_hostile_front_contacts: c.marginal_hostile_front_contacts,
      marginal_potential_incoming_front_contacts:
        c.marginal_potential_incoming_front_contacts,
      potential_incoming_contact_ids: c.potential_incoming_contact_ids,
    })),
  };
}
