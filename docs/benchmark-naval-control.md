# Paired Onion boat-control benchmark (native Impossible nations)

This is an **offline deterministic control**, not Jev, Copilot, or a browser controller. It uses a fresh production Onion map and OpenFront's real `GameRunner`/`Executor`/Impossible-difficulty nation AI for each run. No model/API requests or upstream edits. It does **not** add boat observations or actions to the deployed bot.

## Run and scope

```sh
# One seed, 650 live ticks: intentionally censored, includes the first crossing.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-naval-control.mts --smoke --output logs/benchmark-naval-smoke.json

# Three paired seeds, complete five-minute engine WinCheck matches.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-naval-control.mts --output logs/benchmark-naval-control.json
```

`--seeds bench-004,bench-005` chooses distinct IDs; `OPENFRONT_DIR` overrides `../OpenFrontIO`. Output under ignored `logs/` must not be committed. Each pair compares the existing `fixed20-wilderness` control (from `scripts/benchmark-baseline.mts`) with **the same** 20%-of-available-troops wilderness send every simulated second **plus at most two transport sends**. The boat control waits until the initial 6,505-tile island is completely owned; then it samples the **eight pinned outer-ring clicks** printed in the JSON in fixed order, accepting only the first real `player.canBuild(TransportShip,dst)` and worker `playerBuildables`-verified candidate. It submits a normal stamped `{type:"boat",dst,troops}` intent at **10% of then-available troops**, retaining 90% of that pool; a second send must be at least 20 simulated seconds later. An unavailable sample is retried no sooner than five seconds. This is a bounded scripted control, not a model's selected action or an optimized naval policy. It still makes the baseline's wilderness sends, even after the island fills; therefore reserve can be low despite each boat's modest fraction.

For every pair, identical seed/human spawn `(400,280)`/native nation IDs, coordinates, configuration and fresh maps are checked. The script records candidate checks, requested boat-intent payloads and actual transport-unit troop payloads (`actualBoatTroops`), unit creation (`launched`), first observed landing ownership tick (`landedTick`), whether the destination remains human-owned at the final tick, and the engine's actual Win update separately. A boat intent is **not** automatically a successful launch, a landing is **not** durable ownership, and neither proves victory. `win:null` on a capped smoke is not a loss; full runs exit nonzero if any pair lacks a Win update. Exact landing/shore legality and the zero-port requirement are source-grounded in `docs/naval-mechanics.md` (OpenFront checkout `bb8af015b515b3b717bd4d901074c5f4c16641cb`). The candidate sample is intentionally narrow, not exhaustive route optimization; the normal intent carries a tile ref, not a player ID or source shore.

## Observed local results (three seeds, five-minute timer)

Six completed engine matches (three paired seeds) ended at the native timer, not at the 650-tick smoke cap. **Human wins: 0/3 for fixed-20 and 0/3 for fixed-20 plus boats.** Two boats launched and reached their sampled shores per naval run; the native winner remained a nation. Outcomes from the generated JSON:

| Seed | Fixed-20 human tiles | Plus-boats human tiles | Naval landing vs final ownership | Engine winner (naval) |
| --- | ---: | ---: | --- | --- |
| `bench-001` | 6,505 | 6,505 | Both landed; both destination tiles later lost | Outer Enclave |
| `bench-002` | 5,038 | 20,873 | Both landed and remained owned at timer | Leafer Confederation |
| `bench-003` | 0 | 0 | Both landed; both destination tiles later lost; human eliminated | Leafer Confederation |

On all three seeds the initial island filled at simulated second 46. The first boat targeted `(423,276)` at second 46 with 2,904 internal troops (290.4 displayed); the second left at second 66 with 1,491 internal troops (149.1 displayed) for another legal outer-ring shore. These sends were **10% of available troops**, not of capacity; first-send reserve was 29,047 internal against a capacity near 488,131, so retaining 90% of an already low reserve did not guarantee strategic safety. This is a small, partly coupled comparison: outcomes differ because boat landings enable subsequent wilderness attacks under the same fixed-20 control, and nations may respond differently. The +15,835 end tiles on one seed do **not** establish a win-rate gain or make two modest boats sufficient against Impossible. No economic/structure action was added, and none of this supplies a Jev choice/intent history.

**Next decision boundary:** a future model-controlled boat needs a reviewed destination-candidate observation (shore/water connectivity, ownership, legality, available troops, fleet cap, estimated route) and a new boat action, plus fresh worker legality and normal intent submission. Current v4.2 land observation cannot choose a tile ref or compare water routes. Moritz/A must agree on those additions before this scripted control informs the live policy; do not silently encode the fixed coast list or boat timing as a model strategy.
