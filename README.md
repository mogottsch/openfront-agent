# OpenFront · Jev wilderness experiment

A deliberately small local-solo experiment: Jev sees **only our available troop count** and chooses `wait`, `attack_0`, `attack_10`, or `attack_20`.

- Input: `{ "troops": 2700 }`, in **display units** (internal troops / 10, rounded down).
- One TypeSafe Choice question per decision; no history, troop capacity, enemies, map, or ongoing attacks are sent.
- `wait` and `attack_0` are both no-ops: existing attacks and the simulation keep running. These redundant options are retained intentionally for the first experiment; their probabilities may split.
- `attack_10` / `attack_20` commit that fraction of the **current** available internal troop pool at execution time, via OpenFront's normal `SendAttackIntentEvent(null, troops)`.
- Jev's selected option is used directly. Confidence and all option probabilities are displayed, not used as an unvalidated threshold.
- Default cadence: one decision every two seconds, at most 30 requests per Start. Both are adjustable in the panel. Requests never overlap.

This is an interface experiment, not a claim of good strategy. One troop count cannot describe capacity, existing commitments, terrain, threats, or recent changes. The model is not secretly given those facts.

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

## Files

| File                                   | Responsibility                                                          |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `src/policy.mjs`                       | Exact prompt, four options, input/output validation                     |
| `src/server.mjs`                       | Local HTTP service, credentials, TypeSafe request, JSONL logging        |
| `web/controller.js`                    | Bounded decision loop, cancellation, freshness, action mapping          |
| `web/agent.js`                         | In-game Start/Stop panel and recent decisions                           |
| `integration/WildernessAgentBridge.ts` | Reads OpenFront state and emits normal wilderness intents               |
| `scripts/install-bridge.mjs`           | Installs/removes the integration without replacing game files wholesale |

Requests and model responses are recorded in ignored `logs/decisions-*.jsonl`. These contain the exact prompt, state, resolved model, probabilities, confidence, latency, and token usage. **They record inference, not proof of execution**; the panel shows whether the client sent or discarded a decision. No credentials are logged.

The installer adds `src/client/WildernessAgentBridge.ts` to OpenFront and a small start/stop hook in `src/client/ClientGameRunner.ts`. It makes no core/simulation changes. Set `OPENFRONT_DIR` if your checkout is elsewhere. Re-run the installer after editing the bridge source.

To remove the integration while preserving other edits:

```bash
node scripts/install-bridge.mjs --remove
```

## Validation

```bash
npm test
cd ../OpenFrontIO
npx tsc --noEmit
npx vitest run tests/client/ClientGameRunnerActions.test.ts tests/client/ClientGameRunnerMessages.test.ts tests/client/LocalServer.test.ts
```

Live smoke test on 2026-09-20: a fresh Europe solo match made three real requests to `jev-1.13.0`, selected `attack_20` three times, emitted three wilderness intents, and visibly expanded territory. Observations were 2700, 2769, and 2886 display troops; API round trips were 606, 246, and 276 ms. The controller stopped at its three-request cap. Confidence was 0.40–0.41, with most probability split between the two nonzero attacks. This verifies wiring, not strategic quality.
