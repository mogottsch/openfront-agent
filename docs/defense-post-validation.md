# Worker-checked Defense Post adapter on the real engine (offline)

`scripts/verify-defense-post-adapter.mts` is an **offline** integration check of C's bounded `web/defense-post-adapter.js`, not a Jev judgment or a native-AI match. Run the actual file as follows:

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/verify-defense-post-adapter.mts
```

It writes ignored `logs/defense-post-adapter.json`. No browser, Jev/Copilot request or upstream edit is involved. The OpenFront source checkout used here is `bb8af015b515b3b717bd4d901074c5f4c16641cb`. See `docs/structure-mechanics.md` for separate City/Post cost and pure `attackLogic` formula tests. This test adds the **candidate → worker → intent → construction → covered attack** chain.

## Honest snapshot and mock choice

Two independently fresh `GameRunner`/`Executor` games use identical 256×256 all-plains maps, adjacent 2,500-tile human territories, natural PlayerExecution growth, 100,000 starting gold per player and **no AI/counters**. A **normal stamped 1,000-internal-troop attack** creates the live, non-retreating incoming attack. At game tick 2, `observeCore(game,defender)` reads the actual attacker `smallID=2`, type `human`, 100 displayed attacking troops and 19,969 displayed attacker reserve. For adapter compatibility, the facade's `PlayerView.incomingAttacks()` projects **only** `id`, `attackerID`, `targetID`, `troops`, `retreating` from each real core `Attack`; the IDs/amounts are not fabricated. Its `PlayerView.buildables(tile,[Defense Post])` forwards to the real `runner.playerBuildables(playerID,x,y,[Defense Post])`, not a guessed legal site. The remaining map, player and immunity reads delegate to core methods. `validateHybridInput` accepts the exact same-tick land/post input with `building:null`, `naval:null`, `plan:null`, and Config-derived City mechanics; all eight actual worker-legal Post candidates and the true omission breakdown are saved in JSON.

The bounded proposal examined 512 of 2,500 owned sites, worker-checked and offered **8**, and explicitly omitted **2,492** (`not_examined=1,988`, `geometry_shortlist_limit=504`). Its incoming facts contain attacker ID `2`, with **50** uncovered hostile-front contacts labelled *potential* incoming contacts; the attacker's ID is **not** a known AttackExecution route or a forecast that every contact will be attacked. The first mock-selected candidate offered 33 such potential contacts, price **50,000 gold**, and privately resolves to tile `(125,99)`. In the **build** branch an **explicit mock Choice** of that opaque `...:dp1` passed `adapter.canExecute` and `adapter.execute` at the unchanged tick, emitting one normal stamped `{type:"build_unit", unit:"Defense Post", tile}`. In the paired **control** branch the mock Choice was `save_gold`, which emitted **no build intent**. The two snapshot IDs differ in their scan serial only; both use the same real attacker ID/attack state. No model selected either branch.

## Observed coverage and controlled attack

Both worlds received the **same normal attacker `cancel_attack` intent** immediately after the candidate snapshot. This isolates subsequent construction from the original incoming force: it is a genuine observed threat at proposal time, **not an attack left running during the build**. The Post appeared under construction at game tick **4**, did **not** cover the measured front tile while constructing (`Game.hasUnitNearby` false), and completed at tick **55**. After 65 equal setup ticks, both games had **the same 2,504 attacker / 2,496 defender tiles**; the defender Post cost 50,000 gold, whereas the control saved that gold. Attacker/defender armies were reset to identical **200,000 / 50,000 internal troops** before a second, identical **60,000-troop normal land attack**. The measured front tile `(100,99)` is 25 tiles from the worker-legal completed Post: `Game.hasUnitNearby(...,range=30,owner=defender)` was true with Post and false without.

| Ticks after second attack | Defender tiles, saved gold/no Post | Defender tiles, completed Post |
| ---: | ---: | ---: |
| 10 | 2,199 | 2,383 |
| 30 | 1,804 | 2,295 |
| 60 | 1,613 | 2,272 |
| 120 | 1,570 | 2,272 |

The unchanged `Config.attackLogic` saw **173 protected / 51 unprotected per-tile calls** in the built-Post run and **0 protected / 926 unprotected** in the control. One placed Post preserved **702** more defender tiles by tick 120 under *this prepared attack*. Coverage is per attacked tile and is not global: some calls were outside the radius. `Config.ts:374-383,875-877` gives a pure conditional ×5 attacker-loss magnitude and ×3 tile-cost/time factor; `AttackExecution.ts:339-365` asks `Game.hasUnitNearby` for each tile, which excludes under-construction units (`UnitGrid.ts:205-245`). Those formula factors are **not** observed multipliers for total casualties, attack duration, or win probability. The selected site's potential-incoming border overlap helped choose an **experimental** mock site; it did not prove the initial 1,000-troop attack's route or decide a live bot action.

Repeat the command to check byte-identical ignored JSON. This does not establish a real model-chosen Post build, native-AI survival, or a game win. The browser's actual `PlayerView` and live worker timing still need bounded solo validation before gameplay claims.
