# Neighbor structures: v4.5.2 source-wired; geometry remains future offline

`web/neighbor-defenses.js` contains two separate read-only paths. The cheap **counts-only getter and strict validator are source-wired in A's v4.5.2** browser/core observations and policy descriptors. The full terrain/frontier/range analyzer remains **FUTURE OFFLINE**, with no live caller and never on the one-second loop. Neither path requests a worker/model or emits an intent; neither introduces a nation army-ratio gate or conquest prediction.

**Deployment/evidence:** the backend was v4.5.1 at B's handoff and requires an explicit restart after the atomic v4.5.2 commit; use `/health` to check the actual running version. Source wiring, synthetic tests and the network-free native inventory check below are not a claim that a real model has received structure facts. Historical v4.5.1 conquest/gold evidence is unchanged and must not be relabeled v4.5.2.

Source reviewed: sibling OpenFront commit `bb8af015b515b3b717bd4d901074c5f4c16641cb`. Enemy tribe/nation building metadata and actual map terrain are source-accessible in browser and core APIs. Dependency-free fixture checks verify the optional counts shape and calculation behavior; genuine GameView/GameImpl parity and real-model use require their own evidence.

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

## Cheap optional structures-only slice (v4.5.2 source-wired)

`observeNeighborStructures(game, targetId)` enumerates just the target's current City and Defense Post units, checks activity/construction/ownership/levels and verifies unchanged game/tick/target identity/life. It does **not** read map dimensions, tiles, unit positions, terrain, range, configuration, workers or model/intent methods. A's v4.5.2 source accepts this optional `neighbors[].structures` field; the following values are illustrative, not a live capture:

```js
{
  source_tick: 100,
  city: {completed_count: 1, constructing_count: 1, completed_levels: 3},
  defense_post: {completed_count: 1, constructing_count: 0, completed_levels: 2}
}
```

`validateNeighborStructures(value)` strictly accepts exactly these keys and integer counts. It returns a detached clean payload. Each type permits at most 4,096 enumerated active instances; completed levels must be zero if completed count is zero, otherwise at least the completed count. A constructing structure is not included in completed levels. Missing/extra keys, null/unknown status, fractional/string/negative counts, impossible level sums and exceeded limits fail; they are not normalized to zero.

**Coherent snapshot requirement:** browser/core source producers require `structures.source_tick` equal their owning observation's snapshot tick; raw validation rejects mixed neighbor stamps, and Hybrid validation rejects a structures stamp different from its snapshot tick. The payload is nested under a known neighbor, so it omits repeated game/target IDs; the getter verifies those identities before returning.

**Known zero requires a working authoritative unit API, actual GameID context and the same snapshot.** Browser/core source leaves the field absent when the unit API or actual game context is unavailable; the core facade's optional `{gameId}` must come from its actual runner, not be manufactured to force known-zero output. Missing means **UNKNOWN**, not zero. Inconsistent metadata or a changed snapshot is rejected rather than converted to a defense-free target. The same getter/validator supplies both facades, but synthetic parity checks are not genuine engine/browser or real-model evidence.

A's v4.5.2 model state/target criteria preserve facts only when present; the prompt distinguishes completed versus constructing instances and levels without changing menus, gates or sizes. Counts omit Post placement/range/coverage and terrain, so even observed completed count zero is not a general no-defense or whole-conquest guarantee. Full territory/frontier analysis below remains explicit and slow; do not call it per neighbor on the one-second loop.

## Compact proposed optional `neighbor.defenses` shape

The FUTURE OFFLINE analyzer accepts `analyzeNeighborDefenses(game, {selfId, targetId})` and produces a snapshot-stamped result. The following payload is **illustrative, not an observed game**. Attach it as an optional field only in a future agreed raw schema version, after browser/core parity tests; it is rejected by today's raw schema.

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
- Zero completed Posts requires a successful authoritative enumeration, actual GameID and coherent snapshot. Missing accessors/status cause the analysis to fail rather than fabricate zero. Exceeded range-comparison budget produces **null** with `unknown_comparison_budget_exceeded`, never zero. An exceeded full-map scan budget throws rather than returning a sampled histogram mislabeled complete.

## Bounds, future integration, and limits

Only the FUTURE OFFLINE `analyzeNeighborDefenses` scans **one target** over the whole map synchronously and only on explicit invocation; the source-wired counts getter performs no map scan. The default/hard map limit is 4,194,304 tiles, each type's enumeration limit is 4,096 units, and the default range comparison budget is 1,000,000 tile/Post pairs. Larger required range workloads retain count/terrain facts with unknown coverage; no model action is removed or substituted. The final tick/game/target-life check rejects changed snapshots. These bounds are not evidence that a full-map scan is inexpensive enough for a one-second controller.

Do **not** put one full-map scan per neighbor on the 1 Hz path. A future adapter should collect all selected targets in one bounded map pass, verify a common snapshot identity/tick, and describe any caching age or sampling explicitly. The v4.5.2 source-wired initial slice is authoritative building counts only. A future frontier histogram could be added separately, with full-territory terrain absent/unknown rather than estimated from the frontier. Current frontier geometry cannot represent disconnected inland territory or the future march through a mountain interior. Missing data must remain missing; no prompt may infer defense-free land from an omitted optional field.

The D one-send study in `docs/nation-one-send.md` showed a 2,000-mountain-tile target with a completed Post surviving a send three times its initial reserve with 995 tiles left. That is a **controlled counterexample**, not a universal threshold. Current terrain/Post observations could make Jev's whole-conquest judgment better grounded, but still omit future growth, counters, fallout, active attack path, changing ownership and other defensive effects. The module provides no numeric finishability score, projected casualties, arbitrary ratio gate, target selector or send resizer.

### Genuine-engine count evidence (network-free)

On 2026-10-03 an explicitly network-forbidden check used fresh production Europe/Compact, native Easy AI, seed `neighbor-inventory-api-001`, 12 tribes and the same fixed three nations/France spawn. The only human setup action was the ordinary spawn; no human land/build action or model call occurred. Tick spacing was deliberately bypassed for this offline API check, **not** presented as live controller timing.

- Switzerland's native AI created an actual City: at **tick 1263**, inventory was City completed **0**, constructing **1**, completed levels **0**; at **1283**, completed **1**, constructing **0**, completed levels **1**. Post inventory was zero in these two snapshots.
- Source helper results matched the actual active `UnitImpl` arrays/construction flags/levels and the truthful read-only GameView-shaped proxy.
- At **129 snapshots**, the shared browser `createGameAdapter` running against that facade produced a raw observation field-for-field equal to `observeCore(...,{gameId:actualSeed})`, including optional structure facts. The human remained alive.
- Repeating the check reproduced the construction/completion snapshots and all parity assertions. Raw evidence is ignored at `logs/neighbor-structures-engine-check.json`; the temporary verifier was not added as a paid/model execution mode.

This is **genuine-engine units/facade/observation evidence**, not an actual Chrome `GameView` run, a Jev-selected City, a human build intent, a conquest or a match result. It does not assert measured protected-frontier coverage or a positive native Post case. Real browser and model-use evidence remain separate.

### Checks

`node --test tests/neighbor-defenses.test.mjs` covers mocked browser/core enumeration parity, counts versus upgraded levels, construction/inactivity/ownership, inclusive Euclidean distance, target-side measurement, overlapping coverage, edges versus unique tiles, terrain/ownership, missing metadata, budgets and snapshot changes. Tests explicitly forbid worker/send/model methods. Structures-only tests additionally forbid every map/configuration/unit-position accessor, compare its counts to the slow study/mocked browser/core enums, validate the strict compact payload and reject snapshot changes during enumeration. These checks establish bounded calculation behavior; they do **not** establish genuine GameView/GameImpl parity, a real model decision, an emitted intent, conquest or competitive performance.
