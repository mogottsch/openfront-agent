import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefensePostAdapter } from '../web/defense-post-adapter.js';
import {
  validateDefensePostProposal,
  defensePostChoices,
  defensePostModelState,
} from '../web/defense-observation.js';

const sample = () => {
  const snapshot_id = 'game/map@100#1';
  const omissions = Object.fromEntries([
    'not_examined', 'geometry_shortlist_limit', 'worker_unchecked',
    'shortlist_limit', 'pending_intent', 'occupied_post', 'not_buildable',
    'relocated', 'upgrade_not_build', 'unaffordable',
    'unaffordable_after_check', 'invalid_worker_result', 'invalid_gold',
  ].map((key) => [key, 0]));
  return {
    snapshot_id, source_tick: 100, current_tick: 100, map_id: 'game/map',
    available_gold: '9007199254740995',
    mechanics: { range_tiles: 30, construction_ticks: 50,
      coverage_model: 'Euclidean radius on own land/front contacts; active completed posts only, not promised combat protection' },
    posts: { active_completed: 1, under_construction: 1,
      status_unknown: 0, pending_unconfirmed: 0 },
    incoming: { observed_attacker_ids: [2, 3],
      non_retreating_attacker_ids: [2], ids_without_land_contact: [3],
      contact_is_only_potential: true },
    candidates: [{ id: `${snapshot_id}:dp1`, kind: 'build_defense_post',
      region_id: `${snapshot_id}:r1`, front_id: `${snapshot_id}:f1`,
      water_ids: [], distance_to_land_border: 1, distance_to_player_border: 1,
      marginal_owned_territory_tiles: 20, marginal_hostile_front_contacts: 3,
      marginal_potential_incoming_front_contacts: 2,
      potential_incoming_contact_ids: [2],
      cost_gold: '50000', gold_after_estimate: '9007199254690995' }],
    save_gold: { id: `${snapshot_id}:save_gold`, kind: 'save_gold' },
    coverage: { total_eligible: 1, total_examined: 1, worker_checked: 1,
      offered_count: 1, omitted_count: 0,
      uncovered_hostile_front_contacts: 4,
      uncovered_potential_incoming_front_contacts: 2 },
    omissions,
  };
};
const validate = (p) => validateDefensePostProposal(p,
  { gameId: 'game', snapshotTick: 100 });

test('strict opaque worker site projects only costs and potential geometry, never tiles', () => {
  const p = sample();
  assert.equal(validate(p), p);
  assert.deepEqual(Object.keys(defensePostChoices(p)),
    ['save_gold', 'build_defense_post_1']);
  assert.equal(defensePostChoices(p).build_defense_post_1.candidate_id,
    p.candidates[0].id);
  const state = defensePostModelState(p);
  assert.deepEqual(state.posts, p.posts);
  assert.equal(state.offered_post_sites[0].marginal_potential_incoming_front_contacts, 2);
  assert.equal(state.incoming.contact_is_only_potential, true);
  assert.equal(state.mechanics.range_tiles, 30);
  assert.equal(defensePostModelState(null).status, 'not_currently_scanned');
  assert.deepEqual(Object.keys(defensePostChoices(null)), ['save_gold']);
  const sent = JSON.stringify({ state, choices: defensePostChoices(p) });
  assert.ok(!sent.includes('"tile"'));
  assert.ok(!sent.includes('target_shore_tile'));
  assert.ok(!sent.includes('attack_path'));
});

test('unsupported, stale, invented, inconsistent and unbounded proposals fail closed', () => {
  const changes = [
    (x) => { x.source_tick = 79; },
    (x) => { x.current_tick = 101; },
    (x) => { x.map_id = 'other/map'; },
    (x) => { x.candidates[0].id = `${x.snapshot_id}:dp0`; },
    (x) => { x.candidates[0].tile = 7; },
    (x) => { x.candidates[0].gold_after_estimate = '1'; },
    (x) => { x.candidates[0].kind = 'upgrade'; },
    (x) => { x.candidates[0].potential_incoming_contact_ids = [3]; },
    (x) => { x.candidates[0].marginal_potential_incoming_front_contacts = 4; },
    (x) => { x.incoming.observed_attacker_ids = [2, 2]; },
    (x) => { x.incoming.non_retreating_attacker_ids = [9]; },
    (x) => { x.incoming.contact_is_only_potential = false; },
    (x) => { x.coverage.worker_checked = 0; },
    (x) => { x.coverage.omitted_count = 1; },
    (x) => { x.omissions.invented = 0; },
    (x) => { x.posts.under_construction = -1; },
    (x) => { x.mechanics.range_tiles = 2049; },
    (x) => { x.candidates = Array.from({length:25}, (_, i) => ({
      ...x.candidates[0], id:`${x.snapshot_id}:dp${i+1}` })); },
  ];
  for (const mutate of changes) {
    const p = sample();
    mutate(p);
    assert.throws(() => validate(p));
  }
});

test('strict contract accepts actual createDefensePostAdapter.propose output', async () => {
  const owner = [2, 1];
  const me = { smallID: () => 1, gold: () => 100000n,
    units: () => [], incomingAttacks: () => [{attackerID: 2, retreating: false}],
    isFriendly: () => false, isOnSameTeam: () => false,
    buildables: async (tile, types) => {
      assert.deepEqual(types, ['Defense Post']);
      return [{type: 'Defense Post', canBuild: tile,
        canUpgrade: false, cost: 50000n}];
    } };
  const enemy = { isPlayer: () => true, isAlive: () => true,
    isFriendly: () => false, isOnSameTeam: () => false };
  const game = { width: () => 2, height: () => 1, ref: (x) => x,
    ownerID: (tile) => owner[tile], isLand: () => true,
    isImpassable: () => false, neighbors: (tile) => [1 - tile],
    ticks: () => 100, gameID: () => 'game', myPlayer: () => me,
    playerBySmallID: () => enemy,
    config: () => ({ defensePostRange: () => 30,
      unitInfo: () => ({constructionDuration: 50}) }) };
  const adapter = createDefensePostAdapter({ game,
    read: () => ({ready: true, ended: false, tick: 100}),
    sendBuild: () => true, defenseUnit: 'Defense Post' });
  const proposal = await adapter.propose({ mapId: 'map',
    maxCandidates: 1, maxExamined: 2, maxWorkerChecks: 1 });
  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.candidates[0].marginal_potential_incoming_front_contacts, 1);
  assert.deepEqual(proposal.candidates[0].potential_incoming_contact_ids, [2]);
  assert.equal(validateDefensePostProposal(proposal,
    { gameId: 'game', snapshotTick: 100 }), proposal);
  const model = JSON.stringify(defensePostModelState(proposal));
  assert.ok(!model.includes('"tile"'));
  assert.ok(!model.includes('"attackerID"'));
});
