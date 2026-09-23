# Paired Onion boat-payload sweep (native Impossible nations)

This is an **offline deterministic control**, not Jev, Copilot, or a browser controller. It uses fresh production Onion maps and OpenFront's real `GameRunner`/`Executor`/Impossible-difficulty nation AI. No model/API requests or upstream edits. It does **not** add boat observations or actions to the deployed bot. TypeSafe's current HTTP 529 responses do not affect this network-free benchmark.

## Run and scope

```sh
# One seed, 650 live ticks: intentionally censored, includes the first crossing.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-naval-control.mts --smoke --output logs/benchmark-naval-sweep-smoke.json

# Three paired seeds × 10/20/30% boat payloads, complete five-minute WinCheck matches.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-naval-control.mts --output logs/benchmark-naval-sweep-full.json
```

`--seeds bench-004,bench-005` chooses distinct IDs; `OPENFRONT_DIR` overrides `../OpenFrontIO`. Output under ignored `logs/` must not be committed. Each seed runs the existing `fixed20-wilderness` baseline once (from `scripts/benchmark-baseline.mts`), then three fresh paired games with the **same land control** plus boats at 10%, 20%, or 30% of available troops. The added control waits until the initial 6,505-tile island is completely owned. It samples **eight pinned outer-ring clicks** in fixed order, taking only the first *unowned wilderness* destination for which actual `player.canBuild(TransportShip,dst)` and worker `playerBuildables` agree. The resolved landing must also be unowned. The 30% boat test never targets a tribe: the tribe ≤20% rule applies to tribe attacks, not these wilderness landfalls. A second boat must leave at least 20 simulated seconds after the first; an unavailable sample is retried no sooner than five seconds. These are scripted fractions, **not model choices or an action override**.

Every seed/fraction uses the same game ID, human spawn `(400,280)`, native nation IDs and spawn coordinates, config, and fresh map; pairing is checked. Each requested payload is recorded alongside the **actual transport-unit payload** (`actualBoatTroops`), whether the unit launched, its first observed landing ownership tick, whether the shore remained owned at the final tick, final human tiles/troops, and the engine's actual Win update. An intent is not a launch; a landfall is not durable control; neither is a win. A capped smoke has `win:null`, not a loss. Full runs exit nonzero if any pair lacks a Win update. Exact shore legality and the port-free route are documented in `docs/naval-mechanics.md` (OpenFront checkout `bb8af015b515b3b717bd4d901074c5f4c16641cb`). Candidate discovery is intentionally bounded, not optimized.

## Observed local results (three seeds, five-minute timer)

All **nine** boat matches and three unique land-only matches ended on the engine's five-minute WinCheck. Human wins: **0/3 land-only; 0/3 at every boat fraction**. Each boat match launched and landed two boats (six launches/landfalls per fraction), but landing ownership by the timer differed. The first boat left at second **46** for `(423,276)`; the second at second **66** for the same seed-specific shore across all three fractions. Thus timing, seed, and the sampled destinations matched within seed. Native responses and subsequent land battles can diverge after the different payloads.

| Seed | Land-only final tiles | 10% final tiles | 20% final tiles | 30% final tiles | Landing shores owned at timer (10/20/30%) |
| --- | ---: | ---: | ---: | ---: | --- |
| `bench-001` | 6,505 | 6,505 | 6,505 | 6,505 | 0 / 0 / 0 |
| `bench-002` | 5,038 | 20,873 | 5,946 | 6,505 | 2 / 0 / 0 |
| `bench-003` | 0 | 0 | 0 | 0 | 0 / 0 / 0 (human eliminated) |

The first requested and actual unit payloads were **2,904 / 5,809 / 8,714 internal troops** (290.4 / 580.9 / 871.4 displayed) for 10 / 20 / 30%. The second payloads varied modestly with the changed game state: about 1,491 / 2,873 / 4,133 internal troops. The first send began with only 29,047 internal available versus capacity near 488,131; a 30% boat left 70% of an already depleted reserve. The land-only control continues to send 20% toward wilderness even after the island fills, and the boat control preserves that behavior, so this sweep does **not** test a reserve-aware land policy. At the 650-tick censored smoke, all three first boats had landed; human tiles were 9,914 / 9,802 / 9,673 respectively. Those are early territory snapshots, not match results.

The 10% version retained two landing tiles and more total land in **one** seed; 20% and 30% retained none across these three. This is source-grounded sizing evidence for this narrow control, **not** proof 10% is optimal or that a model should choose it. The native AI reacts to different troop commitments, second-send troop pools differ, and subsequent fixed-20 land sends couple the outcomes. No fraction improved the 0/3 human win count.

**Next decision boundary:** a future model-controlled boat would need reviewed destination candidates (shore/water connectivity, ownership, legality, troops, fleet cap, route) and a boat action, with fresh worker checks at execution. The current land-only Jev observation cannot select a destination tile or compare water routes. Do not silently encode this coast list, launch time, or any fraction as a live strategy.
