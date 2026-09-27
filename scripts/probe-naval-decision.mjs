// Explicit one-shot paid Jev probe on D's REAL-ENGINE, worker-checked Onion
// snapshot. No game action is emitted: the chosen candidate remains a string.
// This is neither mocked model output nor observed live gameplay.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  HYBRID_POLICY_VERSION,
  buildHybridRequest,
} from "../src/hybrid-policy.mjs";

const flags = new Set(process.argv.slice(2));
const permitted = new Set([
  "--run",
  "--max-requests=1",
  "--source=before",
  "--source=full11",
  "--source=bounded8",
]);
if (
  [...flags].some((f) => !permitted.has(f)) ||
  ["--source=before", "--source=full11", "--source=bounded8"].filter((f) =>
    flags.has(f),
  ).length > 1
)
  throw new Error("Invalid probe flags");
if (!flags.has("--run")) {
  console.log(
    "No model call. Opt in with: node scripts/probe-naval-decision.mjs --run --max-requests=1 --source=before|full11|bounded8",
  );
  process.exit(0);
}
if (!flags.has("--max-requests=1")) throw new Error("One-request cap required");
const source = flags.has("--source=before")
  ? "before"
  : flags.has("--source=bounded8")
    ? "bounded8"
    : "full11";
const report = JSON.parse(
  await readFile("logs/naval-adapter-engine.json", "utf8"),
);
const input =
  source === "before"
    ? report.before.hybrid_input
    : source === "bounded8"
      ? report.after_regrow.bounded8.hybrid_input
      : report.after_regrow.hybrid_input;
if (!input || input.naval?.candidates?.length < 1)
  throw new Error(
    "No verified engine naval candidates in ignored local artifact",
  );
const request = buildHybridRequest(input);
if (
  !request.questions.boat_action ||
  request.questions.branch.criteria.boat_attack === undefined
)
  throw new Error("Engine snapshot does not offer a naval branch");
const health = await (
  await fetch("http://127.0.0.1:8788/health", {
    signal: AbortSignal.timeout(2000),
  })
).json();
if (
  !health.keyConfigured ||
  !health.requiresStart ||
  !health.hybridEnabled ||
  !health.navalEnabled ||
  health.hybridPolicy !== HYBRID_POLICY_VERSION ||
  health.sessionActive
)
  throw new Error(
    "Expected idle opt-in local Jev sidecar with matching policy",
  );
const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
let token = null;
let result = null;
try {
  const session = await fetch("http://127.0.0.1:8788/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "hybrid", limit: 1 }),
    signal: AbortSignal.timeout(3000),
  });
  if (!session.ok) throw new Error(`Start HTTP ${session.status}`);
  token = (await session.json()).token;
  const response = await fetch("http://127.0.0.1:8788/hybrid-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Session": token },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(9000),
  });
  const data = await response.json();
  result = {
    kind: "Real Jev API judgment on fixed actual-engine snapshot; NO intent or game outcome",
    timestamp: new Date().toISOString(),
    engineCommit: report.engineCommit,
    source,
    sourceTick: input.snapshot_tick,
    snapshotSha256: digest,
    targetsOffered: input.naval.candidates.length,
    responseStatus: response.status,
    ...(response.ok ? { decision: data } : { error: data.error }),
  };
  console.log(
    JSON.stringify({
      status: response.status,
      sourceTick: result.sourceTick,
      targetsOffered: result.targetsOffered,
      ...(response.ok
        ? {
            branch: data.branch,
            selected: data.selected,
            kind: data.kind,
            candidate_id: data.candidate_id,
            fraction: data.fraction,
            branchProbabilities: data.decisions?.branch?.probabilities,
          }
        : { error: data.error }),
    }),
  );
  if (!response.ok) process.exitCode = 2;
} finally {
  if (token) {
    const stopped = await fetch("http://127.0.0.1:8788/session", {
      method: "DELETE",
      headers: { "X-Agent-Session": token },
      signal: AbortSignal.timeout(3000),
    });
    if (!stopped.ok) throw new Error("Could not revoke probe Start session");
  }
  if (result)
    await writeFile(
      `logs/naval-flat-${source}-probe.json`,
      JSON.stringify(result, null, 2) + "\n",
    );
}
