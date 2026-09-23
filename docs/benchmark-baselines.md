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

Each row records engine commit, seed/policy, true winner and win rule, elapsed time, final game hash, human survival/land share/troops, final standings, 30-second territory snapshots, and human attack **intents submitted** (with target class and requested troops). Submitted intents are **not proof that every execution succeeded**; compare observed game outcomes separately. Paired summary win counts include only pairs where *both* rows completed. Troop metrics are raw internal units (divide by 10 for displayed game troops). A repeat run with the same engine commit/CLI inputs should yield identical JSON and final hashes.

## Initial calibration (local engine, not Jev)

With the three default seeds, `(400,280)` and five-minute timer, the local checkout produced **six completed engine-win matches** (three paired comparisons). The baseline and aggressive control each won **0/3**; each winner was a native Impossible nation. Both were often confined to a small territory; in two aggressive-control seeds the human was eliminated by match end. These are calibration outcomes for very weak controls on a particular tiny map, **not** a statistically useful win-rate estimate, proof a stronger agent cannot win, or evidence of a live/browser Jev result. The engine commit and exact hashes are in generated JSON, not frozen here because the sibling checkout can change independently.

For a more representative strength comparison, vary maps/spawns, opponent compositions, and replicate counts in a *separate agreed benchmark design*. Do not silently widen the deployed bot's observations/actions or substitute these hard-coded policies for model choices.
