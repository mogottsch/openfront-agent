import assert from "node:assert/strict";
import test from "node:test";
import { buildRequest, parseDecision, POLICY_VERSION } from "../src/policy.mjs";

// Raw-schema projections of exact rows 41, 73 and 78 from the ignored local
// 2026-09-27 180-call match log. Values relevant to this policy (own reserve,
// borders, all neighbors, their incoming records and our outgoing records) are
// frozen here so dependency-free tests also work from a fresh public checkout.
// The selected actions are HISTORICAL v4.2 Jev outcomes, not expected v4.3
// model predictions. See local logs/decisions-2026-09-27T08-14-19.216Z.jsonl.
const attack = (
  id,
  attacker_id,
  attacker_type,
  attacker_reserve_troops,
  troops,
  retreating = false,
) => ({
  id,
  attacker_id,
  attacker_type,
  attacker_reserve_troops,
  troops,
  retreating,
});
const n = (
  id,
  type,
  shared_border_edges,
  troops,
  troop_capacity,
  territory_tiles,
  incoming_attacks = [],
) => ({
  id,
  type,
  relationship: "unallied",
  shared_border_edges,
  troops,
  troop_capacity,
  territory_tiles,
  can_attack: true,
  incoming_attacks,
});
const out = (id, target_id, troops, retreating = false) => ({
  id,
  target_id,
  troops,
  retreating,
});
const frozen = {
  firstSpread: {
    timestamp: "2026-09-27T08:35:10.487Z",
    oldChoice: "attack_player_222_10",
    self: [19152, 41374, 4563],
    border: [766, 0, 588, 178, 0],
    neighbors: [
      n(76, "tribe", 125, 1726, 10435, 2394),
      n(102, "tribe", 32, 2509, 12409, 3603),
      n(222, "tribe", 12, 3112, 11528, 3039),
      n(226, "tribe", 205, 2972, 11264, 2878),
      n(246, "tribe", 18, 1270, 10699, 2544, [
        attack("e1uvw9an", 1, "human", 19152, 1985),
      ]),
      n(275, "tribe", 75, 2073, 11378, 2947),
      n(374, "tribe", 56, 2349, 11494, 3018),
      n(411, "tribe", 65, 4302, 9161, 1722),
    ],
    outgoing_attacks: [out("e1uvw9an", 246, 1985)],
  },
  firstNation: {
    timestamp: "2026-09-27T08:35:43.137Z",
    oldChoice: "attack_player_37_10",
    self: [32501, 59306, 9693],
    border: [1018, 0, 746, 272, 0],
    neighbors: [
      n(37, "nation", 30, 37806, 77590, 10616),
      n(38, "nation", 11, 38232, 96539, 16252, [
        attack("vaqap4sw", 246, "tribe", 3225, 1222),
      ]),
      n(59, "tribe", 60, 4564, 10898, 2660, [
        attack("7espow64", 1, "human", 32501, 43),
        attack("m9ugmeiq", 411, "tribe", 3492, 584),
      ]),
      n(102, "tribe", 49, 5661, 11602, 3085, [
        attack("gq4aemcd", 1, "human", 32501, 2113),
      ]),
      n(222, "tribe", 30, 5589, 11368, 2941),
      n(226, "tribe", 217, 4725, 10219, 2274),
      n(246, "tribe", 74, 3225, 9995, 2152),
      n(275, "tribe", 95, 4995, 13142, 4101),
      n(374, "tribe", 85, 5189, 11541, 3047),
      n(411, "tribe", 95, 3492, 7969, 1176),
    ],
    outgoing_attacks: [out("7espow64", 59, 43), out("gq4aemcd", 102, 2113)],
  },
  secondNation: {
    timestamp: "2026-09-27T08:35:48.620Z",
    oldChoice: "attack_player_38_10",
    self: [35064, 59866, 9877],
    border: [1046, 0, 774, 272, 0],
    neighbors: [
      n(37, "nation", 38, 45319, 84733, 12628, [
        attack("q8mgeuuj", 1, "human", 35064, 2248),
        attack("rig79gz8", 71, "tribe", 6697, 1430),
      ]),
      n(38, "nation", 11, 47335, 100955, 17700, [
        attack("vaqap4sw", 246, "tribe", 4075, 160),
      ]),
      n(59, "tribe", 62, 4917, 10403, 2376, [
        attack("zcye9r7j", 201, "tribe", 5130, 2747),
      ]),
      n(102, "tribe", 54, 4689, 11486, 3013),
      n(222, "tribe", 31, 6491, 11484, 3012),
      n(226, "tribe", 217, 5569, 10219, 2274),
      n(246, "tribe", 77, 4075, 10210, 2269),
      n(275, "tribe", 95, 6043, 13415, 4293),
      n(374, "tribe", 87, 6118, 11541, 3047),
      n(411, "tribe", 102, 4214, 8126, 1243),
    ],
    outgoing_attacks: [out("q8mgeuuj", 37, 2248)],
  },
};
function observationAt(row) {
  const [troops, troop_capacity, territory_tiles] = row.self;
  const [
    total_edges,
    wilderness_edges,
    player_edges,
    water_edges,
    blocked_edges,
  ] = row.border;
  return {
    self: { id: 1, troops, troop_capacity, territory_tiles },
    border: {
      total_edges,
      wilderness_edges,
      player_edges,
      water_edges,
      blocked_edges,
    },
    neighbors: row.neighbors,
    incoming_attacks: [],
    outgoing_attacks: row.outgoing_attacks,
  };
}
const response = (choice, criteria) => ({
  model: "mock-only",
  usage: {},
  answers: {
    action: {
      type: "choice",
      choice,
      confidence: 0.9,
      probabilities: Object.fromEntries(
        Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
      ),
    },
  },
});

test("frozen 08:35:10: already attacked tribe246 before Jev opened tribe222", () => {
  const row = frozen.firstSpread;
  const request = buildRequest(observationAt(row));
  const q = request.questions.action;
  assert.equal(POLICY_VERSION, "land-strategy-v4.5-tribe-progress");
  assert.equal(row.oldChoice, "attack_player_222_10");
  assert.equal(
    request.state.neighbors.find((p) => p.id === 246).our_active_attack_troops,
    1985,
  );
  assert.match(
    q.instructions.join(" "),
    /finish that target before starting another tribe, wilderness or player attack/i,
  );
  assert.match(
    q.instructions.join(" "),
    /engine-legal targets strategically withheld/i,
  );
  assert.equal(request.state.strategy.mode, "finish_current_tribe_attacks");
  assert.deepEqual(request.state.strategy.active_tribe_target_ids, [246]);
  assert.match(q.criteria.wait.tribe_focus_context, /246/);
  assert.match(
    q.criteria.attack_player_246_10.tribe_focus_context,
    /already attacking this tribe/i,
  );
  assert.equal(q.criteria[row.oldChoice], undefined);
  assert.deepEqual(
    request.state.strategy.blocked_targets.find((b) => b.target_id === 222),
    {
      target_id: 222,
      target_type: "tribe",
      reason: "finish_current_tribe_attacks_before_new_target",
    },
  );
  // The reviewed pre-inference gate discloses suppressed targets; the model
  // still selects among offered choices and no late heuristic replaces it.
  assert.throws(() =>
    parseDecision(response(row.oldChoice, q.criteria), q.criteria),
  );
  assert.equal(
    parseDecision(response("attack_player_246_10", q.criteria), q.criteria)
      .action,
    "attack_player_246_10",
  );
  assert.equal(
    parseDecision(response("wait", q.criteria), q.criteria).action,
    "wait",
  );
});

test("frozen 08:35:43/48: nation attacks are disclosed but not offered with tribes still bordering", () => {
  for (const [row, nationId, targetTiles, mode, reason] of [
    [
      frozen.firstNation,
      37,
      10616,
      "finish_current_tribe_attacks",
      "finish_current_tribe_attacks_before_new_target",
    ],
    [
      frozen.secondNation,
      38,
      17700,
      "bordering_tribes_before_nations",
      "conquer_bordering_tribes_before_nations",
    ],
  ]) {
    const request = buildRequest(observationAt(row));
    const q = request.questions.action;
    assert.equal(
      request.state.neighbors.filter((n) => n.type === "tribe" && n.can_attack)
        .length,
      8,
    );
    assert.equal(
      request.state.neighbors.find((n) => n.id === nationId).territory_tiles,
      targetTiles,
    );
    assert.equal(request.state.strategy.mode, mode);
    assert.equal(
      request.state.strategy.blocked_targets.find(
        (b) => b.target_id === nationId,
      )?.reason,
      reason,
    );
    assert.equal(q.criteria[row.oldChoice], undefined);
    assert.match(
      q.instructions.join(" "),
      /current(ly)? available troops or committed-to-defender ratio do NOT measure total territorial resistance/i,
    );
    assert.throws(() =>
      parseDecision(response(row.oldChoice, q.criteria), q.criteria),
    );
    assert.equal(
      parseDecision(response("wait", q.criteria), q.criteria).action,
      "wait",
    );
  }
  const first = buildRequest(observationAt(frozen.firstNation));
  assert.deepEqual(first.state.strategy.active_tribe_target_ids, [59, 102]);
  assert.deepEqual(
    Object.keys(first.questions.action.criteria)
      .filter((key) => key.startsWith("attack_player_"))
      .sort(),
    [
      "attack_player_102_10",
      "attack_player_102_20",
      "attack_player_59_10",
      "attack_player_59_20",
    ].sort(),
  );
  const second = buildRequest(observationAt(frozen.secondNation));
  assert.equal(
    second.state.neighbors.find((n) => n.id === 37).our_active_attack_troops,
    2248,
  );
  assert.equal(second.state.strategy.active_tribe_target_ids.length, 0);
  assert.ok(second.questions.action.criteria.attack_player_246_10);
  assert.equal(second.questions.action.criteria.attack_player_37_10, undefined);
});

test("retreating/zero-force attack is not falsely marked as a current focus", () => {
  const row = structuredClone(frozen.firstSpread);
  row.outgoing_attacks[0].retreating = true;
  row.neighbors.find((n) => n.id === 246).incoming_attacks[0].retreating = true;
  const request = buildRequest(observationAt(row));
  assert.equal(
    request.state.neighbors.find((n) => n.id === 246).our_active_attack_troops,
    0,
  );
  assert.equal(
    request.questions.action.criteria.wait.tribe_focus_context,
    undefined,
  );
  assert.match(
    request.questions.action.criteria.attack_player_246_10.tribe_focus_context,
    /No currently observed active attack/,
  );
  // This snapshot alone cannot prove conquest; an authoritative focus can
  // persist across a temporarily absent active attack and still gate targets.
  const focused = observationAt(row);
  focused.tribe_focus = {
    id: 246,
    alive: true,
    type: "tribe",
    troops: 1270,
    territory_tiles: 2544,
    adjacent: true,
    can_attack: true,
  };
  const persistent = buildRequest(focused);
  assert.equal(persistent.state.strategy.mode, "finish_focused_tribe");
  assert.deepEqual(persistent.state.strategy.active_tribe_target_ids, []);
  assert.equal(
    persistent.questions.action.criteria.attack_player_222_10,
    undefined,
  );
  assert.ok(persistent.questions.action.criteria.attack_player_246_10);
  assert.match(
    persistent.questions.action.criteria.attack_player_246_10
      .tribe_focus_context,
    /persistent, still-alive focus/,
  );
});

// Observed Easy first50 row50 facts: target50 remained alive at 3,145 tiles,
// own reserve 19,927/46,137, defender reserve 2,348, no active outgoing stack.
// First-send target tiles were 1,925. The panel reported six emitted 10%
// intents. IMPORTANT: row50 is captured BEFORE the sixth send; its input history
// therefore has five prior emissions. Tick/elapsed below are SYNTHETIC test-only
// because that browser capture did not record authoritative GameView ticks.
function stalledEasyFocus() {
  return {
    self: { id: 1, troops: 19927, troop_capacity: 46137,
      territory_tiles: 5775, gold: "47300" },
    border: { total_edges: 396, wilderness_edges: 246,
      player_edges: 100, water_edges: 50, blocked_edges: 0 },
    neighbors: [{ id: 50, type: "tribe", relationship: "unallied",
      shared_border_edges: 100, troops: 2348, troop_capacity: 11698,
      territory_tiles: 3145, can_attack: true, incoming_attacks: [] }],
    incoming_attacks: [], outgoing_attacks: [],
    tribe_focus: { id: 50, alive: true, type: "tribe", troops: 2348,
      territory_tiles: 3145, adjacent: true, can_attack: true,
      progress: { reference_kind: "first_emitted_land_intent",
        reference_tick: 100, reference_tiles: 1925, elapsed_ticks: 30,
        land_intents_emitted: 5, last_land_send_percent: 10 } },
  };
}

test("frozen Easy row50 progress supports considering 20% but preserves Jev's 10% and wait", () => {
  const request = buildRequest(stalledEasyFocus());
  const progress = request.state.tribe_focus.progress;
  assert.equal(progress.reference_tiles, 1925);
  assert.equal(progress.territory_delta_since_reference, 1220);
  assert.equal(progress.land_intents_emitted, 5);
  assert.equal(request.state.tribe_focus.our_active_attack_troops, 0);
  const q = request.questions.action;
  assert.deepEqual(Object.keys(q.criteria), ["wait", "attack_player_50_10", "attack_player_50_20"]);
  assert.equal(q.criteria.attack_player_50_20.focus_progress_facts.current_target_tiles, 3145);
  assert.match(q.criteria.attack_player_50_20.focus_send_size_context, /not an automatic escalation/);
  assert.match(q.instructions.join(" "), /compare a legal 20% option with 10% and wait/);
  assert.match(q.instructions.join(" "), /NOT change caused solely by our attacks/);
  for (const choice of ["wait", "attack_player_50_10", "attack_player_50_20"]) {
    const answer = response(choice, q.criteria);
    assert.equal(parseDecision(answer, q.criteria).action, choice);
    assert.deepEqual(parseDecision(answer, q.criteria).probabilities, answer.answers.action.probabilities);
  }
  assert.throws(() => parseDecision(response("attack_player_50_30", q.criteria), q.criteria));
});

test("unknown recovered progress stays unknown; active push and signed reduction do not force escalation", () => {
  const o = stalledEasyFocus();
  o.tribe_focus.progress = { reference_kind: "first_authoritative_focus_observation",
    reference_tick: 100, reference_tiles: 3500, elapsed_ticks: 30,
    land_intents_emitted: null, last_land_send_percent: null };
  o.outgoing_attacks = [{ id: "active50", target_id: 50, troops: 5000, retreating: false }];
  const request = buildRequest(o);
  assert.equal(request.state.tribe_focus.progress.territory_delta_since_reference, -355);
  assert.equal(request.state.tribe_focus.progress.land_intents_emitted, null);
  assert.equal(request.questions.action.criteria.wait.focus_progress_facts.land_intents_emitted, null);
  assert.equal(request.state.tribe_focus.our_active_attack_troops, 5000);
  assert.equal(parseDecision(response("wait", request.questions.action.criteria), request.questions.action.criteria).action, "wait");
  delete o.tribe_focus.progress;
  assert.equal(buildRequest(o).questions.action.criteria.attack_player_50_20.focus_progress_facts, undefined);
});
