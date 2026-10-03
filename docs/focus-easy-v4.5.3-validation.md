# Routed v4.5.3: bounded real Easy opening and tribe gold

## Observed milestone

On 2026-10-03 A ran **20 explicitly Start-gated real Jev requests** after the source-backed territory facts (`b4a1c2c`) and pre-inference/final-submit route guards (`0d499fe`) landed. The Human expanded **52 → 2,533 tiles**, stayed alive, and the actual engine recorded one Human tribe conquest with **6,400 gold**. It stopped at the call cap; **no completed match or City outcome**.

Policy: `land-strategy-v4.5.3-territory-survival-buffer`; provider replies: `jev-1.13.0`. Same training setup: production Europe/Compact, seed `europe-focus-001`, Human (543,491), ordinary gold/troops, 12 native tribes and fixed Easy England/Spain/Switzerland. The [difficulty/spawn/roster audit](competitive-benchmark-audit.md) still applies. No held-out seed was consumed.

This was the actual `GameRunner`/`Executor`, not a mocked Choice. Native AI ran on every engine tick. Engine ticks pause during inference; same-tick and ≤2,000 ms wall-age final execution remain required. This is not actual Chrome or browser-cadence equivalence.

## Exact request route: no invented family answer

The sidecar `logs/decisions-2026-10-03T12-09-41.116Z.jsonl` contained exactly **20 non-probe v4.5.3 actual replies**, matching every driver action in `logs/jev-hybrid-europe-easy-v453-first20.json`.

All 20 requests used **`/decision`**, with the actual raw land observation and `buildRequest().questions.action`. Ordinary gold never afforded a City, so the headless driver selected this interface **before inference**, matching the browser's no-fresh-building land fallback. No `branch` question was asked, and no branch confidence/context was invented after the answer. Every returned wait was honored; no target, fraction or speculative child was substituted.

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --loop --live --max-calls 20 \
  --max-ticks 250 --minutes 5 --seed europe-focus-001 \
  --output logs/jev-hybrid-europe-easy-v453-first20.json
```

This command spends real requests; only run under an explicitly authorized bounded local experiment and idle compatible sidecar. No navy/Post/Copilot, artificial funds, historical replay or automatic retry was used.

## Choices → normal intents → actual conquest

| Actual chosen action | Count |
|---|---:|
| Wait | 12 |
| Wilderness 10% | 1 |
| Wilderness 20% | 3 |
| Tribe 11, 10% | 1 |
| Tribe 11, 20% | 3 |

Normal submitted turns were **4, 42, 72, 82, 102, 122, 132 and 162**. The first Choice at tick 3 was wilderness 10%, submitted tick 4 with **2,533 internal troops**. At the next observed tick 21, the Human held **130 tiles**. This is factual growth, not a guarantee of protection from enclosure or future combat.

The tribe campaign emitted 10% at **72** (4,201 internal troops), then three 20% sends at **82 / 102 / 122** (8,486 / 8,630 / 8,805 internal). It retained the same tribe focus; no new attack front opened before its authoritative death.

**Tick 130:** engine ConquestEvent, our Human `2wiw51xq` conquered tribe `k62i96c9` (smallID 11), gold **6400**. The next normal wilderness intent was after the confirmed conquest, at tick 132. No nation attack was emitted.

The initial 10% tribe send followed by 20% choices is an observed real model sequence, not an automatic escalation rule. It does not prove progress history caused those sizes or that the same fractions universally finish tribes.

## End state and guards

- Tick **3 → 201**, 198 live ticks, **20 game seconds**; Human alive.
- Tiles **52 → 2,533**.
- Internal troops **25,330 → 67,622** (~6,762.2 display reserve at end).
- Gold **100 → 26,300**, of which **6,400** is verified conquest payout; do not call the remainder conquest gold.
- Zero Cities, zero engine Win events; `complete:false`, `win:null`, `status:"censored-call-cap"`.
- Measured minimum starts **100.040 ms** engine ticks, **1,051.249 ms** requests. Maximum recorded dispatch/submission ages were **347.928 / 347.729 ms**, safely below 2,000 ms.
- Serial single-flight, no catch-up burst, retry, answer replacement or post-cap intent. Stop `revoked:true`, `stop_error:null`; `/health` returned v4.5.3 and `sessionActive:false`.

## Limits and next stage

The [v4.5.2 hybrid opening](hybrid-easy-v4.5.2-opening-failure.md) honored 38 family waits then one tribe action and ended in **PlayerExecution enclosure cleanup**, not an incoming combat hit. That artifact is unchanged. The new route removes an unnecessary single-family judgment **before inference**, and v4.5.3 also adds derived territory/border facts. Because **both route and model input changed**, this is not an isolated causal ablation, a win-rate estimate or proof the new observations rescued the bot.

C separately observed an ordinary-income **explicitly mocked** Human City construct/complete and +250,000 internal capacity. This 20-second real run never offered a City; it cannot establish a real Jev City judgment or construction. The next bounded stage must run into genuine affordability and keep model reply, normal build intent, active construction/completion and full-match outcome separate.

No completed Easy/higher-difficulty Jev victory or model-selected City/Post/boat outcome is established. Remain on Easy for competitive validation. Generated logs stay ignored; no credential or Start token is present in this document or the report.
