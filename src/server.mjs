import { createServer } from "node:http";
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

const publicFiles = new Map([
  ["/agent.js", new URL("../web/agent.js", import.meta.url)],
  ["/controller.js", new URL("../web/controller.js", import.meta.url)],
  ["/observation.js", new URL("../web/observation.js", import.meta.url)],
  ["/game-adapter.js", new URL("../web/game-adapter.js", import.meta.url)],
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
} = {}) {
  let busy = false;
  let lastCall = -Infinity;
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
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    if (req.method !== "POST" || pathname !== "/decision")
      return send(404, { error: "Not found" });
    if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
      return send(415, { error: "JSON required" });
    if (!apiKey)
      return send(503, {
        error: "TYPESAFE_AI_API_KEY is not configured on the local server",
      });
    let observation;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) return send(413, { error: "Request too large" });
        chunks.push(chunk);
      }
      observation = validateObservation(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
    } catch {
      return send(400, { error: OBSERVATION_ERROR });
    }
    if (busy)
      return send(429, { error: "A decision request is already pending" });
    busy = true;
    const request = buildRequest(observation, model);
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
      const start = performance.now();
      lastCall = start;
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
      const decision = {
        ...parseDecision(
          await response.json(),
          request.questions.action.criteria,
        ),
        latencyMs: Math.round(performance.now() - start),
      };
      await log({
        timestamp: new Date().toISOString(),
        requestStartedAt,
        policy: POLICY_VERSION,
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
      log: (record) => appendFile(logfile, JSON.stringify(record) + "\n"),
    });
    server.listen(8788, "127.0.0.1", () =>
      console.log(
        "Jev sidecar: http://127.0.0.1:8788 (no model requests until Start is clicked)",
      ),
    );
  }
}
