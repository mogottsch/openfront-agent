import test from "node:test";
import assert from "node:assert/strict";
import { observation } from "./fixtures/land.mjs";
import { buildNavalDecomposedRequest, parseNavalDecomposedDecision } from "../src/naval-decomposed-policy.mjs";
import { oneGatedDecomposedDecision } from "../scripts/verify-naval-live-client.mjs";
import { validateHybridInput } from "../web/hybrid-observation.js";
import { POLICY_VERSION } from "../src/policy.mjs";
import { HYBRID_POLICY_VERSION } from "../src/hybrid-policy.mjs";
import { createAgentServer } from "../src/server.mjs";

function realShape() {
  const land = observation(18891, 48813, "nation");
  land.self.territory_tiles = 6505;
  land.border = { total_edges: 992, wilderness_edges: 0, player_edges: 0,
    water_edges: 992, blocked_edges: 0 };
  land.neighbors = [];
  land.incoming_attacks = [];
  land.outgoing_attacks = [];
  const snapshot_id = "offline/onion@649#2";
  const naval = {
    snapshot_id, source_tick: 649, current_tick: 649, map_id: "offline/onion",
    available_troops_internal: 188910, boats: { cap: 3, active_count: 0, active_transports: [] },
    candidates: [{
      id: `${snapshot_id}:boat1`, kind: "boat",
      source_region_id: `${snapshot_id}:r1`, target_region_id: `${snapshot_id}:nr1`,
      target_owner_id: 0, target_type: "wilderness", target_region_tiles: 7203,
      water_component_id: `${snapshot_id}:w1`, water_ocean_status: "ocean",
      source_shore_tiles: 634, target_shore_tiles: 599,
      water_span_estimate_tiles: 33,
      water_span_method: "shore_manhattan_separation_not_water_path",
      status: "worker_checked_not_executed", geometry_status: "geometric_only_not_engine_legal",
      cost_gold: "0", worker_source_confirmed: true,
    }],
    coverage: { total_eligible: 1, worker_checked: 1, offered_count: 1,
      omitted_count: 0, coast: { source_water_components: 1,
        eligible_target_owner_regions: 1, coast_budget_truncated_owner_regions: 0,
        eligible_region_component_coasts: 1, sampled_region_component_coasts: 1,
        eligible_coast_contacts: 123, sample_budget: 512,
        shore_source: "isShore_and_water_adjacency" },
      certainty: "Full-resolution cardinal water contact only; engine transport legality, naval path and combat safety unverified" },
    omissions: { coast_budget_unexamined: 0, pair_budget_unexamined: 0,
      geometry_shortlist_limit: 0, worker_unchecked: 0, shortlist_limit: 0,
      pending_intent: 0, cap_blocked: 0, invalid_target: 0, not_buildable: 0,
      invalid_worker_result: 0, invalid_source: 0, invalid_gold: 0,
      unaffordable: 0 },
  };
  return { game_id: "offline", snapshot_tick: 649, land, naval,
    building: null, plan: null, city_mechanics: {
      troop_capacity_gain_display: 25000, construction_ticks: 20 } };
}

const token = "T".repeat(32);
function decision(input, { boat = true, mutate } = {}) {
  const request = buildNavalDecomposedRequest(input);
  const answers = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => {
    const selected = boat && name === "branch" ? "boat_attack" :
      boat && name === "boat_target" ? "boat_target_1" :
        boat && name === "boat_size_1" ? "send_10" : "wait";
    return [name, { type: "choice", choice: selected, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) =>
        [key, Number(key === selected)])) }];
  }));
  const payload = { ...parseNavalDecomposedDecision({ answers, model: "jev-fake", usage: {} }, request),
    latencyMs: 2 };
  mutate?.(payload);
  return payload;
}
function fakeTransport(input, { boat = true, mutate, decisionStatus = 200,
  healthOverride = {}, startOverride = {}, stopStatus = 200 } = {}) {
  const calls = [];
  const client = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, headers: init.headers, body: init.body });
    if (path === "/health") return { ok: true, json: async () => ({
      keyConfigured: true, requiresStart: true, sessionActive: false,
      hybridEnabled: true, navalEnabled: true, decomposedNavalLiveEnabled: true,
      plannerEnabled: false, policy: POLICY_VERSION,
      hybridPolicy: HYBRID_POLICY_VERSION,
      ...healthOverride,
    }) };
    if (path === "/session" && init.method === "POST") return {
      ok: true, json: async () => ({ token, mode: "hybrid", limit: 1,
        plan_limit: 0, ...startOverride }),
    };
    if (path === "/session" && init.method === "DELETE") return {
      ok: stopStatus === 200, status: stopStatus,
    };
    if (path === "/hybrid-decision-decomposed") return {
      ok: decisionStatus === 200, status: decisionStatus,
      json: async () => decision(input, { boat, mutate }),
    };
    throw new Error("Unexpected route");
  };
  return { client, calls };
}

const routes = (calls) => calls.map((x) => `${x.method} ${x.path}`);
const goodRoutes = ["GET /health", "POST /session", "POST /hybrid-decision-decomposed", "DELETE /session"];

test("explicit local hybrid Start sends exactly one authenticated decomposed request, then revokes; token never returned", async () => {
  const input = realShape();
  const { client, calls } = fakeTransport(input);
  const result = await oneGatedDecomposedDecision(input, { fetchImpl: client });
  assert.deepEqual(routes(calls), goodRoutes);
  assert.deepEqual(JSON.parse(calls[1].body), { mode: "hybrid", limit: 1 });
  assert.deepEqual(JSON.parse(calls[2].body), validateHybridInput(input));
  assert.equal(calls[2].headers["X-Agent-Session"], token);
  assert.equal(calls[3].headers["X-Agent-Session"], token);
  assert.equal(result.requestCount, 1);
  assert.equal(result.sessionRevoked, true);
  assert.equal(result.decision.kind, "boat");
  assert.equal(result.decision.candidate_id, input.naval.candidates[0].id);
  assert.equal(result.decision.fraction, 0.1);
  assert.equal(JSON.stringify(result).includes(token), false);
  const wait = fakeTransport(input, { boat: false });
  const w = await oneGatedDecomposedDecision(input, { fetchImpl: wait.client });
  assert.equal(w.decision.kind, "wait");
  assert.deepEqual(routes(wait.calls), goodRoutes);
});

test("real loopback server enforces one Start and one model response through decomposed route", async () => {
  const input = realShape();
  let calls = 0;
  const server = createAgentServer({
    apiKey: "fake-key-never-real",
    enableHybridDecisions: true,
    enableNavalDecisions: true,
    enableNavalDecomposedLive: true,
    fetchImpl: async () => {
      calls++;
      const mock = decision(input);
      return { ok: true, json: async () => ({ model: mock.model, usage: mock.usage,
        answers: Object.fromEntries(Object.entries(mock.decisions).map(([name, d]) =>
          [name, { type: "choice", choice: d.action,
            confidence: d.confidence, probabilities: d.probabilities }])) }) };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await oneGatedDecomposedDecision(input, { baseUrl });
    assert.equal(result.decision.kind, "boat");
    assert.equal(result.decision.candidate_id, input.naval.candidates[0].id);
    assert.equal(result.sessionRevoked, true);
    assert.equal(calls, 1); // fake upstream; no real TypeSafe requests
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.sessionActive, false);
  } finally {
    await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test("disabled/busy/policy-mismatched sidecar never activates session or spends a call", async () => {
  for (const healthOverride of [{ sessionActive: true }, { keyConfigured: false },
    { decomposedNavalLiveEnabled: false }, { plannerEnabled: true },
    { requiresStart: false }, { policy: "old-policy" }]) {
    const input = realShape();
    const { client, calls } = fakeTransport(input, { healthOverride });
    await assert.rejects(oneGatedDecomposedDecision(input, { fetchImpl: client }),
      /not idle or not opted/);
    assert.deepEqual(routes(calls), ["GET /health"]);
  }
});

test("HTTP 529/502, stale or made-up model selections fail closed and always Stop", async () => {
  for (const options of [
    { decisionStatus: 502 },
    { mutate: (d) => { d.context.snapshot_tick++; } },
    { mutate: (d) => { d.candidate_id = "invented"; } },
    { mutate: (d) => { d.fraction = 0.7; } },
    { mutate: (d) => { d.decisions.boat_size_1.probabilities.send_10 = -1; } },
  ]) {
    const input = realShape();
    const { client, calls } = fakeTransport(input, options);
    await assert.rejects(oneGatedDecomposedDecision(input, { fetchImpl: client }));
    assert.deepEqual(routes(calls), goodRoutes);
  }
});

test("bad Start cap still revokes when token is known; failed Stop prevents an actionable result", async () => {
  const input = realShape();
  const wrong = fakeTransport(input, { startOverride: { limit: 2 } });
  await assert.rejects(oneGatedDecomposedDecision(input, { fetchImpl: wrong.client }),
    /Invalid hybrid Start contract/);
  assert.deepEqual(routes(wrong.calls), ["GET /health", "POST /session", "DELETE /session"]);
  const failed = fakeTransport(input, { stopStatus: 503 });
  await assert.rejects(oneGatedDecomposedDecision(input, { fetchImpl: failed.client }),
    /revocation failed/);
  assert.deepEqual(routes(failed.calls), goodRoutes);
});
