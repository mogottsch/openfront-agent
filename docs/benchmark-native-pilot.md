# Native Impossible AI pilot: Onion FFA control, not a model win

`scripts/benchmark-native-pilot.mts` runs the **actual OpenFront NationExecution** as a fourth Impossible nation in the starting position previously occupied by the human. This is a no-model, no-API benchmark: Jev/Copilot never selects or executes any action. It is a **native-AI pilot/comparator**, not a proven upper bound on optimal play, an A/B strategy isolation, or evidence that our bot has won. Source checkout: `bb8af015b515b3b717bd4d901074c5f4c16641cb` (see `src/core/execution/NationExecution.ts`, `src/core/GameRunner.ts`, `src/core/game/NationCreation.ts`, `src/core/execution/SpawnExecution.ts`). The sibling OpenFront repository is never edited/pushed.

```sh
# One seed, intentionally censored at 650 gameplay ticks (~65 simulated sec).
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-native-pilot.mts --smoke --output logs/native-pilot-smoke.json

# Three paired seeds through actual five-minute WinCheck.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-native-pilot.mts --output logs/native-pilot-full.json
```

`--seeds bench-004,bench-005` selects distinct IDs. Reports under ignored `logs/` are not committed. The full default run completed all three pairs in seconds of wall time (unpaced headless simulation, not real-time gameplay); repeated reports were byte-identical.

## Comparability and mechanics boundary

For each seed the harness consumes the original human slot's RNG-generated **string player ID**, adds a native Impossible nation in **smallID 1**, then adds the three original manifest nations with the **same string IDs and spawn coordinates** as `scripts/benchmark-baseline.mts`. These are checked against the fresh fixed-20%-wilderness human game. The native pilot's `NationExecution` first takes its seeded spawn near `(400,280)`; a single trusted `SpawnExecution` relocates it to **exactly `(400,280)`**, then the Singleplayer spawn phase is ended explicitly because there is no human click. Once active, all pilot land, boat, structure, diplomacy, growth and timing are engine-native. Normal `GameRunner`/`Executor`/WinCheck ticks and new fresh map instances apply to both worlds.

This is **not perfect human-slot parity**: the human was PlayerType.Human, with default 25,000 internal starting troops, human capacity and no native AI; the pilot is PlayerType.Nation, with Impossible 31,250 starting troops, **1.25× capacity** and **1.05× growth** (see `Config.ts:994-1067`), native structure/naval/diplomacy behavior, and an extra ~three setup ticks to allow natural nation spawns plus forced relocation. The compared opponents have paired IDs and positions, but NationExecution's decisions can diverge when the pilot changes the game, and the native pilot's initial random spawn plus relocation is not the same human click. No core edit or authority switch can make a native NationExecution literally be a Human while retaining all rules; therefore this comparison must **not** be read as the isolated value of a policy or a Jev victory.

## Complete five-minute timed FFA outcomes

| Seed | Fixed-20 human final tiles | Native pilot final tiles / land share | Native winner | Pilot City first created | Pilot transports observed / destination-owned after inactive |
| --- | ---: | ---: | --- | --- | ---: |
| `bench-001` | 6,505 | 75,846 / 36.02% | Leafer Confederation | 125.5 s | 5 / 5 |
| `bench-002` | 5,038 | 12,106 / 5.75% | Leafer Confederation | 126.5 s | 7 / 7 |
| `bench-003` | 0 | 15,843 / 7.52% | Outer Enclave | 125.3 s | 7 / 7 |

**Human wins 0/3; native pilot wins 0/3**. All six matches received the engine's actual `Win` event at the timer. The native pilot preserved substantially more territory than the land-only human in these seeds, but **still did not beat the other Impossible nations**. One seed's native winner changed versus the human control because players interact after pairing. The `boatsLanded` metric is deliberately conservative: it records a target tile owned by the pilot only when the specific transport has become inactive and was not marked enemy-destroyed; it is an observed-state indicator, not a guaranteed causal conquest record or proof the tile remained held at timer. The report includes every boat's launch tick, internal troop payload, source/destination, first observed target ownership, 30-second troop/land/gold/structure snapshots, final standings for all players, and final pilot gold/troops/share. Internal troop units divide by 10 for display.

### Timing and economic observations, not prescriptions

- The native pilot opened with a normal wilderness attack at **0.1 simulated second** after its spawn, using 15,625 internal troops (half of its 31,250 starting nation troops). This is the AI's own `forceSendAttack` from `NationExecution.ts:179-184`, not a Jev action or a recommendation to copy it.
- First observed transport: 52.2 s on `bench-001`, 8.8 s on `bench-002`, 51.4 s on `bench-003`. The AI also sent later boats. A created boat is not necessarily a durable foothold or a winning position.
- First observed City construction was around **125–127 seconds** in every seed, after worker income and other gameplay; City completion was about two seconds later. Later Defense Posts were observed (three / three / one respectively). On `bench-001` at final timer the pilot held 872,149 internal troops, 25,500 gold and 75,846 tiles; on `bench-002` 797,325 troops, 25,500 gold and 12,106 tiles; on `bench-003` 1,265,142 troops, 125,500 gold and 15,843 tiles. These are outcomes, not standalone proofs that City-first, a particular boat size, or a Defense Post site caused survival.

A fair next strength assessment needs held-out seeds/maps, multiple native-AI pilot spawns and a real model-controlled completed match using the *same allowed observations/actions* as the candidate bot. Do not substitute native actions for Jev decisions, infer a win from this territory lead, or call the native pilot an unbeatable ceiling.
