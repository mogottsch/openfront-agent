# City adapter: mock-choice actual-engine validation

This is a **no-model integration check**, not a Jev City choice or a proof that building a City improves match outcomes. It exercises `web/building-adapter.js` against OpenFront's real `GameRunner`/`Executor` and worker-facing `runner.playerBuildables`. No upstream code is changed and no API request is made. Tested against OpenFront checkout `bb8af015b515b3b717bd4d901074c5f4c16641cb`.

## Reproduce

From `openfront-agent` with the sibling OpenFront checkout and dependencies installed:

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/verify-city-adapter.mts
```

The script has **no live-model flag**. It writes a complete, ignored `logs/city-adapter-engine.json` containing the exact bounded `adapter.propose()` result, same-tick raw `observeCore` land observation, `validateHybridInput`-checked opt-in hybrid snapshot, selected opaque candidate ID, one emitted normal intent, and subsequent game outcomes. Two runs produced byte-identical JSON. The JSON is local evidence, not a committed fixture; `logs/` is gitignored.

## Setup, input, and boundary

The game is one human, no opponent, no bots, no infinite gold/troops, non-instant construction, a deterministic 256×256 all-plains map and 2,500 owned tiles; it starts at 100,000 internal troops. Gold comes from the **actual game config** `startingGold: 400000`, not a post-snapshot assignment. The path is `Config.startingGold()` / `startingGoldFor()` → `PlayerImpl` constructor (`Config.ts:436-440,735-740`, `PlayerImpl.ts:199`). One empty engine turn initializes the usual execution pipeline before the proposal. This is a controlled affordability case, not a typical opening or a City-build recommendation.

The core Player-shaped facade delegates map/tick/ownership methods to the real game. Its async `buildables(tile,[UnitType.City])` calls `runner.playerBuildables(player.id(),game.x(tile),game.y(tile),[UnitType.City])`, which returns actual `BuildableUnit.canBuild`, `canUpgrade`, and BigInt cost. The mock chooses **the first already offered opaque candidate ID**—not coordinates, a ranking policy, or a real model answer. `canExecute(id)` and `execute(id)` perform fresh worker checks on the current tick. The callback only queues `{type:"build_unit",clientID,unit:"City",tile}`; the following normal `GameRunner` turn determines whether construction actually appears. `Config.unitInfo(City).constructionDuration` supplies the 20-tick parameter, and `Config.cityTroopIncrease()` supplies the 250,000-internal capacity increase; both are recorded as facts, not injected game state.

## Observed causal chain

| Boundary | Actual observation |
| --- | --- |
| Snapshot at tick 1 | 2,500 owned tiles, 100,000 internal troops, **400,000 gold**, no City, capacity **318,672.4147886974 internal**. Same-tick raw land observation and exact 8-site proposal validated with `validateHybridInput`; 8 worker checks, 2,500 eligible, 2,492 omitted (1,988 not examined; 488 prefilter limit; 16 shortlist limit). This coverage is geometric only. |
| Selected answer | Explicit **mock**, not Jev: `city-adapter-fixed-001/all-plains-256@1#1:c1`. The real worker returned exact `canBuild` tile `(56,81)` and **125,000 gold** cost, with `canUpgrade:false`. |
| Intent | Callback queued one normal `build_unit` intent at tick 1. No City was visible in the immediately following tick 2; this verifies why emitted intent ≠ observed construction. No second intent was sent. |
| Construction | At tick **3**, exactly one City at `(56,81)` was visible **under construction**; gold **275,200** and capacity still **318,672.4147886974** internal. |
| Completion | At tick **24**, that City was level 1 and no longer under construction; gold **277,300**, capacity **568,672.4147886974** internal: **+250,000 internal / +25,000 displayed**. Territory remained 2,500 tiles. This reports the simulation outcome, not just an emitted action. |

Gold deltas include ongoing income: `Config.goldAdditionRate` is 100 gold per engine tick in this setup. The tick-1→3 net change is **−124,800** (−125,000 City cost + 200 worker gold); tick-1→24 is **−122,700** (−125,000 + 2,300). The verifier asserts these equalities rather than treating a net wallet delta as the build price. The actual worker's 125,000 cost and the finished City's capacity increase are independently checked.

## What this does not show

- No paid model decision, no live browser controller or user-approved expansion of Jev's actions, and no autonomous City intent. A later one-shot Jev probe may use the saved fixed snapshot, but this script never contacts Jev or Copilot.
- No competitive advantage or economic payback estimate. OpenFront's City adds capacity only **after construction**; troops still grow by the game's separate rules. The candidate's `marginal_coverage_tiles` is just a geometric disc over owned land, not City output or protection.
- No claim that the other seven candidates were equally useful, nor that an omitted worker-unchecked site was illegal. Candidate IDs are snapshot-scoped and never reusable after the tick; execution must recheck worker and gold again.

Actual engine mechanics also have an independent paired City/no-City/upgrade study in [`structure-mechanics.md`](structure-mechanics.md). That study and this mock-choice adapter check answer different questions.
