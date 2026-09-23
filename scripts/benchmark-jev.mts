// Optional real-engine v4.1 evaluation. --mock makes no API calls; --live is
// explicit and calls ONLY the already-running loopback Jev sidecar /decision.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { actionCriteria, buildActions } from "../web/observation.js";
import { POLICY_VERSION } from "../src/policy.mjs";
import { runBenchmarkMatch, type Options } from "./benchmark-baseline.mts";
import {
  createPacedDecisionClient,
  observeCore,
  recheckCoreAction,
} from "./benchmark-jev-observation.mjs";

function integer(s: string, flag: string, max: number) {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error(`${flag} requires an integer from 1 to ${max}`);
  return n;
}
function args(argv: string[]) {
  let mode: "mock" | "live" | null = null;
  let seed = "bench-001";
  let maxCalls = 2;
  let maxTicks = 30;
  let minutes = 5;
  let output = "logs/benchmark-jev-smoke.json";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      if (!argv[i + 1]) throw new Error(`missing value for ${flag}`);
      return argv[++i];
    };
    switch (flag) {
      case "--mock": case "--live":
        if (mode !== null) throw new Error("choose exactly one of --mock and --live");
        mode = flag.slice(2) as "mock" | "live";
        break;
      case "--seed":
        seed = next();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(seed)) throw new Error("invalid seed");
        break;
      case "--max-calls": maxCalls = integer(next(), flag, 360); break;
      case "--max-ticks": maxTicks = integer(next(), flag, 73000); break;
      case "--minutes": minutes = integer(next(), flag, 120); break;
      case "--output":
        output = next();
        if (!output.endsWith(".json")) throw new Error("--output must be .json");
        break;
      default: throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (mode === null) throw new Error("explicit --mock or --live required; no default model calls");
  return { mode, seed, maxCalls, maxTicks, minutes, output };
}

const cli = args(process.argv.slice(2));
console.debug = () => {};
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
let sidecar = null;
if (cli.mode === "live") {
  // Read-only loopback check; a mismatched local prompt is not v4.1 evidence.
  const health = await fetch("http://127.0.0.1:8788/health", {
    signal: AbortSignal.timeout(2000),
  });
  if (!health.ok) throw new Error(`Local sidecar health HTTP ${health.status}`);
  sidecar = await health.json();
  if (sidecar.policy !== POLICY_VERSION || !sidecar.keyConfigured)
    throw new Error(`Local sidecar policy/key does not match ${POLICY_VERSION}`);
}
const opts: Options = {
  smoke: true,
  seeds: [cli.seed],
  minutes: cli.minutes,
  maxTicks: cli.maxTicks,
  spawn: [400, 280],
  output: cli.output,
};
let totalCalls = 0;
let lastTickStart = -Infinity;
const paceTick = async () => {
  const wait = lastTickStart + 100 - performance.now();
  if (wait > 0) await sleep(Math.ceil(wait));
  const started = performance.now();
  if (started < lastTickStart + 100)
    throw new Error("Tick pacing clock did not advance by 100ms");
  lastTickStart = started;
};
const mockFetch = async (_url: string, init: any) => {
  // Exercise JSON request/response and paced transport without a sidecar or
  // credential. A mock Choice is never labelled as an actual Jev judgment.
  const observation = JSON.parse(init.body);
  const actions = buildActions(observation);
  const choice = Object.keys(actions).find((id) => id !== "wait") ?? "wait";
  return { ok: true, json: async () => ({ action: choice, model: "mock-first-legal" }) };
};
const ask = createPacedDecisionClient({ fetchImpl: cli.mode === "mock" ? mockFetch : fetch });
const jev = await runBenchmarkMatch(cli.seed, "jev-v4.1", opts, {
  paceTick,
  decide: async ({ game, human, second }: any) => {
    const snapshot = observeCore(game, human);
    const candidates = actionCriteria(snapshot.actions);
    if (Object.keys(snapshot.actions).length === 1) {
      return { action: snapshot.actions.wait,
        record: { call: "not-needed", observation: snapshot.observation, candidates,
          selectedId: "wait", decision: null } };
    }
    if (totalCalls >= cli.maxCalls) return { stop: "censored-call-cap" as const,
      record: { call: "not-sent", reason: "call cap reached", candidates } };
    totalCalls++;
    let answer;
    try {
      answer = await ask(snapshot.observation);
    } catch (error: any) {
      return { stop: "censored-model-error" as const,
        record: { call: cli.mode === "live" ? "sidecar" : "mock",
          observation: snapshot.observation, candidates,
          error: error?.message ?? "Decision failed" } };
    }
    // A sidecar 200 is a model response only in --live. Validate returned ID
    // against *this* turn's offered candidates, then recheck real core rules.
    const choice = answer.decision.action;
    let action;
    try {
      action = recheckCoreAction(game, human, snapshot, choice);
    } catch (error: any) {
      return { stop: "censored-model-error" as const,
        record: { call: cli.mode === "live" ? "sidecar" : "mock",
          observation: snapshot.observation, candidates,
          decision: answer.decision, selectedId: choice,
          error: error?.message ?? "Illegal or stale decision" } };
    }
    return {
      action,
      record: {
        call: cli.mode === "live" ? "sidecar" : "mock",
        observation: snapshot.observation,
        candidates,
        selectedId: choice,
        decision: answer.decision,
        // Monotonic timings are evidence of >=1s spacing but not seeded state.
        requestStartedAtMs: answer.startedAtMs,
        latencyMs: answer.latencyMs,
        selected: action,
      },
    };
  },
});
// Pair the identical seed/spawn/opponents at the *same observed live tick*
// horizon. Short/call-capped matches remain censored; no invented win count.
const baseline = await runBenchmarkMatch(cli.seed, "fixed20-wilderness", {
  ...opts, maxTicks: Math.max(1, jev.liveTicks),
});
if (JSON.stringify(jev.opponentSpawns) !== JSON.stringify(baseline.opponentSpawns))
  throw new Error("Unpaired opponent roster or spawn");
const report = {
  schemaVersion: 1,
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  policy: POLICY_VERSION,
  mode: cli.mode,
  sidecar: cli.mode === "live" ? { model: sidecar.model, policy: sidecar.policy } : null,
  config: { seed: cli.seed, map: "Onion", difficulty: "Impossible",
    timerMinutes: cli.minutes, maxLiveTicks: cli.maxTicks, maxCalls: cli.maxCalls,
    tickPacingMs: 100, requestStartSpacingMs: 1000, sidecarTimeoutMs: 6500 },
  calls: { sidecar: cli.mode === "live" ? totalCalls : 0,
    mock: cli.mode === "mock" ? totalCalls : 0 },
  jev, baseline,
  pair: {
    completed: jev.completed && baseline.completed,
    jevWin: jev.win,
    baselineWin: baseline.win,
    humanTileDelta: jev.human.tiles - baseline.human.tiles,
  },
};
await mkdir(dirname(resolve(cli.output)), { recursive: true });
await writeFile(cli.output, JSON.stringify(report, null, 2) + "\n");
console.log(`${cli.mode}: ${totalCalls} calls, Jev ${jev.status}, ` +
  `baseline ${baseline.status}, human tiles ${jev.human.tiles}/${baseline.human.tiles}; ${cli.output}`);
if (jev.status === "censored-model-error" || (cli.mode === "live" && jev.status !== "engine-win")) {
  // A real capped/failed run is evidence only of decisions and intents, not a
  // complete-match outcome. Keep it saved, but make the CLI unmistakable.
  process.exitCode = 2;
}
