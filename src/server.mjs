import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildRequest,
  parseDecision,
  POLICY_VERSION,
  OBSERVATION_ERROR,
  validateObservation,
} from "./policy.mjs";
import {
  buildHybridRequest,
  parseHybridDecision,
  HYBRID_POLICY_VERSION,
} from "./hybrid-policy.mjs";
import { validateHybridInput } from "../web/hybrid-observation.js";
import { createCopilotPlanner, CopilotPhaseError,
  COPILOT_FAILURE_STAGES } from "./copilot-planner.mjs";
import { createPlanSession } from "./plan-session.mjs";

const COPILOT_PLAN_PROMPT_VERSION = "copilot-plan-v1";
const PLAN_REASONS = new Set(["invalid_input", "stale_heartbeat", "sdk_auth_unavailable",
  "sdk_runtime_or_schema", "timeout", "unknown"]);
const SERVER_PLAN_STAGES = new Set(["server_input", "server_heartbeat", "server_pacing",
  "plan_session", "response_liveness", "server_log", "unexpected"]);
const SDK_EVENT_TYPES = new Set(["authentication", "authorization", "quota",
  "rate_limit", "context_limit", "query"]);
const SDK_EVENT_CODES = new Set(["quota_exceeded", "session_quota_exceeded",
  "billing_not_configured", "user_weekly_rate_limited", "user_global_rate_limited",
  "rate_limited", "user_model_rate_limited", "integration_rate_limited"]);
const SDK_EVENT_STATUSES = new Set([400, 401, 402, 403, 404, 408, 409,
  413, 422, 429, 500, 502, 503, 504]);
function safePlanStage(error, serverStage) {
  if (error instanceof CopilotPhaseError &&
      COPILOT_FAILURE_STAGES.includes(error.failure_stage)) return error.failure_stage;
  return SERVER_PLAN_STAGES.has(serverStage) ? serverStage : "unexpected";
}
function classifyPlanFailure(error, stage, sdkTurnAttempted) {
  if (error instanceof CopilotPhaseError) {
    if (["authentication", "authorization"].includes(error.sdk_error_type) ||
        error.sdk_status === 401 || error.sdk_status === 403)
      return "sdk_auth_unavailable";
    if (["preflight", "postflight_freshness"].includes(error.failure_stage))
      return "stale_heartbeat";
    if (["parse_json", "validate_plan", "build_prompt", "create_client",
      "start_client", "create_session", "cleanup"].includes(error.failure_stage) &&
        error.status !== 401 && error.status !== 403 &&
        error.diagnostic_kind !== "timeout" && error.diagnostic_kind !== "auth" &&
        !["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(error.code))
      return "sdk_runtime_or_schema";
  }
  // Inspect only for classification. Never log, return or interpolate raw SDK
  // messages: providers may include credentials or request contents in them.
  const message = typeof error?.message === "string" ? error.message : "";
  if (/^Stale plan |^Plan snapshot is not the active fresh heartbeat|^Plan request cancelled or stale/.test(message))
    return "stale_heartbeat";
  if (!sdkTurnAttempted) return stage === "input" ? "invalid_input" : "stale_heartbeat";
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 401 || status === 403 || error?.diagnostic_kind === "auth" ||
      /\b(unauthorized|not authenticated|authentication required|login required|please (log|sign) in|http (401|403))\b/i.test(message))
    return "sdk_auth_unavailable";
  if (error?.name === "TimeoutError" || error?.diagnostic_kind === "timeout" ||
      ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(error?.code) ||
      /\b(timeout|timed out)\b/i.test(message)) return "timeout";
  if (["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error?.code) ||
      /\b(runtime|responseSchema|schema|unsupported|module)\b/i.test(message))
    return "sdk_runtime_or_schema";
  return "unknown";
}
async function readBoundedJson(req, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new RangeError("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

const publicFiles = new Map([
  ["/agent.js", new URL("../web/agent.js", import.meta.url)],
  ["/controller.js", new URL("../web/controller.js", import.meta.url)],
  ["/observation.js", new URL("../web/observation.js", import.meta.url)],
  ["/game-adapter.js", new URL("../web/game-adapter.js", import.meta.url)],
  [
    "/hybrid-observation.js",
    new URL("../web/hybrid-observation.js", import.meta.url),
  ],
  ["/spatial-map.js", new URL("../web/spatial-map.js", import.meta.url)],
  [
    "/building-adapter.js",
    new URL("../web/building-adapter.js", import.meta.url),
  ],
  [
    "/hybrid-controller.js",
    new URL("../web/hybrid-controller.js", import.meta.url),
  ],
  ["/plan-client.js", new URL("../web/plan-client.js", import.meta.url)],
  ["/naval-spatial.js", new URL("../web/naval-spatial.js", import.meta.url)],
  ["/naval-adapter.js", new URL("../web/naval-adapter.js", import.meta.url)],
  ["/naval-observation.js", new URL("../web/naval-observation.js", import.meta.url)],
]);

export function createAgentServer({
  apiKey,
  model = "jev-latest",
  fetchImpl = fetch,
  log = async () => {},
  allowedOrigins = [
    "http://localhost:9000",
    "http://127.0.0.1:9000",
    "http://[::1]:9000",
  ],
  minimumIntervalMs = 1000,
  enableHybridDecisions = false,
  enableNavalDecisions = false,
  requireStartSession = true,
  enableCopilotPlanner = false,
  planner = null, // injectable for network-free tests; never browser-supplied
  planNow = Date.now,
  maxPlanRequestsPerSession = 3,
} = {}) {
  if (typeof planNow !== "function" || !Number.isSafeInteger(maxPlanRequestsPerSession) ||
      maxPlanRequestsPerSession < 1 || maxPlanRequestsPerSession > 10 ||
      (planner !== null && typeof planner !== "function")) {
    throw new Error("Invalid planner configuration");
  }
  const planModel = enableCopilotPlanner
    ? (planner ?? createCopilotPlanner({ model: "gpt-5-mini",
        maxSnapshotAgeMs: 20_000, maxTickLag: 200, timeoutMs: 15_000 }))
    : null;
  let busy = false;
  let lastCall = -Infinity;
  let session = null;
  let activeRequestAbort = null;
  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    // Loopback binding alone does not protect a local service from hostile web pages.
    const host = (req.headers.host ?? "").split(":")[0];
    if (!["localhost", "127.0.0.1"].includes(host))
      return send(403, { error: "Untrusted host" });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin))
      return send(403, { error: "Untrusted origin" });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Agent-Session",
      );
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method === "GET" && pathname === "/health") {
      return send(200, {
        status: "ok",
        keyConfigured: Boolean(apiKey),
        model,
        policy: POLICY_VERSION,
        hybridPolicy: HYBRID_POLICY_VERSION,
        hybridEnabled: enableHybridDecisions,
        navalEnabled: enableHybridDecisions && enableNavalDecisions && requireStartSession,
        plannerEnabled: enableHybridDecisions && enableCopilotPlanner && requireStartSession,
        planCallLimit: maxPlanRequestsPerSession,
        planCallsUsed: session?.planCount ?? 0,
        requiresStart: requireStartSession,
        sessionActive: Boolean(
          session && performance.now() < session.expiresAt,
        ),
      });
    }
    if (req.method === "GET" && publicFiles.has(pathname)) {
      try {
        const text = await readFile(publicFiles.get(pathname), "utf8");
        res.writeHead(200, {
          "Content-Type": "text/javascript",
          "Cache-Control": "no-store",
        });
        return res.end(text);
      } catch {
        return send(500, { error: "Could not load agent module" });
      }
    }
    if (pathname === "/session" && req.method === "POST") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
        return send(415, { error: "JSON required" });
      if (!apiKey) return send(503, { error: "TypeSafe key unavailable" });
      let value;
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 256)
            return send(413, { error: "Session request too large" });
          chunks.push(chunk);
        }
        value = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return send(400, { error: "Invalid Start request" });
      }
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "limit") ||
        !Object.hasOwn(value, "mode") ||
        !Number.isInteger(value.limit) ||
        value.limit < 1 ||
        value.limit > 300 ||
        !["land", "hybrid", "benchmark"].includes(value.mode) ||
        (value.mode === "hybrid" && !enableHybridDecisions)
      )
        return send(400, { error: "Invalid Start mode or request cap" });
      activeRequestAbort?.abort();
      session?.planSession?.stop();
      const nextSession = {
        token: randomBytes(24).toString("base64url"),
        id: randomBytes(16).toString("hex"), // not the bearer token; never sent to the model
        mode: value.mode,
        limit: value.limit,
        count: 0,
        planCount: 0,
        sdkTurnAttempted: false,
        gameId: null,
        planAdmission: null, // bounded heartbeats buffered only during shared pacing
        planSession: null,
        expiresAt: performance.now() + 15 * 60_000,
      };
      if (value.mode === "hybrid" && planModel && requireStartSession) {
        nextSession.planSession = createPlanSession({
          planner: (args) => {
            nextSession.sdkTurnAttempted = true;
            return planModel(args);
          },
          now: planNow, maxSnapshotAgeMs: 20_000,
          maxHeartbeatGapMs: 2_000, maxTickLag: 200,
        });
      }
      session = nextSession;
      return send(200, {
        token: session.token,
        mode: session.mode,
        limit: session.limit,
        plan_limit: session.planSession ? maxPlanRequestsPerSession : 0,
        expires_in_ms: 15 * 60_000,
      });
    }
    if (pathname === "/session" && req.method === "DELETE") {
      if (!session || req.headers["x-agent-session"] !== session.token)
        return send(403, { error: "No active Start session" });
      activeRequestAbort?.abort();
      session.planSession?.stop();
      session = null;
      return send(200, { stopped: true });
    }
    if (pathname === "/plan" || pathname === "/plan/heartbeat") {
      // A separate Start token and hybrid opt-in are required even if legacy
      // tests configure requireStartSession:false for the Jev decision route.
      const authorized = session;
      if (!requireStartSession || !enableHybridDecisions || !enableCopilotPlanner ||
          !authorized?.planSession || authorized.mode !== "hybrid" ||
          req.headers["x-agent-session"] !== authorized.token ||
          performance.now() >= authorized.expiresAt) {
        return send(403, { error: "Hybrid planner requires explicit Start and opt-in" });
      }
      const planDiagnostic = async (status, reason,
        attempted = authorized.sdkTurnAttempted, failureStage = "server_input", sdkError = null) => {
        const code = PLAN_REASONS.has(reason) ? reason : "unknown";
        const phase = SERVER_PLAN_STAGES.has(failureStage) ||
          COPILOT_FAILURE_STAGES.includes(failureStage) ? failureStage : "unexpected";
        const type = SDK_EVENT_TYPES.has(sdkError?.sdk_error_type) ? sdkError.sdk_error_type : null;
        const details = {
          ...(type ? { sdk_error_type: type } : {}),
          ...(type && SDK_EVENT_CODES.has(sdkError?.sdk_error_code) ?
            { sdk_error_code: sdkError.sdk_error_code } : {}),
          ...(SDK_EVENT_STATUSES.has(sdkError?.sdk_status) ?
            { sdk_status: sdkError.sdk_status } : {}),
        };
        const safe = { error: `Planner unavailable (${code})`, reason_code: code,
          failure_stage: phase, sdk_turn_attempted: Boolean(attempted),
          plan_count: authorized.planCount, ...details };
        try {
          await log({ timestamp: new Date().toISOString(),
            event: "copilot_plan_diagnostic", policy: COPILOT_PLAN_PROMPT_VERSION,
            provider: attempted ? "official-copilot-sdk" : "none",
            reason_code: code, failure_stage: phase, ...details,
            sdk_turn_attempted: Boolean(attempted), plan_count: authorized.planCount });
        } catch { /* log failure cannot reveal an upstream error or change the response */ }
        return send(status, safe);
      };
      if (req.method === "GET" && pathname === "/plan") {
        return send(200, { plan: authorized.gameId === null ? null :
          authorized.planSession.getPlan({ session_id: authorized.id,
            game_id: authorized.gameId }) });
      }
      if (req.method !== "POST") return send(404, { error: "Not found" });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
        return send(415, { error: "JSON required" });
      if (pathname === "/plan/heartbeat") {
        try {
          const value = await readBoundedJson(req, 4096);
          if (session !== authorized || !authorized.gameId ||
              value?.game_id !== authorized.gameId ||
              !value || typeof value !== "object" || Array.isArray(value) ||
              Object.keys(value).length !== 3 ||
              !Object.hasOwn(value, "tick") || !Object.hasOwn(value, "region_ids"))
            throw new Error("Wrong plan session or heartbeat shape");
          const heartbeat = { session_id: authorized.id, game_id: authorized.gameId,
            tick: value.tick, region_ids: value.region_ids, observed_at_ms: planNow() };
          // /plan may be waiting for the shared 1s Jev deadline. Applying a
          // newer heartbeat before plan(snapshot) admission would make its
          // exact tick/timestamp check fail without a model call. Keep at most
          // four validated beats and apply them immediately after admission.
          const admission = authorized.planAdmission;
          if (admission) {
            const last = admission.beats.at(-1) ?? admission.snapshot;
            if (!Number.isSafeInteger(heartbeat.tick) || heartbeat.tick < last.tick ||
                !Array.isArray(heartbeat.region_ids) || heartbeat.region_ids.length > 16 ||
                heartbeat.region_ids.some((id) => typeof id !== "string" ||
                  !/^[A-Za-z0-9:@#._/\-]{1,200}$/.test(id)) ||
                new Set(heartbeat.region_ids).size !== heartbeat.region_ids.length ||
                admission.beats.length >= 4) throw new Error("Invalid buffered heartbeat");
            admission.beats.push(heartbeat);
          } else {
            authorized.planSession.heartbeat(heartbeat);
          }
          return send(200, { plan: authorized.planSession.getPlan({
            session_id: authorized.id, game_id: authorized.gameId }) });
        } catch (error) {
          const reason = classifyPlanFailure(error, "input", false);
          return planDiagnostic(error instanceof RangeError ? 413 :
            reason === "stale_heartbeat" ? 409 : 400, reason, false,
            "server_heartbeat");
        }
      }
      if (busy) return send(429, { error: "A decision request is already pending" });
      if (authorized.planCount >= maxPlanRequestsPerSession)
        return send(403, { error: "Copilot plan request cap reached" });
      busy = true; // shares Jev's single-flight lock; heartbeats can still arrive
      authorized.sdkTurnAttempted = false;
      let stage = "input";
      try {
        const value = await readBoundedJson(req, 16_384);
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            Object.keys(value).length !== 4 ||
            !Object.hasOwn(value, "game_id") || !Object.hasOwn(value, "tick") ||
            !Object.hasOwn(value, "region_ids") || !Object.hasOwn(value, "summary") ||
            session !== authorized || performance.now() >= authorized.expiresAt ||
            (authorized.gameId !== null && authorized.gameId !== value.game_id)) {
          return await planDiagnostic(400, "invalid_input");
        }
        const snapshot = { ...value, session_id: authorized.id, observed_at_ms: planNow() };
        if (authorized.gameId === null) {
          authorized.planSession.start(snapshot); // no model call
          authorized.gameId = value.game_id;
        } else {
          stage = "heartbeat";
          authorized.planSession.heartbeat({
            session_id: authorized.id, game_id: value.game_id,
            tick: value.tick, region_ids: value.region_ids,
            observed_at_ms: snapshot.observed_at_ms,
          });
        }
        // Same application-level pacing as Jev. No retry or replacement plan.
        authorized.planAdmission = { snapshot, beats: [] };
        stage = "pacing";
        while (performance.now() < lastCall + minimumIntervalMs) {
          await delay(Math.ceil(lastCall + minimumIntervalMs - performance.now()));
        }
        if (session !== authorized || performance.now() >= authorized.expiresAt ||
            authorized.planCount >= maxPlanRequestsPerSession) {
          return await planDiagnostic(409, "stale_heartbeat", false, "server_pacing");
        }
        lastCall = performance.now();
        authorized.planCount++; // count attempts, including failures; max three per Start
        stage = "plan";
        const running = authorized.planSession.plan(snapshot);
        const buffered = authorized.planAdmission.beats;
        authorized.planAdmission = null;
        let plan;
        try {
          for (const beat of buffered) authorized.planSession.heartbeat(beat);
          plan = await running;
        } catch (error) {
          // A bad buffered beat must not release the shared busy lock while an
          // SDK request is still active (its transport ignores AbortSignal).
          await running.catch(() => {});
          throw error;
        }
        const stillCurrent = () => session === authorized &&
          performance.now() < authorized.expiresAt &&
          authorized.planSession.getPlan({ session_id: authorized.id,
            game_id: authorized.gameId })?.plan_version === plan.plan_version;
        if (!stillCurrent()) return await planDiagnostic(409, "stale_heartbeat",
          authorized.sdkTurnAttempted, "response_liveness");
        stage = "log";
        await log({ timestamp: new Date().toISOString(),
          policy: COPILOT_PLAN_PROMPT_VERSION, provider: "official-copilot-sdk",
          model: "gpt-5-mini", game_id: authorized.gameId,
          source_tick: plan.source_tick, plan_version: plan.plan_version });
        if (!stillCurrent()) return await planDiagnostic(409, "stale_heartbeat",
          authorized.sdkTurnAttempted, "response_liveness");
        return send(200, { plan });
      } catch (error) {
        // Never include raw provider messages, bodies, prompts or credentials.
        const failureStage = safePlanStage(error,
          stage === "input" ? "server_input" :
          stage === "heartbeat" ? "server_heartbeat" :
          stage === "pacing" ? "server_pacing" :
          stage === "log" ? "server_log" : "plan_session");
        const attempted = authorized.sdkTurnAttempted && failureStage !== "preflight";
        const reason = classifyPlanFailure(error, stage, attempted);
        const status = error instanceof RangeError ? 413 :
          reason === "invalid_input" ? 400 :
          reason === "stale_heartbeat" ? 409 :
          reason === "sdk_auth_unavailable" ? 503 :
          reason === "timeout" ? 504 : 502;
        return await planDiagnostic(status, reason, attempted, failureStage,
          error instanceof CopilotPhaseError ? error : null);
      } finally {
        authorized.planAdmission = null;
        busy = false;
      }
    }
    const hybrid = pathname === "/hybrid-decision";
    if (req.method !== "POST" || (!hybrid && pathname !== "/decision"))
      return send(404, { error: "Not found" });
    // Opt-in only. This is a feature gate, not a proof that the browser's Start
    // button was clicked; a separate activation session is required before
    // presenting this experiment as server-verified Start-gated.
    if (hybrid && !enableHybridDecisions)
      return send(403, { error: "Hybrid decision endpoint is disabled" });
    const authorized = requireStartSession ? session : null;
    if (
      requireStartSession &&
      (!authorized ||
        req.headers["x-agent-session"] !== authorized.token ||
        performance.now() >= authorized.expiresAt ||
        authorized.count >= authorized.limit ||
        (hybrid && authorized.mode !== "hybrid"))
    )
      return send(403, {
        error: "Explicit local Start required or session expired",
      });
    if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
      return send(415, { error: "JSON required" });
    if (!apiKey)
      return send(503, {
        error: "TYPESAFE_AI_API_KEY is not configured on the local server",
      });
    let request;
    let requestedPlan = null;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) return send(413, { error: "Request too large" });
        chunks.push(chunk);
      }
      const supplied = JSON.parse(Buffer.concat(chunks).toString());
      // Naval actions are a separately approved experiment. A present,
      // non-null raw proposal cannot reach TypeSafe without BOTH feature flags
      // and an explicit local hybrid Start, even in legacy test mode.
      if (hybrid && supplied && Object.hasOwn(supplied, "naval") &&
          supplied.naval !== null &&
          (!enableNavalDecisions || !enableHybridDecisions ||
            !requireStartSession || !authorized || authorized.mode !== "hybrid")) {
        return send(403, { error: "Naval decision endpoint is disabled" });
      }
      // A browser may never claim an authoritative Copilot plan. The future
      // planner will inject an independently validated server-owned plan here.
      if (hybrid && supplied?.plan !== null)
        return send(400, { error: "Browser-supplied plans are not accepted" });
      // Only the server-owned validated plan can enter Jev's state. It is not
      // silently substituted if the browser snapshot predates that plan.
      if (hybrid && authorized?.planSession && authorized.gameId === supplied.game_id) {
        const live = authorized.planSession.getPlan({
          session_id: authorized.id, game_id: authorized.gameId });
        if (live && live.source_tick <= supplied.snapshot_tick &&
            supplied.snapshot_tick < live.expires_tick) {
          requestedPlan = { game_id: authorized.gameId, ...live };
        }
      }
      const observation = hybrid
        ? validateHybridInput({ ...supplied, plan: requestedPlan })
        : validateObservation(supplied);
      // Candidate limits can fail even for a valid observation. Reject before
      // acquiring the single-flight lock, so this cannot strand the server busy.
      request = hybrid
        ? buildHybridRequest(observation, model)
        : buildRequest(observation, model);
    } catch {
      return send(400, { error: OBSERVATION_ERROR });
    }
    if (busy)
      return send(429, { error: "A decision request is already pending" });
    busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    try {
      // A browser sending at 1 Hz may arrive a few ms early due to network
      // jitter. Wait for the deadline instead of failing a valid loop with
      // 429. Hold the single-flight lock while waiting; never build a queue.
      while (performance.now() < lastCall + minimumIntervalMs) {
        await delay(
          Math.ceil(lastCall + minimumIntervalMs - performance.now()),
          undefined,
          { signal: controller.signal },
        );
      }
      controller.signal.throwIfAborted();
      if (
        requireStartSession &&
        (session !== authorized ||
          performance.now() >= authorized.expiresAt ||
          authorized.count >= authorized.limit)
      )
        throw new Error("Start session changed or expired before inference");
      const start = performance.now();
      lastCall = start;
      if (requireStartSession) authorized.count++;
      activeRequestAbort = controller;
      const requestStartedAt = new Date().toISOString();
      const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
      const answer = await response.json();
      if (requireStartSession && (session !== authorized ||
          performance.now() >= authorized.expiresAt))
        throw new Error("Start session changed during inference");
      const planStillApplicable = () => {
        if (!hybrid || !requestedPlan) return true;
        const stillLive = authorized.planSession?.getPlan({
          session_id: authorized.id, game_id: authorized.gameId });
        return Boolean(stillLive && stillLive.plan_version === requestedPlan.plan_version &&
          stillLive.source_tick === requestedPlan.source_tick &&
          request.state.snapshot_tick < stillLive.expires_tick);
      };
      if (!planStillApplicable())
        throw new Error("Planner objective expired during Jev inference");
      const decision = {
        ...(hybrid
          ? parseHybridDecision(answer, request)
          : parseDecision(answer, request.questions.action.criteria)),
        latencyMs: Math.round(performance.now() - start),
      };
      await log({
        timestamp: new Date().toISOString(),
        requestStartedAt,
        policy: hybrid ? HYBRID_POLICY_VERSION : POLICY_VERSION,
        planProvenance: requestedPlan ? { provider: "official-copilot-sdk",
          promptVersion: COPILOT_PLAN_PROMPT_VERSION,
          version: requestedPlan.plan_version, source_tick: requestedPlan.source_tick } : null,
        request,
        decision,
      });
      if (requireStartSession && (session !== authorized ||
          performance.now() >= authorized.expiresAt))
        throw new Error("Start session changed before decision response");
      if (!planStillApplicable())
        throw new Error("Planner objective expired before decision response");
      if (!res.destroyed) send(200, decision);
    } catch (error) {
      // Never relay arbitrary upstream bodies/errors; they may contain request credentials.
      const safeError = /^TypeSafe HTTP \d+$/.test(error.message)
        ? error.message
        : "Decision failed or timed out";
      console.warn(safeError);
      if (!res.destroyed) send(502, { error: safeError });
    } finally {
      clearTimeout(timeout);
      res.off("close", onClose);
      if (activeRequestAbort === controller) activeRequestAbort = null;
      busy = false;
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.TYPESAFE_AI_API_KEY) {
    console.error(
      "Export TYPESAFE_AI_API_KEY before starting (for example: source ~/.secrets).",
    );
    process.exitCode = 1;
  } else {
    const logs = new URL("../logs/", import.meta.url);
    await mkdir(logs, { recursive: true });
    const logfile = new URL(
      `decisions-${new Date().toISOString().replaceAll(":", "-")}.jsonl`,
      logs,
    );
    const server = createAgentServer({
      apiKey: process.env.TYPESAFE_AI_API_KEY,
      model: process.env.TYPESAFE_MODEL || "jev-latest",
      enableHybridDecisions: process.env.OPENFRONT_HYBRID_EXPERIMENT === "1",
      enableNavalDecisions: process.env.OPENFRONT_NAVAL_EXPERIMENT === "1",
      enableCopilotPlanner: process.env.OPENFRONT_COPILOT_PLANNER === "1",
      log: (record) => appendFile(logfile, JSON.stringify(record) + "\n"),
    });
    server.listen(8788, "127.0.0.1", () =>
      console.log(
        "Jev sidecar: http://127.0.0.1:8788 (no model requests until Start is clicked)",
      ),
    );
  }
}
