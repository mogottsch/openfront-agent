# Hybrid Europe: first offline City integration seam

This is deliberately **not yet a full hybrid match harness**. `scripts/benchmark-hybrid-europe.mts` makes one explicit mock City-or-wait Choice on the fresh native Europe/Compact Easy world, then observes a bounded number of normal engine turns. City wiring is established before adding naval/Post actions or multi-decision/provider execution. It supports **`--mock` only**; `--live` is rejected before game setup. No sidecar Start, TypeSafe, Copilot or browser controller is used.

## Reproduce the genuine native negative case

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --mock --max-ticks 10 \
  --output logs/benchmark-hybrid-europe-city-smoke.json

node --test tests/benchmark-hybrid-europe.test.mjs tests/benchmark-focused-europe.test.mjs
npm test
```

The only existing-file change exposes `runner`, `config`, `UnitType` and a truthful read-only `read()` from `createFocusedEuropeWorld`. Its terrain, seed, spawn, native actors and gameplay loop are unchanged. The new seam imports that same world: production Europe/Compact map4x/map16x, seed `europe-focus-001`, Easy, 12 tribes plus native England/Spain/Switzerland, human `(543,491)`, default gold and five-minute timer. No configured 400k balance, post-snapshot funding, reconstruction of historic paid decisions, or scripted continuation is added.

The stage permits at most 100 post-setup ticks (default 60), uses the shared ≥100 ms tick pacer, and makes exactly **one normalized mock hybrid Choice**. If a City is genuinely offered, the mock chooses its first opaque site; otherwise it chooses wait. This is a disclosed seam test, not a strategy and not a substitute for a real Jev answer. Land choices may appear in the request, but this first executor refuses a non-City/non-wait choice rather than silently sending a land attack. Actual engine state remains paused during the mock decision; later provider pacing/session work has not been enabled.

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

## Scope left for the next stage

There is no navy/Post executor, live session transport, decomposed request mode, paid request quota loop, full-match result or replay/resume of A's real 90-call history here. Those require a separately scoped extension with the same opaque adapter IDs, actual worker checks, shared focus/progress rules, Start/Stop, request/tick pacing and independent unit/landing/conquest/Win evidence. In particular, recreating the recorded 90-call history later must use its exact normal intents and assert engine hashes; this stage does not fabricate its stronger reserve/gold state.
