# City and Defense Post: isolated OpenFront engine measurements

`scripts/analyze-structures.mts` compares **fresh, paired real-engine simulations** on a synthetic 256×256 all-plains map. It uses actual `Config`, `GameRunner`/`Executor`, `PlayerExecution`, normal `build_unit`/`upgrade_structure`/`attack` turns, and worker-facing `playerBuildables` checks. The combat defender is a **passive human** with real troop regeneration but no AI/counterattack; there is no Jev/Copilot call, no upstream edit, and **no win-rate claim**. Source was checked against sibling OpenFront commit `bb8af015b515b3b717bd4d901074c5f4c16641cb`.

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/analyze-structures.mts
```

Output is ignored `logs/structure-mechanics.json`. Two runs gave byte-identical JSON. All troop counts below are **internal** game units (divide by 10 for display).

## City: capacity, growth and economics

`src/core/configuration/Config.ts:355,1013-1075` gives a completed City's **250,000 capacity per level** in internal troops, added to the territory-based capacity. Under-construction Cities do not count. The City's increased capacity changes `troopIncreaseRate` through `1 - troops / maxTroops`; it does **not** add a flat 250,000 troops or an independent income stream. `PlayerExecution.ts:87-90` applies that rate and worker gold each active tick.

The City and no-City games each began with 2,500 owned tiles, 100,000 troops, 400,000 funded gold and identical turns. A worker-legal City click on owned land `(75,100)` cost **125,000 gold** (`Config.ts:659-668`); the normal intent created an under-construction unit at game tick 2. It finished at tick **23** (configured duration 20 ticks, with the execution queue/completion boundaries included). Capacity remained **318,672.4** while constructing, then rose to **568,672.4**. A normal upgrade on the next turn cost **250,000 gold**, raised level 1→2 at tick **24** and capacity to **818,672.4**; the City is upgradable, unlike a Defense Post (`UpgradeStructureExecution.ts:16-36`).

| After 100 game ticks | No City | Completed level-1 City | Level-2 City (upgrade at tick 24) |
| --- | ---: | ---: | ---: |
| Capacity (internal) | 318,672.4 | 568,672.4 | 818,672.4 |
| Troops (internal) | 178,357 | 203,828 | 215,440 |
| Current calculated growth / tick (internal) | 754.5 | 1,211.3 | 1,448.3 |
| Gold | 409,900 | 284,900 | 34,900 |

**Observed troop gain** over the paired no-City game at tick 100: **+25,471 internal** for level 1. Upgrade to level 2 added a further **+11,612 internal** versus level 1 by that tick. These are short, isolated growth measurements, not a construction-payback or strategic first-build recommendation. Starting with zero gold and **no conquest/trade**, the same 100-gold-per-active-tick worker income first made a Defense Post's 50,000 gold affordable after **501 engine turns**, and a City's 125,000 gold after **1,251 turns** (the first turn initializes `PlayerExecution` before the first worker payment). Live conquest and trade can shift affordability substantially.

## Defense Post: fixed-input formula versus actual attack

`Config.ts:374-383,875-877` sets radius **30**, defender terrain-loss magnitude **×5**, and tile-cost/time fraction **×3** *when an active completed defender-owned Post covers the attacked tile*. `AttackExecution.ts:339-365` computes that flag separately **for each target tile**, and `UnitGrid.ts:205-245` uses actual range/owner and excludes under-construction units. These are per-tile combat modifiers, **not** a guarantee of 5× total casualties or exactly 3× wall-clock attack duration. The current `DefensePostExecution.ts:46-98` has ship-targeting shell logic commented out; this test measures the land-defense aura, not shells.

Paired games prepared the *same* adjacent attacker and defender rectangles (2,500 tiles each), waited **65 ticks**, reset armies to 200,000/50,000 troops immediately before one normal **60,000-troop** land attack, and advanced 120 attack ticks. Only the protected variant built a **worker-legal** defender Post at `(110,100)` for **50,000 gold** (`Config.ts:637-644`). It appeared at game tick 2 under construction and completed at tick **53** (configured 50 ticks). The target front at `(100,100)` was within its actual range before the attack; the control had no Post. Posts cannot be upgraded; the next Post's calculated cost is 100,000 gold.

A **pure paired call** to the real `Config.attackLogic` with *identical* attacker/defender/terrain/troop/border inputs except `defenderHasDefensePost` produced exact `attackerTroopLoss` ratio **5.0** and `tickFraction` ratio **3.0**. This is formula evidence. Separately, the real attack path made **183 protected per-tile logic calls** in the Post run and zero protected calls in the control. The two live simulations diverged as combat progressed:

| Ticks after attack | Defender tiles, no Post | Defender tiles, completed Post |
| ---: | ---: | ---: |
| 10 | 2,205 | 2,409 |
| 30 | 1,811 | 2,335 |
| 60 | 1,618 | 2,317 |
| 120 | 1,574 | 2,317 |

The attack had ended by 120 ticks in both cases; one Post preserved **743** more defender tiles under these fixed conditions. The recorded sum of `attackLogic.attackerTroopLoss` is **not actual total casualties**: the attacking stack is finite, per-tile state changes, troops regenerate, and the post stops the attack earlier. Do not multiply this one scenario's outcome by five or three for other geometries. Defense Post value depends on **worker-legal site coverage of the actual attack front**, construction finishing *before* contact, available gold, and the size/route of the incoming force. A derived candidate descriptor should report coverage and cost as facts, not infer a guaranteed win or quietly choose a build for Jev.
