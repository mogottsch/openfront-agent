// One explicitly started, authenticated decomposed Jev decision. This module
// does not issue an intent; the paused engine caller owns final revalidation.
import { validateHybridInput } from "../web/hybrid-observation.js";
import { navalChoices } from "../web/naval-observation.js";
import { HYBRID_POLICY_VERSION } from "../src/hybrid-policy.mjs";
import { POLICY_VERSION } from "../src/policy.mjs";
import {
  buildNavalDecomposedRequest,
  parseNavalDecomposedDecision,
  NAVAL_DECOMPOSED_POLICY_VERSION,
} from "../src/naval-decomposed-policy.mjs";

const BASE = "http://127.0.0.1:8788";
const httpStatus = (response, phase) => {
  if (!response?.ok) throw new Error(`${phase} HTTP ${Number.isInteger(response?.status) ? response.status : "error"}`);
};
const json = async (response, phase) => {
  try { return await response.json(); }
  catch { throw new Error(`${phase} returned invalid JSON`); }
};
const safeFetch = async (fetchImpl, url, init, phase) => {
  try { return await fetchImpl(url, init); }
  catch { throw new Error(`${phase} failed or timed out`); }
};
const signal = (ms) => AbortSignal.timeout(ms);

export function validateDecomposedChoice(decision, input, request) {
  if (!decision || typeof decision !== "object" ||
      !decision.decisions || typeof decision.decisions !== "object" ||
      !Number.isFinite(decision.latencyMs) || decision.latencyMs < 0)
    throw new Error("Malformed decomposed decision");
  // Reparse the sidecar's normalized per-question answers against the exact
  // locally offered criteria. This catches invented options, missing speculative
  // answers, contradictory branch/target/size, and malformed probabilities.
  const answers = Object.fromEntries(Object.entries(decision.decisions).map(([name, d]) => [
    name, { type: "choice", choice: d?.action,
      confidence: d?.confidence, probabilities: d?.probabilities },
  ]));
  let parsed;
  try {
    parsed = parseNavalDecomposedDecision({
      answers, model: decision.model, usage: decision.usage,
    }, request);
  } catch { throw new Error("Malformed or unoffered decomposed decision"); }
  for (const key of ["branch", "selected", "kind", "candidate_id", "fraction"])
    if (decision[key] !== parsed[key]) throw new Error("Contradictory decomposed decision");
  const expected = { game_id: input.game_id, snapshot_tick: input.snapshot_tick,
    building_snapshot_id: null, naval_snapshot_id: input.naval.snapshot_id,
    plan_version: null };
  if (!decision.context ||
      Object.keys(expected).some((key) => decision.context[key] !== expected[key]))
    throw new Error("Stale game, naval snapshot, or plan in decision");
  if (decision.kind === "boat") {
    if (decision.branch !== "boat_attack") throw new Error("Boat branch mismatch");
    const choices = navalChoices(input.naval, input.land);
    const selected = choices[decision.selected];
    if (!selected || selected.kind !== "boat" ||
        selected.candidate_id !== decision.candidate_id ||
        selected.fraction !== decision.fraction)
      throw new Error("Boat target/size not offered by this snapshot");
  } else if (decision.kind !== "wait" &&
             decision.kind !== "land" && decision.kind !== "city") {
    throw new Error("Unknown decomposed action kind");
  }
  return decision;
}

export async function oneGatedDecomposedDecision(input, {
  fetchImpl = fetch, baseUrl = BASE, healthTimeoutMs = 2000,
  startTimeoutMs = 2000, decisionTimeoutMs = 6500,
  stopTimeoutMs = 2000,
} = {}) {
  const clean = validateHybridInput(input);
  if (!clean.naval?.candidates.length || clean.building !== null || clean.plan !== null)
    throw new Error("Paused naval test needs candidates, building:null, plan:null");
  const request = buildNavalDecomposedRequest(clean);
  const body = JSON.stringify(clean);
  if (Buffer.byteLength(body) > 65536)
    throw new Error("Hybrid request exceeds sidecar body limit");
  const healthResponse = await safeFetch(fetchImpl, `${baseUrl}/health`,
    { method: "GET", signal: signal(healthTimeoutMs) }, "Local health");
  httpStatus(healthResponse, "Local health");
  const health = await json(healthResponse, "Local health");
  if (health?.keyConfigured !== true || health.requiresStart !== true ||
      health.sessionActive !== false || health.hybridEnabled !== true ||
      health.navalEnabled !== true || health.decomposedNavalLiveEnabled !== true ||
      health.plannerEnabled !== false ||
      health.policy !== POLICY_VERSION || health.hybridPolicy !== HYBRID_POLICY_VERSION)
    throw new Error("Local sidecar not idle or not opted into decomposed naval without Copilot");
  const startResponse = await safeFetch(fetchImpl, `${baseUrl}/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "hybrid", limit: 1 }),
    signal: signal(startTimeoutMs),
  }, "Local Start");
  httpStatus(startResponse, "Local Start");
  const start = await json(startResponse, "Local Start");
  if (typeof start?.token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(start.token))
    throw new Error("Invalid hybrid Start token; cannot authenticate Stop");
  // Token is strictly closure-local: not returned, logged or serialized.
  const token = start.token;
  let decision;
  let decisionError = null;
  let stopFailure = null;
  try {
    if (start.mode !== "hybrid" || start.limit !== 1 || start.plan_limit !== 0)
      throw new Error("Invalid hybrid Start contract");
    const response = await safeFetch(fetchImpl, `${baseUrl}/hybrid-decision-decomposed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Session": token },
      body,
      signal: signal(decisionTimeoutMs),
    }, "Local decomposed decision");
    httpStatus(response, "Local decomposed decision");
    decision = validateDecomposedChoice(
      await json(response, "Local decomposed decision"), clean, request,
    );
  } catch (error) {
    decisionError = error;
  } finally {
    // Always attempt Stop, including 529/timeout/parse failure. Never reveal
    // token or arbitrary fetch error bodies in the public diagnostic.
    try {
      const stopped = await safeFetch(fetchImpl, `${baseUrl}/session`, {
        method: "DELETE", headers: { "X-Agent-Session": token },
        signal: signal(stopTimeoutMs),
      }, "Local Stop");
      httpStatus(stopped, "Local Stop");
    } catch { stopFailure = "Local Start session revocation failed"; }
  }
  if (stopFailure) throw new Error(stopFailure +
    (decisionError ? "; decision also failed" : ""));
  if (decisionError) throw decisionError;
  return { decision, requestCount: 1, sessionRevoked: true,
    policy: NAVAL_DECOMPOSED_POLICY_VERSION };
}
