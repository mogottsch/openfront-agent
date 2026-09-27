import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequest, parseDecision, POLICY_VERSION } from '../src/policy.mjs';

// Raw-schema projections of exact rows 41, 73 and 78 from the ignored local
// 2026-09-27 180-call match log. Values relevant to this policy (own reserve,
// borders, all neighbors, their incoming records and our outgoing records) are
// frozen here so dependency-free tests also work from a fresh public checkout.
// The selected actions are HISTORICAL v4.2 Jev outcomes, not expected v4.3
// model predictions. See local logs/decisions-2026-09-27T08-14-19.216Z.jsonl.
const attack = (id, attacker_id, attacker_type, attacker_reserve_troops,
  troops, retreating = false) => ({ id, attacker_id, attacker_type,
  attacker_reserve_troops, troops, retreating });
const n = (id, type, shared_border_edges, troops, troop_capacity,
  territory_tiles, incoming_attacks = []) => ({ id, type,
  relationship: 'unallied', shared_border_edges, troops, troop_capacity,
  territory_tiles, can_attack: true, incoming_attacks });
const out = (id, target_id, troops, retreating = false) =>
  ({ id, target_id, troops, retreating });
const frozen = {
  firstSpread: {
    timestamp: '2026-09-27T08:35:10.487Z', oldChoice: 'attack_player_222_10',
    self: [19152, 41374, 4563], border: [766, 0, 588, 178, 0],
    neighbors: [
      n(76, 'tribe', 125, 1726, 10435, 2394),
      n(102, 'tribe', 32, 2509, 12409, 3603),
      n(222, 'tribe', 12, 3112, 11528, 3039),
      n(226, 'tribe', 205, 2972, 11264, 2878),
      n(246, 'tribe', 18, 1270, 10699, 2544,
        [attack('e1uvw9an', 1, 'human', 19152, 1985)]),
      n(275, 'tribe', 75, 2073, 11378, 2947),
      n(374, 'tribe', 56, 2349, 11494, 3018),
      n(411, 'tribe', 65, 4302, 9161, 1722),
    ], outgoing_attacks: [out('e1uvw9an', 246, 1985)],
  },
  firstNation: {
    timestamp: '2026-09-27T08:35:43.137Z', oldChoice: 'attack_player_37_10',
    self: [32501, 59306, 9693], border: [1018, 0, 746, 272, 0],
    neighbors: [
      n(37, 'nation', 30, 37806, 77590, 10616),
      n(38, 'nation', 11, 38232, 96539, 16252,
        [attack('vaqap4sw', 246, 'tribe', 3225, 1222)]),
      n(59, 'tribe', 60, 4564, 10898, 2660,
        [attack('7espow64', 1, 'human', 32501, 43),
          attack('m9ugmeiq', 411, 'tribe', 3492, 584)]),
      n(102, 'tribe', 49, 5661, 11602, 3085,
        [attack('gq4aemcd', 1, 'human', 32501, 2113)]),
      n(222, 'tribe', 30, 5589, 11368, 2941),
      n(226, 'tribe', 217, 4725, 10219, 2274),
      n(246, 'tribe', 74, 3225, 9995, 2152),
      n(275, 'tribe', 95, 4995, 13142, 4101),
      n(374, 'tribe', 85, 5189, 11541, 3047),
      n(411, 'tribe', 95, 3492, 7969, 1176),
    ], outgoing_attacks: [out('7espow64', 59, 43),
      out('gq4aemcd', 102, 2113)],
  },
  secondNation: {
    timestamp: '2026-09-27T08:35:48.620Z', oldChoice: 'attack_player_38_10',
    self: [35064, 59866, 9877], border: [1046, 0, 774, 272, 0],
    neighbors: [
      n(37, 'nation', 38, 45319, 84733, 12628,
        [attack('q8mgeuuj', 1, 'human', 35064, 2248),
          attack('rig79gz8', 71, 'tribe', 6697, 1430)]),
      n(38, 'nation', 11, 47335, 100955, 17700,
        [attack('vaqap4sw', 246, 'tribe', 4075, 160)]),
      n(59, 'tribe', 62, 4917, 10403, 2376,
        [attack('zcye9r7j', 201, 'tribe', 5130, 2747)]),
      n(102, 'tribe', 54, 4689, 11486, 3013),
      n(222, 'tribe', 31, 6491, 11484, 3012),
      n(226, 'tribe', 217, 5569, 10219, 2274),
      n(246, 'tribe', 77, 4075, 10210, 2269),
      n(275, 'tribe', 95, 6043, 13415, 4293),
      n(374, 'tribe', 87, 6118, 11541, 3047),
      n(411, 'tribe', 102, 4214, 8126, 1243),
    ], outgoing_attacks: [out('q8mgeuuj', 37, 2248)],
  },
};
function observationAt(row) {
  const [troops, troop_capacity, territory_tiles] = row.self;
  const [total_edges, wilderness_edges, player_edges, water_edges,
    blocked_edges] = row.border;
  return {
    self: { id: 1, troops, troop_capacity, territory_tiles },
    border: { total_edges, wilderness_edges, player_edges, water_edges,
      blocked_edges },
    neighbors: row.neighbors, incoming_attacks: [],
    outgoing_attacks: row.outgoing_attacks,
  };
}
const response = (choice, criteria) => ({ model: 'mock-only', usage: {},
  answers: { action: { type: 'choice', choice, confidence: 0.9,
    probabilities: Object.fromEntries(Object.keys(criteria).map((key) =>
      [key, key === choice ? 1 : 0])),
  } },
});

test('frozen 08:35:10: already attacked tribe246 before Jev opened tribe222', () => {
  const row = frozen.firstSpread;
  const request = buildRequest(observationAt(row));
  const q = request.questions.action;
  assert.equal(POLICY_VERSION, 'land-strategy-v4.3-tribe-focus');
  assert.equal(row.oldChoice, 'attack_player_222_10');
  assert.equal(request.state.neighbors.find((p) => p.id === 246)
    .our_active_attack_troops, 1985);
  assert.match(q.instructions.join(' '), /finish that tribe before starting another tribe, wilderness or nation attack/i);
  assert.match(q.criteria.wait.tribe_focus_context, /246/);
  assert.match(q.criteria.attack_player_246_10.tribe_focus_context,
    /already attacking this tribe/i);
  assert.match(q.criteria.attack_player_222_10.tribe_focus_context,
    /do not open a new tribe front/i);
  // Descriptions instruct Jev. They do not secretly remove a legal option or
  // substitute another decision: both the historical choice and wait parse.
  assert.equal(parseDecision(response(row.oldChoice, q.criteria), q.criteria)
    .action, row.oldChoice);
  assert.equal(parseDecision(response('wait', q.criteria), q.criteria)
    .action, 'wait');
});

test('frozen 08:35:43/48: nations offered but eight bordering tribes remain', () => {
  for (const [row, nationId, targetTiles, ratio] of [
    [frozen.firstNation, 37, 10616, 0.086],
    [frozen.secondNation, 38, 17700, 0.0741],
  ]) {
    const request = buildRequest(observationAt(row));
    const q = request.questions.action;
    const nation = q.criteria[`attack_player_${nationId}_10`];
    assert.equal(request.state.neighbors.filter((n) => n.type === 'tribe' &&
      n.can_attack).length, 8);
    assert.equal(nation.target_territory_tiles, targetTiles);
    assert.equal(nation.committed_to_defender_ratio, ratio);
    assert.match(nation.nation_conquest_context,
      /8 attackable bordering tribes left/);
    assert.match(nation.nation_conquest_context,
      /Do not start a nation attack until all those tribes are conquered/);
    assert.match(q.instructions.join(' '),
      /current(ly)? available troops or committed-to-defender ratio do NOT measure total territorial resistance/i);
    assert.equal(parseDecision(response(row.oldChoice, q.criteria), q.criteria)
      .action, row.oldChoice); // no code veto or target substitution
  }
  const first = buildRequest(observationAt(frozen.firstNation));
  assert.equal(first.state.neighbors.find((n) => n.id === 59)
    .our_active_attack_troops, 43);
  assert.equal(first.state.neighbors.find((n) => n.id === 102)
    .our_active_attack_troops, 2113);
  assert.equal(buildRequest(observationAt(frozen.secondNation)).state
    .neighbors.find((n) => n.id === 37).our_active_attack_troops, 2248);
});

test('retreating/zero-force attack is not falsely marked as a current focus', () => {
  const row = structuredClone(frozen.firstSpread);
  row.outgoing_attacks[0].retreating = true;
  row.neighbors.find((n) => n.id === 246).incoming_attacks[0].retreating = true;
  const request = buildRequest(observationAt(row));
  assert.equal(request.state.neighbors.find((n) => n.id === 246)
    .our_active_attack_troops, 0);
  assert.equal(request.questions.action.criteria.wait.tribe_focus_context,
    undefined);
  assert.match(request.questions.action.criteria.attack_player_246_10
    .tribe_focus_context, /No currently observed active attack/);
  // Neither this observation nor a vanished neighbor proves conquest; a
  // separately reviewed persistent focus observation is needed for that.
});
