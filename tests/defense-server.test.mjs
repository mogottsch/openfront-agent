import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentServer } from '../src/server.mjs';
import { HYBRID_POLICY_VERSION } from '../src/hybrid-policy.mjs';
import { observation } from './fixtures/land.mjs';

function defenseInput() {
  const snapshot_id = 'solo-1/map@100#2';
  return {
    game_id: 'solo-1', snapshot_tick: 100,
    land: observation(8000, 20000, 'tribe'),
    city_mechanics: { troop_capacity_gain_display: 25000, construction_ticks: 20 },
    building: null, plan: null, naval: null,
    defense_post: {
      snapshot_id, source_tick: 100, current_tick: 100,
      map_id: 'solo-1/map', available_gold: '100000',
      mechanics: { range_tiles: 30, construction_ticks: 50,
        coverage_model: 'Euclidean radius; potential front contacts, not guaranteed protection' },
      posts: { active_completed: 0, under_construction: 1,
        status_unknown: 0, pending_unconfirmed: 0 },
      incoming: { observed_attacker_ids: [2], non_retreating_attacker_ids: [2],
        ids_without_land_contact: [], contact_is_only_potential: true },
      candidates: [{ id: `${snapshot_id}:dp1`, kind: 'build_defense_post',
        region_id: `${snapshot_id}:r1`, front_id: `${snapshot_id}:f1`,
        water_ids: [], distance_to_land_border: 1,
        distance_to_player_border: 1,
        marginal_owned_territory_tiles: 42,
        marginal_hostile_front_contacts: 3,
        marginal_potential_incoming_front_contacts: 2,
        potential_incoming_contact_ids: [2],
        cost_gold: '50000', gold_after_estimate: '50000' }],
      save_gold: { id: `${snapshot_id}:save_gold`, kind: 'save_gold' },
      coverage: { total_eligible: 1, total_examined: 1, worker_checked: 1,
        offered_count: 1, omitted_count: 0,
        uncovered_hostile_front_contacts: 3,
        uncovered_potential_incoming_front_contacts: 2 },
      omissions: Object.fromEntries([
        'not_examined', 'geometry_shortlist_limit', 'worker_unchecked',
        'shortlist_limit', 'pending_intent', 'occupied_post', 'not_buildable',
        'relocated', 'upgrade_not_build', 'unaffordable',
        'unaffordable_after_check', 'invalid_worker_result', 'invalid_gold',
      ].map((key) => [key, 0])),
    },
  };
}
function fakeAnswer(request, { branch = 'defense_post_build', post = 'build_defense_post_1' } = {}) {
  return { model: 'jev-test', usage: {},
    answers: Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      const choice = name === 'branch' ? branch :
        name === 'post_site' ? post : 'wait';
      return [name, { type: 'choice', choice, confidence: 0.8,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) =>
          [key, key === choice ? 1 : 0])) }];
    })),
  };
}
async function serve(t, options = {}) {
  const server = createAgentServer({ apiKey: 'fake-key',
    minimumIntervalMs: 40, enableHybridDecisions: true, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function post(url, path, body, token) {
  const response = await fetch(url + path, { method: 'POST',
    headers: { Origin: 'http://localhost:9000', 'Content-Type': 'application/json',
      ...(token ? { 'X-Agent-Session': token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function start(url) {
  const response = await post(url, '/session', { mode: 'hybrid', limit: 3 });
  assert.equal(response.status, 200);
  return response.body.token;
}

test('default-off DP proposal returns 403 before inference; missing/null preserve legacy hybrid', async (t) => {
  const calls = [];
  const url = await serve(t, { fetchImpl: async (_endpoint, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    return new Response(JSON.stringify(fakeAnswer(request, { branch: 'wait' })));
  } });
  assert.equal((await (await fetch(url + '/health')).json()).defensePostEnabled, false);
  for (const path of ['/defense-observation.js', '/defense-post-adapter.js']) {
    const module = await fetch(url + path);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
  }
  const token = await start(url);
  assert.equal((await post(url, '/hybrid-decision', defenseInput(), token)).status, 403);
  assert.equal(calls.length, 0);
  const nil = defenseInput();
  nil.defense_post = null;
  assert.equal((await post(url, '/hybrid-decision', nil, token)).status, 200);
  assert.equal(calls[0].questions.post_site, undefined);
  const missing = defenseInput();
  delete missing.defense_post;
  assert.equal((await post(url, '/hybrid-decision', missing, token)).status, 200);
  assert.equal(calls[1].questions.post_site, undefined);
  assert.equal(calls[1].state.defense_posts.status, 'not_currently_scanned');
});

test('DP flag alone is insufficient without hybrid flag and explicit hybrid Start', async (t) => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('No inference'); };
  const noHybrid = await serve(t, { enableDefensePostDecisions: true,
    enableHybridDecisions: false, fetchImpl });
  assert.equal((await (await fetch(noHybrid + '/health')).json()).defensePostEnabled, false);
  assert.equal((await post(noHybrid, '/hybrid-decision', defenseInput())).status, 403);
  const on = await serve(t, { enableDefensePostDecisions: true, fetchImpl });
  assert.equal((await (await fetch(on + '/health')).json()).defensePostEnabled, true);
  assert.equal((await post(on, '/hybrid-decision', defenseInput())).status, 403);
  const legacy = await serve(t, { enableDefensePostDecisions: true,
    requireStartSession: false, fetchImpl });
  assert.equal((await (await fetch(legacy + '/health')).json()).defensePostEnabled, false);
  assert.equal((await post(legacy, '/hybrid-decision', defenseInput())).status, 403);
  assert.equal(calls, 0);
});

test('flagged DP is strict, optional alongside City/boat, and Jev controls build or save', async (t) => {
  const calls = [], logs = [];
  let postChoice = 'build_defense_post_1';
  const url = await serve(t, { enableDefensePostDecisions: true,
    fetchImpl: async (_endpoint, init) => {
      const request = JSON.parse(init.body);
      calls.push({ request, at: performance.now() });
      return new Response(JSON.stringify(fakeAnswer(request, { post: postChoice })));
    }, log: async (row) => logs.push(row),
  });
  const token = await start(url);
  for (const mutate of [
    (x) => { x.plan = { objective: 'forge' }; },
    (x) => { x.defense_post.candidates[0].tile = 72; },
    (x) => { x.defense_post.candidates[0].cost_gold = '90001'; },
    (x) => { x.defense_post.coverage.omitted_count = 1; },
    (x) => { x.defense_post.incoming.contact_is_only_potential = false; },
  ]) {
    const invalid = defenseInput();
    mutate(invalid);
    assert.equal((await post(url, '/hybrid-decision', invalid, token)).status, 400);
  }
  assert.equal(calls.length, 0);
  const built = await post(url, '/hybrid-decision', defenseInput(), token);
  assert.equal(built.status, 200);
  assert.equal(built.body.branch, 'defense_post_build');
  assert.equal(built.body.kind, 'defense_post');
  assert.equal(built.body.candidate_id, defenseInput().defense_post.candidates[0].id);
  assert.equal(built.body.selected, 'build_defense_post_1');
  assert.equal(built.body.context.defense_post_snapshot_id,
    defenseInput().defense_post.snapshot_id);
  assert.deepEqual(Object.keys(calls[0].request.questions),
    ['branch', 'land_action', 'post_site']);
  assert.equal(logs[0].policy, HYBRID_POLICY_VERSION);
  assert.ok(!JSON.stringify(calls[0]).includes('"tile":'));
  assert.ok(!JSON.stringify(logs).includes(token));
  postChoice = 'save_gold';
  const saved = await post(url, '/hybrid-decision', defenseInput(), token);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.kind, 'wait');
  assert.equal(saved.body.selected, 'save_gold');
  assert.ok(calls[1].at - calls[0].at >= 38);
  assert.equal((await (await fetch(url + '/health')).json()).hybridPolicy,
    HYBRID_POLICY_VERSION);
});
