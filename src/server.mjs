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
  requireStartSession = true,
} = {}) {
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
      session = {
        token: randomBytes(24).toString("base64url"),
        mode: value.mode,
        limit: value.limit,
        count: 0,
        expiresAt: performance.now() + 15 * 60_000,
      };
      return send(200, {
        token: session.token,
        mode: session.mode,
        limit: session.limit,
        expires_in_ms: 15 * 60_000,
      });
    }
    if (pathname === "/session" && req.method === "DELETE") {
      if (!session || req.headers["x-agent-session"] !== session.token)
        return send(403, { error: "No active Start session" });
      activeRequestAbort?.abort();
      session = null;
      return send(200, { stopped: true });
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
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) return send(413, { error: "Request too large" });
        chunks.push(chunk);
      }
      const supplied = JSON.parse(Buffer.concat(chunks).toString());
      // A browser may never claim an authoritative Copilot plan. The future
      // planner will inject an independently validated server-owned plan here.
      if (hybrid && supplied?.plan !== null)
        return send(400, { error: "Browser-supplied plans are not accepted" });
      const observation = hybrid
        ? validateHybridInput(supplied)
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
      if (requireStartSession && session !== authorized)
        throw new Error("Start session changed during inference");
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
        request,
        decision,
      });
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
      log: (record) => appendFile(logfile, JSON.stringify(record) + "\n"),
    });
    server.listen(8788, "127.0.0.1", () =>
      console.log(
        "Jev sidecar: http://127.0.0.1:8788 (no model requests until Start is clicked)",
      ),
    );
  }
}
