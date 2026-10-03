# Hybrid Europe: City seam and bounded routed land+City loop

`scripts/benchmark-hybrid-europe.mts` has **two distinct entry points**. Without `--loop`, the original one-Choice offline City seam remains unchanged: `--mock` only, at most 100 post-setup ticks, no sidecar/provider mode. Explicit `--loop` runs a bounded **land + City + wait** envelope with every offered action implemented. It routes **before inference** to the single land Choice unless fresh worker-checked City candidates exist, then uses the flat hybrid Choice. Navy, Defense Posts, upgrades, decomposed naval inference and Copilot planning are absent and disclosed. C has run no paid loop; A's original 39-response failure is preserved below. The corrected router has offline/fake-upstream evidence only, not a real Jev result.

## Reproduce the genuine native negative case

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --mock --max-ticks 10 \
  --output logs/benchmark-hybrid-europe-city-smoke.json

node --test tests/benchmark-hybrid-europe.test.mjs tests/benchmark-focused-europe.test.mjs
npm test
```

The only existing-file change exposes `runner`, `config`, `UnitType` and a truthful read-only `read()` from `createFocusedEuropeWorld`. Its terrain, seed, spawn, native actors and gameplay loop are unchanged. The new seam imports that same world: production Europe/Compact map4x/map16x, seed `europe-focus-001`, Easy, 12 tribes plus native England/Spain/Switzerland, human `(543,491)`, default gold and five-minute timer. No configured 400k balance, post-snapshot funding, reconstruction of historic paid decisions, or scripted continuation is added.

The stage permits at most 100 post-setup ticks (default 60), uses the shared ≥100 ms tick pacer, and makes exactly **one normalized mock hybrid Choice**. If a City is genuinely offered, the mock chooses its first opaque site; otherwise it chooses wait. This is a disclosed seam test, not a strategy and not a substitute for a real Jev answer. Land choices may appear in the request, but this first executor refuses a non-City/non-wait choice rather than silently sending a land attack. Actual engine state remains paused during the mock decision. The separately explicit `--loop` entry point below does not retain this City-only execution limitation.

## Truthful facade, not core monkeypatching

Core `Player.incomingAttacks()` / `outgoingAttacks()` expose `Attack` objects with methods. Browser `PlayerView` exposes plain `AttackUpdate` records. Giving the core player a replacement incoming/outgoing method would corrupt native execution or falsely hide incoming pressure.

`createHybridEuropeFacade` instead uses cached read-only proxies:

- Incoming/outgoing records are detached `{id,attackerID,targetID,troops,retreating}` values read from actual core methods. Floating internal troops remain unchanged.
- All other core methods retain their real receiver. Friendship methods unwrap proxied players; wrapped units return the same cached owner proxy. The underlying game/player/unit methods are never replaced.
- `buildables(tile,types)` invokes **real** `runner.playerBuildables(playerID,x,y,types)`; `actions(tile,types)` invokes real `runner.playerActions`; borders use the real worker-facing query. Tile/x/y zero are valid. Query inputs and actual returned `canBuild`/`canUpgrade`/decimal BigInt cost are recorded.
- The existing City adapter owns the private ID→tile registry, snapshot freshness, worker legality, funds and single-use Stop/generation guard. The injected callback only queues one normal stamped `build_unit` intent. Queuing, actual turn submission, observed under-construction City, completion/capacity, conquest and Win updates are reported separately.

## Observed Europe/Compact smoke

Tested engine checkout: `bb8af015b515b3b717bd4d901074c5f4c16641cb`. The complete proposal, same-tick `observeFocusedCore` land/focus state and `validateHybridInput` result are retained in ignored `logs/benchmark-hybrid-europe-city-smoke.json`.

| Boundary | Actual native result |
| --- | --- |
| Snapshot | Tick 3, 52 owned tiles, 100 gold, no City |
| Existing adapter scan | 52 eligible/examined sites, eight real worker checks, **zero buildable City candidates** |
| Worker cost | All eight returned `canBuild:false`, `canUpgrade:false`, cost **125,000 gold**; the 100-gold balance is insufficient. Worker false may also represent other engine restrictions; it is not replaced with a guessed reason. |
| Omissions | 52 total: 44 prefilter-limit omissions plus eight not-buildable results; omitted/unexamined sites are not declared illegal |
| Mock answer | Wait, **no normal human intent**, no funding edit |
| Bounded subsequent game | Tick 3→13, gold 100→1,100 from ongoing engine income, zero observed Cities, no Win update; `win:null` |

This native test is an honest **underfunded negative**. It demonstrates the real worker seam and exact-state validation, not successful City construction or a competitive advantage. The funded positive/Stop/ownership/gold/candidate-identity tests use explicitly synthetic core-shaped fixtures. Their mock completion and +capacity do not become native Europe evidence. The independent actual-engine City construction microtest in [`city-adapter-validation.md`](city-adapter-validation.md) used documented configured starting gold and remains a different experiment, not a win.

## Explicit routed land+City loop

```sh
# Short zero-network native-AI transport/land check.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --loop --mock --max-calls 3 --max-ticks 60 \
  --output logs/benchmark-hybrid-europe-loop-smoke.json

# Ordinary game income reaches City affordability; deliberately mock waits
# until a real City site is offered. Approximately 140 seconds of real pacing.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --loop --mock --mock-choice wait-city \
  --max-calls 140 --max-ticks 1500 --minutes 5 \
  --output logs/benchmark-hybrid-europe-routed-default-city-control.json
```

Both controls are explicitly **mock choices**, not fallback strategies for Jev. `first-offered` chooses a genuinely offered City if present, otherwise the first offered land attack or wait; `wait-city` selects City when offered and otherwise wait. `--mock-choice` is forbidden in live mode. Mock mode never calls health, Start, decision or Stop over HTTP.

The loop uses persistent City and actual `createGameAdapter` land envelopes through the truthful facade. A cheap real `config.unitInfo(City).cost(game,human)`/BigInt-balance preflight skips expensive placement scans only when a City is objectively unaffordable. On becoming affordable it scans immediately; subsequent heavy scans are bounded to 150 ticks (15 simulated seconds), or 50 ticks when no City is found, as in the browser cadence. Stale or changed-balance proposals are not offered as current City facts; expiry is disclosed in each decision record. It does **not** run a whole-map scan every decision.

The pure `routeLandCityRequest` checks validated candidate availability before asking: zero currently usable City candidates → **exact raw land observation**, `buildRequest`, `/decision`; fresh nonempty City candidates → validated hybrid envelope, `buildHybridRequest`, `/hybrid-decision`. This matches the browser controller's family routing, not its advancing-game behavior. There is no speculative land answer to promote after a hybrid wait.

Land replies retain their actual normalized `{action,confidence,probabilities,model,…}` shape and are revalidated with `parseDecision` against the exact offered `action.criteria`; no hybrid branch/context is invented. Hybrid question/Choice, branch/site ID and context are checked against the exact hybrid request. Schema-v2 records include `inference_route`, `model_reply_type`, `request_payload`, `decision_attempted`, actual `model_reply` and separately `validated_choice`. A planned payload is not evidence it was sent. Malformed HTTP-200 JSON replies remain in `model_reply` even if the shared client rejects them; `received_local_json_responses` distinguishes those from client-successful replies. Neither counter establishes a validated intent or paid billing. Wait/save is honored; unoffered/stale/changed-cost choices fail closed, with no alternate target, resize or implicit City purchase. All offered land actions have a real worker legality check and normal stamped `attack` submission. Focus/progress uses the shared helpers; counters are promoted only **after normal turn submission succeeds**, retaining the pre-inference decision-observation reference tick/tiles. The normalized model reply, whether an intent was queued, its submitted engine tick and actual City inventory events are separate records. Errors retain partial evidence and still attempt Stop.

### Positive actual-engine City result, still mocked—not Jev

The historical default-economy `wait-city` artifact predates the router correction and new wall guard; it is not new-guard or real-provider evidence. It used the same fresh seed/terrain/12 tribes/three native Easy nations, **no gold/troop injection and no human attack**. In source policy `land-strategy-v4.5.2-neighbor-structure-facts`:

| Boundary | Actual human City result |
| --- | --- |
| Initial state | Tick 3, 52 tiles, 100 gold, no City, capacity 121,410.75598 internal |
| Mock answer | At tick **1261**, gold **125,900**, worker cost **125,000**, selected opaque `europe-focus-001/europe-compact@1261#1:c1` |
| Normal submission | One `build_unit`/City intent submitted in tick **1262**, tile `712022` |
| Observed construction | Human City unit **18** at that exact tile, under construction at **1263**, gold **1,100**, unchanged capacity |
| Observed completion | Level 1, no longer under construction at **1284**, gold **3,200**, capacity **371,410.75598** internal: approximately **+250,000 internal** (floating-point precision), not a direct troop injection |
| Final bounded state | Tick **1401** / 140 simulated seconds, human alive with **52 tiles**, gold **14,900**, one completed City; 140 mock replies (139 wait, one City), zero provider attempts, zero human tribe ConquestEvents, no Win update |

The tick-1261→1263 wallet delta is −124,800: −125,000 City cost plus 200 ongoing worker income. Switzerland had 33,810 tiles and Spain 29,095 at the final snapshot; the human's completed City is **not a match victory or competitive strength result**. The report is `censored-call-cap`, `complete:false`, `win:null`. Easy difficulty is not a neutral nation comparison: nation capacity uses the configured Easy scaling relative to the human; there is no separately injected human buff, and the absolute human City gain is the configured 250,000 internal. The fixed France spawn/trio/12-bot setup is also not the production default nation/bot roster.

A separate three-request mock loop reproduced the previous native opening (three normal wilderness intents, 52→326 tiles), with no City construction or victory. The originally underfunded one-Choice seam, funded synthetic unit tests, actual mock-selected human construction above, native Switzerland inventory parity audit and A's independent real Jev tribe conquest are **different experiments**; none should be relabeled as another.

### Preserved original real-model failure: extra hybrid branch

A authorized one ordinary-economy 160-call-cap attempt on `e466655`, saved unchanged in ignored `logs/jev-hybrid-europe-easy-v452-first160.json` (SHA-256 `daf19393f192cd33c289d1954a7524e421420210deca8c51702958ebbe6fdeee`). It ended at tick **384 / 38.3 seconds**: **39 real replies, 38 hybrid-branch waits and one 10% tribe-11 land choice at tick 381**, normally submitted at 382. Human territory fell **52→0**; no City was affordable/offered, no Win update, `complete:false`, and Stop revoked the session. Every wait was honored. No speculative land answer was executed or retrospectively relabeled.

That code always asked a hybrid branch even when land was the only action family. The browser instead calls its land-only decider when no City/naval/Post candidate is available. Thus this failure is **not browser-routing-equivalent**. The corrected router removes that extra pre-inference question, not a returned wait. It does not establish what Jev will choose under the corrected request, avoid the loss by assertion, or prove a win. Source-backed conquest-vulnerability facts are a separate change, not part of this routing fix.

The new router's short actual-engine **mock** control (`logs/benchmark-hybrid-europe-routed-mock3.json`, policy v4.5.3) posted no HTTP/provider calls: three single-land mock `attack_wilderness_10` choices, normal submissions at ticks 4/12/22, 52→326 tiles, no City and no winner. Unit tests include an actual ephemeral local server with **mocked upstream**, proving hybrid Start permits `/decision` and Stop revokes it; this is not paid inference.

### Corrected live route implemented, no new paid execution by C

```sh
# EXAMPLE ONLY. A/Moritz must authorize the budget and exclusive sidecar slot.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --loop --live --max-calls 140 \
  --max-ticks 1500 --minutes 5 --output logs/benchmark-hybrid-europe-live.json
```

Live requires an explicit 1..300 call cap, matching land/hybrid policy versions, hybrid enabled, credentials configured, Copilot disabled, explicit Start required and an idle local service. It acquires one `/session` with `mode:"hybrid"`, then uses only the preselected loopback `/decision` or `/hybrid-decision`; the existing hybrid session authorizes both. The shared request client enforces real ≥1000 ms starts and single-flight; native tick starts remain ≥100 ms. The engine is **paused during inference**, unlike an advancing browser game. The dispatch guard enforces **≤2,000 ms wall age** from the earliest captured payload (before preparation/scans), including request pacing, inference and final worker checks. It also requires the same current tick (stronger than the project's ≤20-tick ceiling); a paused engine is not permission to execute a 2.1-second-old reply. Already-stale preparation is rejected before asking, and the transport rechecks after request pacing before any POST. The native world's optional `step(intents, submitGuard)` checks that same guard **after native tick pacing, before `addTurn`**, for nonempty intents only. A typed stale failure performs no `addTurn`, no `executeNextTick`, no submitted counter or history promotion; `tick_starts_ms` contains executed ticks, not a failed submission attempt. Historical one-argument calls and empty native-AI/wait turns retain their behavior. Such blocked requests consume zero attempt count and cannot be relabeled fresh. Replies that become stale during inference or final worker checks retain their returned Choice but produce zero normal intents and `censored-stale`; there is no timestamp refresh or substitute. Tests also queue land/City at 1,999 ms, add 100 ms of native pacing, then observe zero actual submissions/advancement and Stop. Their report truthfully separates the earlier internal queue (`normal_intent_queued:true`) from zero stamped submissions. Tokens stay closure-local; `finally` attempts `/session` Stop on normal completion, quota, model error, validation error, stale reply, cancellation and even a known-token malformed Start. No retry follows 529/timeout/Stop failure. Local attempts/responses are not independently verified paid-call counts.

Completion requires the actual native Win update and winner, not human elimination or a call/tick cap. Final standings include all players' alive/type/territory/army/gold/capacity. The report describes the actual FFA `WinCheckExecution`: every tenth tick, largest alive territory wins after the configured timer/hard limit or a strict share of non-fallout land; the current share threshold and land denominator are saved. A capped run never silently switches to scripted continuation. Human elimination before a Win update stays incomplete/`win:null`.

No navy/Post/decomposed/Copilot executor or replay of the historical 90-call real-model artifact is implemented. Any later replay must use exact historic normal intents and assert final hashes; no stronger reserve/gold state is fabricated here.
