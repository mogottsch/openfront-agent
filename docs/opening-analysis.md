# Opening reserve strategy: engine-based comparison

2026-09-20. These results are deterministic engine-policy comparisons, not Jev runs. The later `wilderness-reserve-v2` prompt adopted the 30% reserve strategy; its live adherence was evaluated separately. Current v3 deliberately removes prescribed strategy while expanding observations and actions. These historical benchmark results are not rules used by v3.

## Recommendation

For an unopposed wilderness opening, start by targeting **30% of current troop capacity in reserve**, rather than continuously sending 20% or rigidly holding the exact 42% growth peak.

Check once per second. Let `r = availableTroops / troopCapacity`:

- **Wait** while `r <= 0.30 / 0.95` (about **31.6%**).
- **Send 10%** when above that threshold but at or below `0.30 / 0.85` (about **35.3%**).
- **Send 20%** above the latter threshold.

These boundaries choose the allowed action whose post-send reserve is closest to 30%; ties prefer less spending. A 10% send at the first threshold leaves about 28.4% of capacity. Recompute capacity as territory changes. The policy does not enforce a fixed number of seconds between attacks.

In the three Europe cases, the first send occurred at **4 seconds**, at roughly **3.8–3.9K display troops**, followed mostly by **10% sends every 2–3 seconds** (occasional four-second gaps). This is a measured consequence of the reserve rule, not a universal timing guarantee.

A conservative alternative is a **35% target**: its instantaneous growth is about 98% of the fixed-capacity maximum, but it captured less land. The 30% target is a practical starting compromise, not a proven optimum.

### Suggested strategy paragraph

> During the initial wilderness-expansion phase, preserve a growing reserve rather than sending troops on every decision. Aim to keep available troops around 30% of current capacity: wait below roughly 31.6%, send 10% between roughly 31.6% and 35.3%, and send 20% above 35.3%. Check once per second and recompute the ratio as land raises capacity. In the tested openings this meant waiting about four seconds initially, then usually sending 10% every two or three seconds. Although the instantaneous growth peak is near 42%, expanding earlier increases future capacity, so staying somewhat below that peak produced a better land/reserve compromise. This rule is for unopposed wilderness expansion, not fighting neighbors.

Historical v2 added **troop capacity** alongside available troops. V3 keeps capacity and adds border/neighbor facts, but removes the reserve instructions. The live harness executes Jev's selected action rather than replacing it with the deterministic reference policy tested here.

## Data

**162 deterministic, headless runs:** 27 policy configurations × six locations/terrain cases, each covering 60 seconds. This is a policy sweep, not 162 independent random samples.

The following are means over the **three real Europe locations only** (France, Poland, Switzerland), rounded to whole tiles/display troops. Remaining troops includes both reserve and troops still committed to the wilderness attack.

| Policy                                        | Land at 30s | Troops left at 30s | Land at 60s | Troops left at 60s |
| --------------------------------------------- | ----------: | -----------------: | ----------: | -----------------: |
| 20% every second (v1's observed Jev behavior) |       4,978 |              1,133 |       8,339 |              1,053 |
| 10% every two seconds                         |       5,363 |             11,506 |      18,752 |             22,222 |
| Target 20% reserve                            |       5,931 |             10,122 |      19,691 |             17,973 |
| Target 25% reserve                            |       5,240 |             11,931 |      18,988 |             22,293 |
| **Target 30% reserve**                        |   **4,492** |         **13,182** |  **17,811** |         **25,136** |
| Target 35% reserve                            |       3,725 |             13,990 |      15,665 |             27,813 |
| Target 40% reserve                            |       3,141 |             14,346 |      13,607 |             29,434 |
| Target 42% reserve                            |       2,958 |             14,262 |      12,773 |             29,768 |

At 60 seconds the 30% target had about **90% of the land and 40% more remaining troops** than the 20% reserve target, the best land result among the tested configurations averaged over these three starts. Relative to a 42% reserve target, it had about **39% more land and 16% fewer remaining troops**. There is a real tradeoff: the 42% policy did retain the larger army.

Holding exactly at the growth peak therefore was not the best territorial opener. Land gained earlier raises capacity and lets the reserve grow at a higher absolute rate later. Conversely, continuous 20% sends depleted the reserve so far that compounding was severely weakened.

The three uniform 512×512 synthetic maps (all plains, all highland, all mountain) showed the same broad pattern: a roughly 20% reserve target won the 60-second land comparison, while higher reserve targets retained larger armies. The relative desirability of land versus troops is not determined by this experiment.

## Why the local growth peak is not the whole answer

The actual human troop-growth rule, in internal units, is approximately:

```text
per-tick growth = (10 + T^0.73 / 4) × (1 - T/K)
```

`T` is the available reserve and `K` is capacity; the engine runs at 10 ticks/second and floors additions to integral internal troops. There are ten internal troops per displayed troop. The experimental runs execute this rule directly, including rounding.

Ignoring the small additive constant, the peak for fixed `K` is:

```text
T/K ≈ 0.73 / (1 + 0.73) ≈ 42.2%
```

Including the constant puts it a little lower (about 41.8–42.1% over representative early capacities). At the same fixed capacity:

| Reserve fraction | Approximate fraction of peak instantaneous growth |
| ---------------- | ------------------------------------------------: |
| 20%              |                                               80% |
| 25%              |                                               89% |
| 30%              |                                               94% |
| 35%              |                                               98% |
| 42%              |                                             ~100% |

Without cities, human capacity is:

```text
K = 2000 × ownedTiles^0.6 + 100000  (internal units)
```

This is why maximizing growth with a fixed `K` does not establish the optimal opening: attacks change `K` through expansion. The simulations include this feedback every tick rather than evaluating growth once at the starting capacity.

## Experimental setup and limitations

- Actual OpenFront commit: `bb8af015b515b3b717bd4d901074c5f4c16641cb`.
- Uses **real `Config`, `GameImpl`, `SpawnExecution`, `PlayerExecution`, and `AttackExecution`**. No simplified replacement growth or combat equations are used in the runs.
- Standard human starting army (2,500 displayed troops), real spawn shape, no infinite resources.
- One human, no opponents, buildings, boats, or victory checks. This isolates the economic opening; it is **not a multiplayer win-rate benchmark**.
- No Jev calls. Each tested policy chooses wait/10%/20% once per simulated second, then submits a normal attack execution. No extra inference information is secretly added to the live bot.
- No API latency or wall-clock scheduling jitter; this compares policies, not service performance.
- Fresh map and game for every run; fixed player ID `analysis`, game ID `opening1`, and spawn per scenario.
- Synthetic spawns at `(256,256)`; Europe spawns at `(1087,983)`, `(1751,772)`, and `(1339,997)`. Terrain/coastline can clip the initial spawn, so starting capacity differs slightly across locations. Comparisons within each location share the same spawn.
- Fixed-send baselines: 10% or 20% every 1/2/3/4 seconds. Reserve targets: 10/20/25/30/35/40/42/50/60%, with and without an immediate 20% opening send. Also includes a never-attack control.
- Snapshots at 10/30/60 seconds and the full action schedule are recorded. Endpoints can depend on whether a send just happened; remaining troops includes active attacks to reduce that accounting artifact. The report also retains the land-time integral.
- Only six conditions and a finite policy grid were tested. Longer horizons, nearby opponents, different terrain geometry, or different objectives can change the best policy. No global-optimality claim.

## Reproduce

With the sibling OpenFront dependencies installed:

```bash
npm run analyze:opening             # full 162-run comparison
npm run analyze:opening -- --smoke  # three policies on synthetic plains
npm test                           # includes reserve-band threshold tests
```

The command uses the sibling checkout's `tsx`; no new npm dependency is installed here. The analysis script records the engine commit and assumptions in ignored `logs/opening-analysis.json`. Each result contains initial state, snapshots, individual sends, first-send time, average send interval, and land-time integral. `logs/opening-smoke.json` is the smaller smoke artifact.

### Source references

- [Troop growth and capacity](https://github.com/openfrontio/OpenFrontIO/blob/bb8af015b515b3b717bd4d901074c5f4c16641cb/src/core/configuration/Config.ts#L1013-L1080)
- [Wilderness combat and expansion speed](https://github.com/openfrontio/OpenFrontIO/blob/bb8af015b515b3b717bd4d901074c5f4c16641cb/src/core/configuration/Config.ts#L871-L900)
- [Attack commitment, merging, and execution](https://github.com/openfrontio/OpenFrontIO/blob/bb8af015b515b3b717bd4d901074c5f4c16641cb/src/core/execution/AttackExecution.ts)
- [Per-tick player growth](https://github.com/openfrontio/OpenFrontIO/blob/bb8af015b515b3b717bd4d901074c5f4c16641cb/src/core/execution/PlayerExecution.ts#L87-L95)
