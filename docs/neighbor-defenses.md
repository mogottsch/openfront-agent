# Neighbor defense and terrain facts: standalone, not deployed

`web/neighbor-defenses.js` is an **explicit, read-only study module**. Nothing in the live observation, bridge, policy or controller imports it. It makes no worker request, emits no intent and requests no model. This slice does **not** change a running v4.5.1 experiment, introduce a nation army-ratio gate, or claim a conquest prediction.

Source reviewed: sibling OpenFront commit `bb8af015b515b3b717bd4d901074c5f4c16641cb`. The source supports current enemy tribe/nation building counts and terrain histograms in both browser and core APIs. Genuine-engine/browser parity and a separately versioned optional observation rollout remain future work; the current tests use dependency-free facades, not gameplay.

## What the source actually exposes

| Fact | Browser source | Core source / caveat |
| --- | --- | --- |
| Current owned structures | `src/client/view/PlayerView.ts:445-451` calls `GameView.unitsOwnedBy(smallID)` and filters type | `src/core/game/PlayerImpl.ts:431-498` supplies `units(type)`. Use the **single-type string** overload, shared by both APIs. Do not use a core-only array overload in browser code. |
| Active-only ownership | `GameView.ts:1197-1212` builds owner groups from active units | Explicitly check `unit.isActive()` in the common summarizer. Read current `unit.owner().smallID()`; transferred buildings belong to their new owner. |
| Completed versus constructing | `UnitView.ts:253-269` exposes `isActive()` and `isUnderConstruction()` | `UnitImpl.ts:504-512` carries construction flag; `ConstructionExecution.ts:58-102` creates a real active building, marks it constructing and later clears the flag. A queued build without a created unit is **not** counted. |
| Count versus level | `UnitView.level()` is available; `PlayerView.totalUnitLevels()` sums levels, not structures | Do not use `PlayerImpl.unitCount()` or `unitsOwned()` as structure count: they sum levels with differing construction treatment. Its `unitCount` comment promises an exclusion not explicitly present in the loop (`PlayerImpl.ts:510-529`). Enumerate active units and explicitly classify their construction flag instead. |
| Terrain | `GameView.ts:1355-1356` delegates `terrainType` to the shared map | `Game.ts:365-371`: Plains=0, Highland=1, Mountain=2, Ocean=3, Impassable=4. `GameMap.ts:378-388` uses the actual map terrain/magnitude, not visual color or a guessed biome. |
| Post range | `game.config().defensePostRange()` | Current `Config.ts:374-384` gives radius **30**, attacker-loss magnitude multiplier **5**, and time-cost multiplier **3**. Read radius from the actual config, do not hard-code it in observation code. |
| Geometric protection predicate | Active, completed, current defender-owned Post within inclusive squared Euclidean distance | `AttackExecution.ts:329-367` calls `Game.hasUnitNearby` **per conquered tile**, with the defender's identity. `UnitGrid.ts:207-229` excludes inactive/constructing units and uses `distance² <= range²`. No line-of-sight, connected-territory, level-dependent range, or garrison predicate appears in this check. |

A City is infrastructure here, **not a claim of direct per-tile combat protection**. Post presence/levels do not imply complete target coverage. Two overlapping Posts count as two structures but do not count a frontier tile twice; `AttackExecution` asks whether at least one qualifying Post exists.

## Cheap optional structures-only slice (not wired yet)

`observeNeighborStructures(game, targetId)` enumerates just the target's current City and Defense Post units, checks activity/construction/ownership/levels and verifies unchanged game/tick/target identity/life. It does **not** read map dimensions, tiles, unit positions, terrain, range, configuration, workers or model/intent methods. This is the intended low-cost first slice for a future optional `neighbor.structures` field:

```js
{
  source_tick: 100,
  city: {completed_count: 1, constructing_count: 1, completed_levels: 3},
  defense_post: {completed_count: 1, constructing_count: 0, completed_levels: 2}
}
```

`validateNeighborStructures(value)` strictly accepts exactly these keys and integer counts. It returns a detached clean payload. Each type permits at most 4,096 enumerated active instances; completed levels must be zero if completed count is zero, otherwise at least the completed count. A constructing structure is not included in completed levels. Missing/extra keys, null/unknown status, fractional/string/negative counts, impossible level sums and exceeded limits fail; they are not normalized to zero.

**Future integration must require `structures.source_tick` equal the owning observation's snapshot tick.** The payload omits repeated game/target IDs because it will belong to a known neighbor entry, but the getter verifies these identities before returning. A module failure should leave this optional information unavailable, not invent a defense-free neighbor. Use the same getter and validator in both browser and actual-engine facade; genuine parity tests must precede a rollout claim. Units-only counts omit Post placement/range/coverage and terrain, so even observed completed count zero is not a general no-defense or whole-conquest guarantee.

This module/test iteration alone changes no shared raw/model schema, integration bridge, prompt or live controller. Full territory/frontier analysis below remains explicit and slow; do not call it per neighbor on the one-second loop.

## Compact proposed optional `neighbor.defenses` shape

The standalone analyzer accepts `analyzeNeighborDefenses(game, {selfId, targetId})` and produces a snapshot-stamped result. The following payload is **illustrative, not an observed game**. Attach it as an optional field only in a future agreed raw schema version, after browser/core parity tests; it is rejected by today's raw schema.

```js
{
  facts_version: 'neighbor-defenses-v1',
  game_id: '...', snapshot_tick: 100, observer_id: 1, target_id: 2,
  city: {completed_count: 1, constructing_count: 1, completed_levels: 3},
  defense_post: {
    completed_count: 1, constructing_count: 0, completed_levels: 2,
    range_tiles: 30
  },
  territory: {
    owned_tiles: 995,
    terrain: {plains: 0, highland: 0, mountain: 995, ocean: 0, impassable: 0}
  },
  frontier: {
    scope: 'current_target_side_cardinal_land_contacts_not_attack_path',
    target_tiles: 20, shared_land_edges: 24,
    terrain: {plains: 0, highland: 0, mountain: 20, ocean: 0, impassable: 0},
    within_completed_post_range_tiles: 12,
    range_coverage: 'exact_current_geometry'
  }
}
```

- `completed_count` and `constructing_count` count **current active unit instances**, not levels, lifetime builds, accepted build intents or queued construction. `completed_levels` is separately named; constructing levels are not mixed into it.
- `territory` exhaustively counts **current target-owned map tiles** by terrain, including unexpected water/impassable ownership rather than silently dropping it. It says nothing about the terrain of future acquisitions, reinforcements or fallout.
- `frontier` counts **unique target-side passable land tiles** cardinally adjacent to our currently owned passable land. `shared_land_edges` separately counts contacts; two of our tiles touching one enemy tile produce two edges but only one enemy tile. This is not all of the enemy's borders and not an attack's active `borderSize` or queued tile order.
- `within_completed_post_range_tiles` is exact current **range geometry** for those unique target-side frontier tiles, not measured future attack loss or a guaranteed protected frontier. Posts elsewhere on the map can geometrically cover a tile; an allied/third-party Post cannot satisfy the current defender-owned predicate. Constructing Posts provide no current range coverage.
- Zero completed Posts from a successful authoritative enumeration is known zero. Missing accessors/status cause the analysis to fail rather than fabricate zero. Exceeded range-comparison budget produces **null** with `unknown_comparison_budget_exceeded`, never zero. An exceeded full-map scan budget throws rather than returning a sampled histogram mislabeled complete.

## Bounds, future integration, and limits

The module scans **one target** over the whole map synchronously and only on explicit invocation. The default/hard map limit is 4,194,304 tiles, each type's enumeration limit is 4,096 units, and the default range comparison budget is 1,000,000 tile/Post pairs. Larger required range workloads retain count/terrain facts with unknown coverage; no model action is removed or substituted. The final tick/game/target-life check rejects changed snapshots. These bounds are not evidence that a full-map scan is inexpensive enough for a one-second controller.

Do **not** put one full-map scan per neighbor on the 1 Hz path. A future adapter should collect all selected targets in one bounded map pass, verify a common snapshot identity/tick, and describe any caching age or sampling explicitly. Another option is a less expensive initial slice: authoritative building counts plus current frontier histogram, with full-territory terrain absent/unknown rather than estimated from the frontier. Current frontier geometry cannot represent disconnected inland territory or the future march through a mountain interior. Missing data must remain missing; no prompt may infer defense-free land from an omitted optional field.

The D one-send study in `docs/nation-one-send.md` showed a 2,000-mountain-tile target with a completed Post surviving a send three times its initial reserve with 995 tiles left. That is a **controlled counterexample**, not a universal threshold. Current terrain/Post observations could make Jev's whole-conquest judgment better grounded, but still omit future growth, counters, fallout, active attack path, changing ownership and other defensive effects. The module provides no numeric finishability score, projected casualties, arbitrary ratio gate, target selector or send resizer.

### Checks

`node --test tests/neighbor-defenses.test.mjs` covers mocked browser/core enumeration parity, counts versus upgraded levels, construction/inactivity/ownership, inclusive Euclidean distance, target-side measurement, overlapping coverage, edges versus unique tiles, terrain/ownership, missing metadata, budgets and snapshot changes. Tests explicitly forbid worker/send/model methods. Structures-only tests additionally forbid every map/configuration/unit-position accessor, compare its counts to the slow study/mocked browser/core enums, validate the strict compact payload and reject snapshot changes during enumeration. These checks establish bounded calculation behavior; they do **not** establish genuine GameView/GameImpl parity, a real model decision, an emitted intent, conquest or competitive performance.
