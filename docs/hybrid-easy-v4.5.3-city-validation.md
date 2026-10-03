# First real Jev City: ordinary-economy Easy land+City run

## What was actually observed

On 2026-10-03, a fresh **160-request real Jev** local Solo run completed the full chain:

**ordinary income → real worker-checked City candidates → Jev branch + opaque site Choice → normal BuildUnit intent → owned construction → completed City → +250,000 internal troop capacity.**

This is the **first verified model-selected City construction/completion**, not the earlier funded fixture, native Switzerland inventory, or ordinary-income mock City. It is **not a completed game or competitive victory**: the run stopped at 160 game seconds/call cap, with no Win event.

Source: land `land-strategy-v4.5.3-territory-survival-buffer` (`b4a1c2c`), flat hybrid `hybrid-branch-v3-defense-post-proposed`, routed loop/final native-submit guards `0d499fe`. Provider replies were `jev-1.13.0`. The same ordinary Easy Europe/Compact training setup and native AI as the [short20 opening](focus-easy-v4.5.3-validation.md) ran from a **fresh world**, not resumed or replayed. No custom funds, scripted/mock choice, heuristic fallback, Copilot, navy or Post execution.

## Actual requests and waits

The ignored artifact is `logs/jev-hybrid-europe-easy-v453-first160.json`. The sidecar `logs/decisions-2026-10-03T12-09-41.116Z.jsonl` held the preceding separate short20 replies followed by these **160 actual replies**. Every stored action/branch/site matches the corresponding sidecar response. Do not count both experiments as one match.

- **157 `/decision`** requests used the direct land Choice because no fresh City family was offered.
- **3 `/hybrid-decision`** requests used genuine fresh City candidates at **1181 / 1331 / 1481**.
- **142 returned waits** were honored, including both first hybrid waits despite their speculative site question preferring `build_city_1`.
- **18 submitted normal intents:** 17 land attacks (13 wilderness, four same-tribe sends) and one City; no nation attack.
- **Tick 146:** our Human `2wiw51xq` conquered tribe `k62i96c9`, **7,200 engine ConquestEvent gold**. No new front during its focus. This differs from the separate short20's tick130/6,400 payout.

## City evidence, step by step

| Reported tick | Actual evidence |
|---:|---|
| 1181 | Gold **125,100**; real current City cost **125,000**. Four actual worker-checked sites offered. Branch **wait** honored; speculative site c1 not executed. |
| 1331 | Gold **140,100**. Fresh four-site proposal; branch **wait** again honored, despite c1 preference. |
| 1481 | Gold **155,100**. Actual Jev branch **city_build**, chosen probability **0.47**, confidence **0.22** (wait 0.44). Actual site **build_city_1**, probability **0.71**, confidence **0.62**. |
| 1482 | Normal `build_unit` turn submitted: **City, tile 712063**, via bounded opaque ID `europe-focus-001/europe-compact@1481#3:c1` and fresh final worker/identity/ownership checks. |
| 1483 | Actual owned **City 26**, level1, active and **under construction**, matching submitted tile; gold **30,300**, capacity **827,369.7697496366 internal**. |
| 1504 | Same City26/tile, active level1, **construction false**; gold **32,400**, capacity **1,077,369.7697496368 internal**. |

The observed capacity difference is **+250,000 internal / +25,000 display troops**. It is not doubled by Easy difficulty. Observed construction→completion spans 21 recorded ticks; configured construction time is 20, with execution initialization/reporting timing. No immediate-completion or direct City combat-defense claim is made.

The low branch confidence was not filtered, resized or substituted. The two earlier returned waits were not retroactively relabeled City decisions. Jev chose only offered opaque IDs, not invented coordinates, code or client tools.

Each proposal examined **256 of 18,530 eligible tiles**, worker-checked/offered **four**, and reported omissions. Candidate c1's owned-land disc score **106**, distance to land/player border **9**, and water component link are **geometric descriptors**, not actual City radius protection, exhaustiveness, tactical safety or conquest prediction.

## Final state, arithmetic and timing

At **tick1601 / 160 seconds**: Human alive, **18,530 tiles**, **920,248 internal reserve troops** (~92,024.8 display), **42,100 gold**, completed City26. Switzerland led the recorded standings with **41,532 tiles**; the Human was not the territorial leader. These are standings, not an engine winner.

Gold reconciles exactly:

`100 initial + 1,598 native ticks ×100 ordinary income +7,200 conquest −125,000 City =42,100`.

Maximum recorded dispatch/submission ages **1,121.479 / 1,121.487 ms**, below the required2,000 ms. Minimum request starts **1,120.387 ms**, native tick starts **100.007 ms**; serial single-flight, paused inference, no catch-up burst or retry. Finally Stop revoked the token with no stop error; `/health` returned idle v4.5.3.

`status:"censored-call-cap"`, `complete:false`, `win:null`, zero Win events. This proves survival past the earlier **38.3-second** enclosure failure in this **different policy/routing experiment**, not isolated causal rescue or a win-rate estimate.

## Reproduction and competitive limits

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --loop --live --max-calls 160 \
  --max-ticks 1700 --minutes 5 --seed europe-focus-001 \
  --output logs/jev-hybrid-europe-easy-v453-first160.json
```

This spends real requests and requires explicit bounded authorization. It starts a new world and session, not a continuation/retry of a stopped experiment.

Easy gives the Human a native starting-troop/relative-capacity advantage. Twelve tribes, fixed spawn and fixed three-nation roster are not the default400-tribe browser world or map/spawn diversity; the engine pauses during inference. See the [competitive audit](competitive-benchmark-audit.md). No held-out seed was used. No completed Easy/higher-difficulty Jev win or real model Post/boat outcome is established; Copilot remains disabled without its explicit server token.

The next stage is a **complete** Easy match with the same disclosed limitations and actual WinCheck/standings, not a claim that one City or survival establishes strength. The current hard cap is300 requests; the source-backed300..302-second timer window advances native empty turns **before quota checks**, allowing a five-minute WinCheck without an illegal305-call cap or substituted model wait.
