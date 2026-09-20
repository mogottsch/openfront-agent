# OpenFront · Jev wilderness experiment

A deliberately small local-solo experiment: Jev sees **our available troop count and current troop capacity**, and chooses `wait`, `attack_0`, `attack_10`, or `attack_20`.

- Input: `{ "troops": 3900, "troop_capacity": 12000 }`, both in **display units** (internal values / 10, rounded down). Capacity is computed by OpenFront's real `Config.maxTroops(player)` rule.
- One TypeSafe Choice question per decision; no history, enemies, map, or ongoing attacks are sent.
- Policy `wilderness-reserve-v2`: aim for roughly 30% of capacity in reserve. Wait at or below 31.6%, send 10% above 31.6% through 35.3%, and send 20% above 35.3%. These are instructions to Jev, **not a deterministic action override in the harness**.
- `wait` and `attack_0` are both no-ops: existing attacks and the simulation keep running. These redundant options are retained intentionally for the first experiment; their probabilities may split.
- `attack_10` / `attack_20` commit that fraction of the **current** available internal troop pool at execution time, via OpenFront's normal `SendAttackIntentEvent(null, troops)`.
- Jev's selected option is used directly. Confidence and all option probabilities are displayed, not used as an unvalidated threshold.
- Default cadence: one request per second, measured **request-start to request-start**, at most 30 requests per Start. Both are adjustable in the panel. Requests never overlap. A slow response delays the next request; missed periods are not queued or caught up.

This is an interface and policy-following experiment, not a claim of optimal strategy. The two-field observation still omits existing commitments, terrain, threats, and recent changes. The model is not secretly given those facts. The prompt describes the current decision; cadence, cancellation, and execution belong to the harness.

## Current model behavior

The reserve-v2 live test changed behavior from constant 20% attacks to **23 waits, five 10% attacks, and two 20% attacks** over 30 decisions. The first attack occurred after about four seconds. However, only **24/30 choices matched the stated reserve ranges**: six times Jev waited where the rule called for 10%. A separate fixed-observation probe also failed at 5,000/12,000 troops. This is not an exact implementation of the numeric rule, and the harness does not conceal that by overriding the model. See [reserve-v2 validation](docs/reserve-v2-validation.md).

## Run

Requires Node 22+, the sibling `../OpenFrontIO` checkout, and its installed dependencies. This project has no npm dependencies.

Install the small local integration (tested against OpenFront `bb8af015b`):

```bash
cd ~/dev/openfront-agent
npm run install:bridge
```

Start the model sidecar in one terminal:

```bash
cd ~/dev/openfront-agent
set +x
source ~/.secrets
npm start
```

The sidecar reads `TYPESAFE_AI_API_KEY`, binds to `127.0.0.1:8788`, and calls `https://api.typesafe.ai/v1/systemone`. The key stays in the Node process, never in browser code or logs. Optionally set `TYPESAFE_MODEL` (default `jev-latest`).

In another terminal, start the game if it is not already running:

```bash
cd ~/dev/OpenFrontIO
SKIP_BROWSER_OPEN=true npm run dev
```

Open **http://localhost:9000/** in Chrome with hardware acceleration enabled. Start a **Solo** match, choose a spawn (or enable Random spawn), then click **Start Jev** in the top-right panel. For an easy smoke test, use Europe / Easy / 10 tribes / 5 nations / Random spawn.

The panel does not make model requests until Start. It is only mounted on a loopback-hosted development build, in singleplayer, outside replays. Private/public multiplayer games are excluded from this first version. If the sidecar was not running when the match started, start it and begin a new match to load the panel.

## Boundaries and stops

Local code checks readiness, pause/catch-up state, whether we're alive, and whether adjacent claimable wilderness exists. These are execution guards, **not additional Jev inputs**. Border queries use the existing simulation-worker API.

- Waits for spawning/active play; no inference during pause or unchanged ticks.
- Stops on death/victory, no adjacent wilderness, request limit, or API/validation error.
- Stops when the tab is hidden; Stop and game teardown abort pending work and prevent late actions.
- Drops decisions older than two seconds or 20 simulation ticks.
- Only 10% and 20% wilderness attack intents can be emitted by the bridge.
- The simulation is never mutated directly; bots and game rules remain unchanged.
- An aborted HTTP request may already have consumed API tokens. There are no automatic retries.
- A fast reply leaves the remainder of the one-second interval idle. A reply taking 1.4 seconds allows the next request immediately afterward, using fresh state. Stop/Start preserves pacing and waits for the prior request to settle.
- The sidecar also enforces single-flight and at least one second between upstream request starts. Slightly early arrivals wait for the deadline instead of failing due to network jitter; additional concurrent requests are rejected, not queued.

## Files

| File                                   | Responsibility                                                          |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `src/policy.mjs`                       | Exact prompt, four options, input/output validation                     |
| `src/server.mjs`                       | Local HTTP service, credentials, TypeSafe request, JSONL logging        |
| `web/controller.js`                    | Bounded decision loop, cancellation, freshness, action mapping          |
| `web/agent.js`                         | In-game Start/Stop panel and recent decisions                           |
| `integration/WildernessAgentBridge.ts` | Reads OpenFront state and emits normal wilderness intents               |
| `scripts/install-bridge.mjs`           | Installs/removes the integration without replacing game files wholesale |

Requests and model responses are recorded in ignored `logs/decisions-*.jsonl`. These contain the exact prompt, state, resolved model, probabilities, confidence, latency, and token usage. New records also include `requestStartedAt` (upstream request start) alongside `timestamp` (completion); latency excludes any local pacing wait. **They record inference, not proof of execution**; the panel shows whether the client sent or discarded a decision. No credentials are logged.

The installer adds `src/client/WildernessAgentBridge.ts` to OpenFront and a small start/stop hook in `src/client/ClientGameRunner.ts`. It makes no core/simulation changes. Set `OPENFRONT_DIR` if your checkout is elsewhere. Re-run the installer after editing the bridge source. After updating the observation schema or prompt, restart the sidecar and reload the game page before starting a new match; old troop-only clients are rejected rather than silently inventing capacity.

To remove the integration while preserving other edits:

```bash
node scripts/install-bridge.mjs --remove
```

## Opening strategy analysis

[Engine-based opening comparison](docs/opening-analysis.md) compares fixed sends with reserve-target policies using the real growth and combat code. It motivates the current roughly 30% reserve target as a land/army compromise, rather than assuming the fixed-capacity 42% growth peak is globally optimal. Reproduce the 162-run sweep with `npm run analyze:opening`, or use `npm run analyze:opening -- --smoke` for three short cases. The analysis makes no Jev calls: its deterministic reserve policies are reference baselines, separate from the live bot's model-selected actions.

## Validation

```bash
npm test
cd ../OpenFrontIO
npx tsc --noEmit
npx vitest run tests/client/ClientGameRunnerActions.test.ts tests/client/ClientGameRunnerMessages.test.ts tests/client/LocalServer.test.ts
```

Current reserve policy (`wilderness-reserve-v2`) live test on 2026-09-20: 30 real calls, one in flight at most, browser request-start gaps 1004–1019 ms, seven wilderness intents sent, and visible territorial expansion. API latency averaged 251 ms (196–604 ms). The controller stopped at its 30-request cap. See the model-adherence limitations above; passing harness tests does not establish that Jev follows numeric thresholds correctly.

Original troop-only policy (`wilderness-v1`) live smoke test on 2026-09-20: a fresh Europe solo match made three real requests to `jev-1.13.0`, selected `attack_20` three times, emitted three wilderness intents, and visibly expanded territory. Observations were 2700, 2769, and 2886 display troops; API round trips were 606, 246, and 276 ms. The controller stopped at its three-request cap. Confidence was 0.40–0.41, with most probability split between the two nonzero attacks. This verifies wiring, not strategic quality.

Troop-only policy (`wilderness-v1`) one-second cadence smoke test on 2026-09-20: ten real decisions in a fresh Europe solo match. Browser-measured request-start gaps were 1006–1020 ms, with a maximum of one in-flight request and no pending request at completion. Sidecar-recorded upstream starts were 1002–1019 ms apart. API latency was 227–576 ms (324 ms average, 299 ms median). Jev chose 20% for all ten decisions; the panel recorded ten wilderness intents sent and territory visibly expanded. The bot stopped at the ten-request cap. Slow replies, Stop/Start during inference, stale responses, and delayed state preparation are covered separately by virtual-clock tests in `tests/cadence.test.mjs`.
