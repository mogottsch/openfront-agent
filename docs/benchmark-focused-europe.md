# Focused Europe benchmark: bounded headless evaluation

`scripts/benchmark-focused-europe.mts` evaluates the shared land observation/menu and persistent tribe-focus helpers against an actual OpenFront `GameRunner`/`Executor`. It does **not** launch the browser, change the current controller, contact Copilot, read API credentials, or choose substitute actions when a response fails legality.

**Current evidence:** a short native-AI **mock** smoke and dependency-free harness tests. No paid `--live` run has been authorized or executed for this harness. Neither a tribe kill nor a full-match win has been demonstrated by the smoke.

## Offline reproduction

From `openfront-agent`, with the sibling OpenFront checkout/dependencies installed:

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-focused-europe.mts --mock --max-calls 3 --max-ticks 60 \
  --output logs/benchmark-focused-europe-smoke.json

node --test tests/benchmark-focused-europe.test.mjs
npm test
```

A mode flag is required: no flags fail before loading a game or starting a session. `--mock` makes **zero HTTP calls**, including health/Start/Stop. Its explicitly labeled fake Choice selects the first currently offered non-wait ID (or wait). That is a transport/menu integration control, **not Jev strategy**. Real native Easy tribes and nations still execute every engine tick. Only `logs/*.json` output paths are allowed, and generated reports stay gitignored.

The native setup is copied from D's [`benchmark-europe-tribes.mts`](../scripts/benchmark-europe-tribes.mts): fresh production Europe/Compact `map4x.bin`/`map16x.bin`, Easy, 12 native tribes and native England/Spain/Switzerland nations, seed `europe-focus-001`, human spawn `(543,491)`, and five-minute timer. The compact main map is 1452×836 in engine checkout `bb8af015b515b3b717bd4d901074c5f4c16641cb`. No troop/gold/terrain edit is applied after spawning. All 15 native opponents must actually spawn before observation begins; their IDs, types and coordinates are saved.

## Verified bounded smoke

With three fake requests and a 60-tick ceiling, quota was reached before the tick ceiling:

| Measurement | Actual smoke result |
| --- | --- |
| Policy metadata | `land-strategy-v4.5-tribe-progress` (menu/prompt version, not a real Jev judgment) |
| Horizon | Tick 3 → 31, 28 post-setup native ticks, three simulated seconds; `censored-call-cap` |
| Human territory | 52 → 326 tiles |
| Human reserve | 25,330 → 27,124 internal troops |
| Human gold | 100 → 2,900, normal game state; conquest gold **0** |
| Choices/intents | Three fake `attack_wilderness_10` Choices, three normal stamped land intents |
| Tribe bounty / Win | **0 human tribe ConquestEvents**, no Win update, `win:null` |
| Network / session | Zero HTTP calls, no Start token, no real TypeSafe/Copilot calls |
| Cadence | Measured tick starts ≥100 ms; request starts ≥1000 ms; single-flight, no catch-up bursts |

A second native smoke with global `fetch` replaced by a throwing function matched the roster, final engine hash and submitted intents. Monotonic wall-time samples naturally differ; this is deterministic game-state evidence, not byte-identical timing. Reports are `logs/benchmark-focused-europe-smoke.json` and `logs/benchmark-focused-europe-repeat.json` locally, not committed fixtures.

The short opening did not reach a tribe contact, so real-engine focus-through-conquest is **not** established by this smoke. Synthetic tests separately exercise stored focus and progress, unavailable identity, lost borders, death confirmation, fraction limits, fabricated responses, request quota, malformed Start cleanup, Stop on failure and engine Win/ConquestEvent report handling.

## Future live stage: explicit authorization required

Do not run this command until A/Moritz authorizes the staged provider budget and confirms no other session uses the sidecar:

```sh
# Example ONLY; not executed as part of the offline validation.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-focused-europe.mts --live --max-calls 5 --max-ticks 100 \
  --output logs/benchmark-focused-europe-live-smoke.json
```

`--live` requires an explicit `--max-calls` in 1..300. The harness checks policy/version, key configured, `requiresStart:true` and no active session at loopback `http://127.0.0.1:8788/health`, prepares the real map/roster, then acquires one `/session` in benchmark mode. Decisions use only local `/decision`, never provider endpoints directly. The token stays in a closure and is revoked in `finally`, including a known-token malformed Start response. There is no automatic retry after inference/validation/Stop failure. Local request attempts and successful local responses are reported separately; neither independently proves paid TypeSafe calls. The sidecar's private evidence is needed for that.

A longer match may use, for example, `--max-calls 300 --max-ticks 3050 --minutes 5`, **only with authorization**. Reaching the request or tick ceiling without a Win update is censored; the harness does not silently simulate the remainder using a heuristic or claim a loss/win. At the exact timer boundary it permits only the engine's bounded two-second empty-turn WinCheck grace, not an extra model decision. An eliminated human without a Win update is also not labeled as a completed match.

## Observation, focus and action causality

- `observeCore` supplies the actual same-tick land schema, exact decimal gold and legal neighbor facts. The shared `projectTribeFocus`, `recordTribeLandIntent` and `buildActions` are imported; this harness does not fork the priority gate or invent a strategy.
- Focus starts only from a submitted offered tribe attack (or the shared unique-active-tribe recovery rule). Actual `playerBySmallID`, stable player ID/type/alive flag and current tick resolve it thereafter, even if the target leaves the neighbor list. Missing/replaced identity is explicitly unavailable, never guessed dead. Unavailable focus retains memory, records the reason and skips inference/new intents within the bounded run.
- Progress records submitted intent history and observed target territory, not accepted attack count, causal damage or conquest. Its `reference_tick`/`reference_tiles` are the decision-observation baseline captured **before inference**, not the later intent submission time; emitted-intent records separately identify the actual stamped turn. Only actual `ConquestEvent` records credit bounty gold; another actor eliminating the focused tribe clears focus but does not credit our conquest.
- A returned ID must belong to that turn's `buildActions` menu and pass `recheckCoreAction` with current adjacency, friendship/immunity, target identity/type and fraction. Integer intent troops are `Math.floor(currentInternalReserve * selectedFraction)`. Invalid/stale/oversized choices stop the run: no resize, alternate target or replacement action.
- Every engine tick start uses the existing ≥100 ms pacer, every request start the existing ≥1000 ms single-flight client. The headless game is **paused during inference**; this differs from a concurrently advancing browser game and must not be called browser latency evidence.
- This land-only benchmark has no human boat, City, Defense Post, upgrade, diplomacy or cancellation action. Native AI behavior is unchanged. A full Easy result would not prove performance against harder opponents, other seeds, or the strongest bots.
