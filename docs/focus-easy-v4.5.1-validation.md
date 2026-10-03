# Easy tribe conquest: first real v4.5.1 finish and gold

## What was observed

On 2026-10-03, an explicitly Start-gated, **90-decision** `land-strategy-v4.5.1-reference-clock-clarity` run against an actual OpenFront `GameRunner`/`Executor` finished one native tribe and received its **7,350 gold** conquest payout. It stopped and revoked its sidecar session at the request cap. **It did not finish or win the match.**

This is stronger evidence than a mocked action or a favorable fixed-snapshot judgment: the real Jev decisions produced normal land intents, the engine emitted an actual ConquestEvent for our player, and the persistent focus cleared only after authoritative target death.

## Reproducible scenario

- Engine source: `bb8af015b515b3b717bd4d901074c5f4c16641cb`.
- Agent source for the run: `b22fb0d` (policy/reference semantics) plus `589da31` (bounded benchmark); other independent docs/experiments landed while it ran.
- Production **Europe / Compact**, fresh `map4x.bin` and `map16x.bin`.
- Seed: `europe-focus-001`; human spawn **(543,491)**, ordinary configured gold/troops.
- **12 native tribes** and **3 native Easy nations**: Spain at (442,666), Switzerland at (654,484), England at (503,381). Native AI executes on every engine tick.
- Five-minute match timer, but explicit 90-response and 1,000-live-tick caps. This run was censored at the call cap after 90 game seconds, not at WinCheck.
- **Land only, headless**: same shared observation/menu/focus helpers, actual normal intent pipeline. Engine ticks pause during inference; this is **not** a browser-cadence equivalence claim. City/naval/Post proposals are not part of this harness yet.

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-focused-europe.mts --live --max-calls 90 \
  --max-ticks 1000 --minutes 5 --seed europe-focus-001 \
  --output logs/jev-focused-europe-easy-v451-first90.json
```

This command spends real provider requests. Only run it under an explicitly authorized, bounded local experiment with an idle compatible sidecar. No automatic retry or heuristic fallback is implemented. An initial invocation missing `--tsconfig` failed on the upstream `resources` alias **before game setup/Start/inference**; it was manually corrected, not a provider retry.

## Decisions, normal intents and conquest

The final artifact contains **90 successful local responses**. Independently checking `logs/decisions-2026-10-03T10-14-02.243Z.jsonl` found exactly 90 real, non-probe, v4.5.1 structured Jev replies, with identical chosen action IDs.

| Chosen action | Count |
|---|---:|
| Wilderness 20% | 8 |
| Tribe 11, 20% | 3 |
| Wait | 79 |

Our stable core player ID was `2wiw51xq`; tribe 11's was `k62i96c9`.

| Decision observation tick | Target tiles / display reserve | Our display reserve | Normal 20% intent submitted tick | Internal troop payload |
|---:|---:|---:|---:|---:|
| 91 | 733 / 846 | 4,779 | 92 | 9,559 |
| 101 | 676 / 831 | 4,302 | 102 | 8,605 |
| 131 | 290 / 403 | 4,918 | 132 | 9,836 |

Display reserves are floored observation units; the actual fractional core reserve is used to calculate the integer normal intent payload. Do not reconstruct payloads by multiplying the floored display observation by ten.

- **Tick 149:** actual engine ConquestEvent, conqueror `2wiw51xq`, conquered `k62i96c9`, gold **7350**.
- **Tick 151:** authoritative dead focus observation; only then was the persistent objective released.
- No other tribe, nation or wilderness attack opened during the selected tribe's unfinished focus.
- No nation action was emitted anywhere in this run.

The progress reference was tick 91 / 733 tiles, associated with the first successfully emitted land intent. These are the **pre-inference decision-observation baseline**, not emission time. `reference_tick_semantics` says `decision_observation_snapshot_not_emission_time`; elapsed ticks mean time since that observation. Territory change is factual, not exclusively attributed to our attack. Emitted-intent counts are not accepted/completed attack counts. The ConquestEvent, rather than those counters, establishes this conquest and payout.

## End state and safety

- Actual game ticks: **3 → 901**, 898 live ticks; elapsed game seconds **90**.
- Tiles: **52 → 9,919**.
- Internal reserve: **25,330 → 554,559** (about **55,455.9 display troops** at end).
- Gold: **100 → 97,250**; **7,350** is verified tribe bounty. The remainder must not be labeled conquest gold.
- Human alive, **zero engine Win events**, `complete:false`, `win:null`, `status:"censored-call-cap"`.
- Measured minimum tick-start spacing **100.005 ms**; request-start spacing **1,112.376 ms**. Calls are awaited serially; no catch-up burst, retry or answer replacement occurred.
- Session `started:true`, `revoked:true`, `stop_error:null`; final `/health` reports `sessionActive:false` and the v4.5.1 policy.

Later decisions were predominantly waits while legal wilderness and nation options existed. This is not evidence of optimal play or competitive performance. Building capacity, nation resistance and whole-conquest planning remain important gaps.

## Limits and next stage

This satisfies the narrow **Easy tribe-finish-and-gold** milestone on one seed. It is **not** a completed Easy win, a higher-difficulty result, a City/Post/boat outcome, a Copilot-guided plan, or a win-rate estimate.

The earlier [v4.4 50-call Easy browser run](focus-easy-v4.4-validation.md) had 400 tribes, five nations, a random spawn and browser timing. Its six 10% sends failed to finish a growing tribe. The new scenario differs: **do not claim a controlled v4.4→v4.5.1 improvement or attribute this success solely to the prompt/history change.** v4.5.1 selected 20% from the first attack here; it was not observed escalating after repeated failed 10% sends in this run.

Next: a separately tested genuine-engine **hybrid City seam**, then longer seeded Easy matches with actual building/boat/conquest outcomes. Remain on Easy until complete victories are established, before Medium/Hard/Impossible. D's [one-send nation study](nation-one-send.md) rules out treating a favorable current-reserve ratio as a guarantee of full conquest.

Generated raw artifacts stay ignored under `logs/`; credentials and Start tokens are not part of this document or the benchmark report.
