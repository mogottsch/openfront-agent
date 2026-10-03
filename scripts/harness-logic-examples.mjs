// Illustrative documentation inputs only. Pure builders/validators; no worker,
// controller, transport, credentials, inference, or gameplay imports/calls.
import { fileURLToPath } from 'node:url';
import { buildActions, modelState } from '../web/observation.js';
import { buildHybridRequest, HYBRID_POLICY_VERSION } from '../src/hybrid-policy.mjs';
import { buildRequest, POLICY_VERSION } from '../src/policy.mjs';
import { buildNavalDecomposedRequest } from '../src/naval-decomposed-policy.mjs';
import { hybridChoices } from '../web/hybrid-observation.js';

const zeros = (keys) => Object.fromEntries(keys.split(' ').map((key) => [key, 0]));

export function exampleInput() {
  const s = 'demo/map@100#1';
  const land = {
    self: { id: 1, troops: 8000, troop_capacity: 20000, territory_tiles: 500 },
    border: { total_edges: 28, wilderness_edges: 8, player_edges: 8, water_edges: 10, blocked_edges: 2 },
    neighbors: [
      { id: 2, type: 'tribe', relationship: 'unallied', shared_border_edges: 5, troops: 1000, troop_capacity: 5000, territory_tiles: 100, can_attack: true, incoming_attacks: [],
        structures: { source_tick: 100, city: { completed_count: 0, constructing_count: 0, completed_levels: 0 }, defense_post: { completed_count: 0, constructing_count: 0, completed_levels: 0 } } },
      { id: 3, type: 'human', relationship: 'ally', shared_border_edges: 3, troops: 3000, troop_capacity: 12000, territory_tiles: 300, can_attack: false, incoming_attacks: [] },
    ],
    incoming_attacks: [], outgoing_attacks: [],
    win_context: {
      game_id: 'demo', source_tick: 100,
      rule: 'ffa_largest_alive_territory_at_timer_or_strict_share',
      elapsed_seconds: 9.9, timer_seconds: 300, share_threshold_percent: 80,
      non_fallout_land_tiles: 568335, eligible_alive_count: 3,
      self_rank_by_tiles: 1, leading_territory_tiles: 500,
      tied_leader_count: 1, leader: { id: 1, type: 'human' },
    },
  };
  return {
    game_id: 'demo', snapshot_tick: 100, land, plan: null,
    city_mechanics: { troop_capacity_gain_display: 25000, construction_ticks: 20 },
    building: {
      snapshot_id: s, source_tick: 100, current_tick: 100, map_id: 'demo/map', available_gold: '300000', city_counts: { owned: 0, pending: 0 },
      candidates: [{ id: `${s}:c1`, kind: 'build_city', region_id: `${s}:r1`, front_id: `${s}:f1`, water_ids: [], distance_to_land_border: 6, distance_to_player_border: 12, marginal_coverage_tiles: 90, cost_gold: '125000', gold_after_estimate: '175000' }],
      save_gold: { id: `${s}:save_gold`, kind: 'save_gold' },
      coverage: { total_eligible: 500, total_examined: 500, worker_checked: 12, offered_count: 1, omitted_count: 499, model: 'Euclidean tile disc over owned passable land; geometric only' },
      omissions: { ...zeros('not_examined prefilter_limit worker_unchecked pending_intent occupied_city not_buildable relocated upgrade_not_city_build unaffordable unaffordable_after_check invalid_worker_result invalid_gold shortlist_limit'), prefilter_limit: 488, not_buildable: 11 },
    },
    naval: {
      snapshot_id: s, source_tick: 100, current_tick: 100, map_id: 'demo/map', available_troops_internal: 80000,
      boats: { cap: 3, active_count: 0, active_transports: [] },
      candidates: [{ id: `${s}:boat1`, kind: 'boat', source_region_id: `${s}:r1`, target_region_id: `${s}:nr1`, target_owner_id: 0, target_type: 'wilderness', target_region_tiles: 120, water_component_id: `${s}:w1`, water_ocean_status: 'ocean', source_shore_tiles: 7, target_shore_tiles: 9, water_span_estimate_tiles: 19, water_span_method: 'shore_manhattan_separation_not_water_path', status: 'worker_checked_not_executed', geometry_status: 'geometric_only_not_engine_legal', cost_gold: '0', worker_source_confirmed: true }],
      coverage: { total_eligible: 1, worker_checked: 1, offered_count: 1, omitted_count: 0, coast: { source_water_components: 1, eligible_target_owner_regions: 1, coast_budget_truncated_owner_regions: 0, eligible_region_component_coasts: 1, sampled_region_component_coasts: 1, eligible_coast_contacts: 9, sample_budget: 128, shore_source: 'isShore_and_water_adjacency' }, certainty: 'Full-resolution geometry; worker-confirmed source, not a guaranteed route or landing' },
      omissions: zeros('coast_budget_unexamined pair_budget_unexamined geometry_shortlist_limit worker_unchecked shortlist_limit pending_intent cap_blocked invalid_target not_buildable invalid_worker_result invalid_source invalid_gold unaffordable'),
    },
    defense_post: {
      snapshot_id: s, source_tick: 100, current_tick: 100, map_id: 'demo/map', available_gold: '300000',
      mechanics: { range_tiles: 30, construction_ticks: 50, coverage_model: 'Euclidean radius over own land/front contacts; potential geometry, not an attack route' },
      posts: { active_completed: 0, under_construction: 0, status_unknown: 0, pending_unconfirmed: 0 },
      incoming: { observed_attacker_ids: [], non_retreating_attacker_ids: [], ids_without_land_contact: [], contact_is_only_potential: true },
      candidates: [{ id: `${s}:dp1`, kind: 'build_defense_post', region_id: `${s}:r1`, front_id: `${s}:f1`, water_ids: [], distance_to_land_border: 1, distance_to_player_border: 1, marginal_owned_territory_tiles: 20, marginal_hostile_front_contacts: 3, marginal_potential_incoming_front_contacts: 0, potential_incoming_contact_ids: [], cost_gold: '50000', gold_after_estimate: '250000' }],
      save_gold: { id: `${s}:save_gold`, kind: 'save_gold' },
      coverage: { total_eligible: 500, total_examined: 500, worker_checked: 12, offered_count: 1, omitted_count: 499, uncovered_hostile_front_contacts: 4, uncovered_potential_incoming_front_contacts: 0 },
      omissions: { ...zeros('not_examined geometry_shortlist_limit worker_unchecked shortlist_limit pending_intent occupied_post not_buildable relocated upgrade_not_build unaffordable unaffordable_after_check invalid_worker_result invalid_gold'), geometry_shortlist_limit: 488, not_buildable: 11 },
    },
  };
}

export function buildExampleSet() {
  const input = exampleInput();
  const choices = hybridChoices(input); // strict validation of the whole example
  const request = buildHybridRequest(input);
  const landRequest = buildRequest(input.land);
  const decomposed = buildNavalDecomposedRequest(input);
  const focusLand = { ...input.land, tribe_focus: { id: 2, type: 'tribe', alive: true, troops: 1000, territory_tiles: 100, adjacent: true, can_attack: true, progress: { reference_kind: 'first_emitted_land_intent', reference_tick: 90, reference_tiles: 105, land_intents_emitted: 2, last_land_send_percent: 10, elapsed_ticks: 10 } } };
  const focused = buildRequest(focusLand);
  return {
    generatedAt: new Date().toISOString(), sourceVersions: { land: POLICY_VERSION, hybrid: HYBRID_POLICY_VERSION },
    label: 'Illustrative synthetic inputs, validated/projected by current pure source builders. NOT a live game, worker result, model answer, intent or outcome.',
    input,
    families: {
      land: { candidate: buildActions(input.land).attack_player_2_20, criterion: landRequest.questions.action.criteria.attack_player_2_20, key: 'attack_player_2_20', request: landRequest, proposal: input.land, privateLookup: 'target_id: 2 → current PlayerView.id() via the game adapter' },
      city: { candidate: input.building.candidates[0], criterion: choices.city.build_city_1, key: 'build_city_1', request, proposal: input.building, privateLookup: `internal.get("${input.building.candidates[0].id}")\n→ { tile: 123, cost: 125000n }\n// illustrative private mapping; never sent to Jev` },
      boat: { candidate: input.naval.candidates[0], criterion: decomposed.questions.boat_target.criteria.boat_target_1, sizeCriterion: decomposed.questions.boat_size_1.criteria.send_20, key: 'boat_target_1 + send_20', request: decomposed, proposal: input.naval, privateLookup: `offered.get("${input.naval.candidates[0].id}")\n→ { tile: 456, owner: 0, type: "wilderness",\n    source: 123, cost: 0n }\n// illustrative private refs; never sent to Jev` },
      post: { candidate: input.defense_post.candidates[0], criterion: choices.post.build_defense_post_1, key: 'build_defense_post_1', request, proposal: input.defense_post, privateLookup: `offered.get("${input.defense_post.candidates[0].id}")\n→ { tile: 125, cost: 50000n }\n// illustrative private mapping; never sent to Jev` },
    },
    focus: { raw: focusLand.tribe_focus, model: modelState(focusLand).tribe_focus, strategy: modelState(focusLand).strategy, offeredKeys: Object.keys(focused.questions.action.criteria) },
    inventory: input.land.neighbors[0].structures,
    winContext: { raw: input.land.win_context, model: request.state.win_context },
    questionKeys: Object.keys(decomposed.questions),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  globalThis.fetch = () => { throw new Error('Network forbidden in documentation examples'); };
  console.log(JSON.stringify(buildExampleSet()));
}
