# Deterministic native-AI baseline benchmark

`scripts/benchmark-baseline.mts` runs **actual headless OpenFront simulation matches** against the native **Impossible-difficulty nation AI**. It is an offline benchmark harness, not a Jev/Copilot controller or a browser match. It makes no API requests, does not change the bridge, and does not install or edit the sibling OpenFront checkout.

## Run

From `openfront-agent` (requires the sibling `../OpenFrontIO` checkout with its dependencies installed):

```sh
# Short bounded integration smoke: two policies, one seed, 70 live ticks;
# intentionally censored and NOT a win-rate measurement.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-baseline.mts --smoke --output logs/benchmark-smoke.json

# Complete timed matches: three paired seeds, two policies, real engine Win events.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-baseline.mts --output logs/benchmark-baseline.json

# Custom replicates/spawn and timer (the timer is in game minutes):
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-baseline.mts --seeds trial-001,trial-002 --spawn 400,280 --minutes 5 --output logs/trial.json
```

`OPENFRONT_DIR` overrides `../OpenFrontIO`. The JSON goes under ignored `logs/` by default; do not commit generated run logs. The CLI accepts `--max-ticks N` as a hard **live-game** tick cap. Without `--smoke`, if either member of a pair reaches that cap without an engine Win event, its status is `censored-tick-cap`, its `win` is `null`, no win rate is inferred from that pair, and the process exits with code 2. A failed spawn or engine tick instead throws an error. `--smoke` deliberately allows censored rows and exits 0. The default full cap is timer + 50 ticks, not an unbounded CI workload.

## Match setup and pairing

- OpenFront **Onion**, normal size, production `map.bin`/`map4x.bin` and manifest, Singleplayer FFA, one human at fixed `(400,280)` and **all three native manifest nations**, difficulty `Impossible`, no generic tribes (`bots: 0`). The engine's native AI may use its normal buildings, diplomacy, or other mechanics; the controlled human policies use only land attacks. This tests strongest *nation difficulty* available in the local engine, not an assertion that generic tribes or these controls are the globally strongest bots.
- Each policy/seed pair gets identical game ID, seeded human/nation IDs and AI RNG initialization, manifest nations, human spawn, config, and **fresh map instances**. This matters: the upstream terrain loader caches mutable map state; reusing a GameMap between policies corrupts the comparison. Nation spawn IDs and coordinates are checked equal across each pair and reported in JSON. AI decisions may diverge *after* different human actions; that is the experimental effect, not a failure of pairing.
- Human spawn is a stamped `spawn` turn through `Executor`/`GameRunner`. Turns and `attack` intents go through the same pipeline as local games. The harness requires the human and all nations to spawn and records the actual positions. It does not pretend an unspawned opponent was beaten.
- `fixed20-wilderness` sends 20% of available troops every game second to bordering wilderness, otherwise waits. `fixed50-land` sends 50% to the weakest **legally attackable bordering nation** (troops, then ID tie-break), otherwise to bordering wilderness, otherwise waits. These are **deliberately simple deterministic controls**, not the deployed agent's strategy, and are not Jev decisions. The benchmark does not revise the approved bot observation or action scope.
- Five-minute default in-game timer: native `WinCheckExecution` awards victory to the leading tile owner when timer expires, or earlier to a player crossing the engine's land-share threshold (>80% of non-fallout land by default). `winRule` labels timer vs land-share; winner identity and wire update come from the engine's actual `Win` event, not a proxy tile ranking. An eliminated human remains a loss only after the engine has produced a winner. This is a *timed complete match*, not a natural unlimited-duration conquest test.

Each row records engine commit, seed/policy, true winner and win rule, elapsed time, final game hash, human survival/land share/troops, final standings (every player's owned tiles, raw troops, gold as a decimal string, and counts of port/city/factory/defense post/missile silo/SAM launcher, including any under construction), 30-second territory snapshots, and human attack **intents submitted** (with target class and requested troops). Submitted intents are **not proof that every execution succeeded**; compare observed game outcomes separately. Paired summary win counts include only pairs where *both* rows completed. Troop metrics are raw internal units (divide by 10 for displayed game troops). A repeat run with the same engine commit/CLI inputs should yield identical JSON and final hashes.

## Initial calibration (local engine, not Jev)

With the three default seeds, `(400,280)` and five-minute timer, the local checkout produced **six completed engine-win matches** (three paired comparisons). The baseline and aggressive control each won **0/3**; each winner was a native Impossible nation. Both were often confined to a small territory; in two aggressive-control seeds the human was eliminated by match end. These are calibration outcomes for very weak controls on a particular tiny map, **not** a statistically useful win-rate estimate, proof a stronger agent cannot win, or evidence of a live/browser Jev result. The engine commit and exact hashes are in generated JSON, not frozen here because the sibling checkout can change independently.

For a more representative strength comparison, vary maps/spawns, opponent compositions, and replicate counts in a *separate agreed benchmark design*. Do not silently widen the deployed bot's observations/actions or substitute these hard-coded policies for model choices.

## Optional v4.1 Jev-vs-Impossible interface (no live calls run yet)

`scripts/benchmark-jev.mts` reuses the **same seeded engine match runner and fresh-map setup**. `scripts/benchmark-jev-observation.mjs` translates a core Game/Player snapshot to exactly the v4.1 `web/observation.js` shape. It uses the browser adapter's `summarizeBorders`, direct core `canAttack` (the worker's legality check), and **each incoming attack's actual attacker** (including third-party attacks on neighbors). A network-free unit test compares the full object field-for-field against the browser GameView adapter on a shared fixture, including third-party attacker type and reserve. An actual engine mock smoke also validates the schema against live nations. If an observation cannot be represented within the existing limits, the match stops with an error; it never fabricates metadata or expands the schema.

```sh
# Explicit offline mode: two deterministic mock Choices; no sidecar/API requests.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-jev.mts --mock --max-calls 2 --max-ticks 30 --output logs/benchmark-jev-mock.json

# NOT run as part of these checks. Run only after Moritz explicitly approves
# starting the controller/paid calls, with the local sidecar already running:
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-jev.mts --live --max-calls 2 --max-ticks 30 --output logs/benchmark-jev-live.json
```

There is **no default mode**: without `--mock` or `--live`, the command fails before loading a match. Live mode calls only `http://127.0.0.1:8788/decision` (no API keys in this script). Request starts are spaced by monotonic wall-clock ≥1 second, requests are single-flight with a 6.5-second client abort (the sidecar has its own 5-second timeout), and engine ticks start no faster than every 100 ms (10 simulated ticks = one real second at most). A slow response pauses simulation, rather than catching up with a burst; it may therefore differ from concurrent browser play. There is no Copilot call. The cap is two calls by default; raise it only after cost approval. The five-minute full timed match needs roughly 301 paid decisions if attack candidates remain available; **no full Jev match has been run or approved yet**.

Each requested decision records the exact observation, candidate descriptions, returned choice/model metadata, selected candidate, wall-clock timing, and emitted intent separately from the final engine winner/standings. A mock response is labelled `mock`, never Jev. The script runs the fixed-20 control with the same seed/opponent spawn and the same *observed live-tick horizon* for a paired readout. When the call cap hits, status is `censored-call-cap`, winner and win remain `null`; an error yields `censored-model-error`, never a heuristic replacement attack. These are **not complete matches or win-rate data**. Gold is raw integer string and structure counts are final owned instances, not causal evidence that cities were built first. In the default two-call mock, all structure counts are zero because the run ends after roughly two game seconds; inspect full control final standings for later economic comparisons, without treating that as a city-first result.
