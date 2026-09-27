// Explicit paid TypeSafe PROBE on D's unchanged real-engine naval snapshot.
// No controller imports this and the HTTP route returns probe_only:true;
// neither the script nor server emits an intent or advances a game tick.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  buildNavalDecomposedRequest,
  NAVAL_DECOMPOSED_POLICY_VERSION,
} from "../src/naval-decomposed-policy.mjs";

const flags = new Set(process.argv.slice(2));
const permitted = new Set([
  "--run",
  "--max-requests=1",
  "--source=full11",
  "--source=bounded8",
  "--source=before",
]);
if (
  [...flags].some((f) => !permitted.has(f)) ||
  ["--source=full11", "--source=bounded8", "--source=before"].filter((f) =>
    flags.has(f),
  ).length > 1
)
  throw new Error("Invalid probe flags");
if (!flags.has("--run")) {
  console.log(
    "DRY RUN: no API calls. To opt into exactly one PROBE: --run --max-requests=1 --source=before|full11|bounded8",
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
const request = buildNavalDecomposedRequest(input);
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
  !health.decomposedNavalProbeEnabled ||
  health.sessionActive
)
  throw new Error("Expected idle opt-in local Jev naval probe endpoint");
let token = null,
  result = null;
try {
  const session = await fetch("http://127.0.0.1:8788/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "hybrid", limit: 1 }),
    signal: AbortSignal.timeout(3000),
  });
  if (!session.ok) throw new Error(`Start HTTP ${session.status}`);
  token = (await session.json()).token;
  const response = await fetch("http://127.0.0.1:8788/naval-decomposed-probe", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Session": token },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(9000),
  });
  const data = await response.json();
  if (response.ok && (!data.probe_only || data.intent_emitted !== false))
    throw new Error("Probe route violated no-intent contract");
  result = {
    kind: "Real Jev API probe on actual-engine fixed snapshot; NOT live gameplay",
    policy: NAVAL_DECOMPOSED_POLICY_VERSION,
    source,
    sourceTick: input.snapshot_tick,
    engineCommit: report.engineCommit,
    snapshotSha256: createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex"),
    targetsOffered: input.naval.candidates.length,
    status: response.status,
    ...(response.ok
      ? { decision: data.decision, intent_emitted: false }
      : { error: data.error }),
  };
  const d = data.decision;
  console.log(
    JSON.stringify({
      status: response.status,
      source,
      targetsOffered: result.targetsOffered,
      ...(response.ok
        ? {
            branch: d.branch,
            selected: d.selected,
            kind: d.kind,
            candidate_id: d.candidate_id,
            fraction: d.fraction,
            targetChoice: d.decisions?.boat_target?.action,
            branchProbabilities: d.decisions?.branch?.probabilities,
            targetTop: Object.entries(
              d.decisions?.boat_target?.probabilities ?? {},
            )
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5),
            latencyMs: d.latencyMs,
          }
        : { error: data.error }),
    }),
  );
  if (!response.ok) process.exitCode = 2;
} finally {
  if (token) {
    const stop = await fetch("http://127.0.0.1:8788/session", {
      method: "DELETE",
      headers: { "X-Agent-Session": token },
      signal: AbortSignal.timeout(3000),
    });
    if (!stop.ok) throw new Error("Could not revoke probe Start session");
  }
  if (result)
    await writeFile(
      `logs/naval-decomposed-${source}-probe.json`,
      JSON.stringify(result, null, 2) + "\n",
    );
}
