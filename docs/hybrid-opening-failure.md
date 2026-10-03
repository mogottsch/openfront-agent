# Failed hybrid opening: enclosure cleanup, not a native counterattack

**Scope:** source audit and bounded **fresh local Solo / `GameType.Singleplayer` engine reconstruction of recorded normal intents**. Not OpenFront Replay mode/bridge execution, current model inference, a new strategy result or a completed match Win. A owns the public validation summary of the original paid run; this document explains its engine mechanism. No provider/browser/held-out-seed run or upstream change was made here.

## The recorded failure is reproduced

Original input: ignored `logs/jev-hybrid-europe-easy-v452-first160.json`, SHA-256 **`daf19393f192cd33c289d1954a7524e421420210deca8c51702958ebbe6fdeee`**. The original v4.5.2 flat land+City loop made **39 successful replies**, not its authorized maximum 160: **38 branch waits**, then tribe-11 10%. Every recorded decision saw the human on its original **52 tiles**. No City was offered: all 39 inputs had `building:null` and `unaffordable-real-core-preflight`. No boat, Post or planner was enabled.

`scripts/analyze-hybrid-opening-failure.mts --reconstruct` reuses C's fresh Europe Compact/Easy world, same development seed `europe-focus-001`, France `(543,491)`, twelve tribes and England/Spain/Switzerland. It asserts `GameType.Singleplayer`, original metadata/settled roster/start state, **all 39 physical input snapshots**, the one normal **11,690-internal-troop attack** at submitted tick **382**, ConquestEvents, zero Win events, and final state/hash. It never executes the speculative land subanswers from the 38 branch waits.

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/analyze-hybrid-opening-failure.mts --reconstruct
```

The original tape is required and pinned by byte hash. Unknown CLI arguments or changed tape/state fail closed. The reconstruction stops exactly at **tick 384**, not at a future timer or a new model decision. Output is ignored `logs/hybrid-opening-failure.json`.

| Reported scene tick | Human tiles | Home internal troops | Human gold | Human outgoing to tribe | Human last territory-change tick / cluster `lastCalc` |
| --- | ---: | ---: | ---: | ---: | --- |
| **381**, last actual input | **52** | **116,908** | **37,900** | None | **1 / 9** |
| **382**, recorded normal intent initialized | **52** | **105,264** | **38,000** | **11,690** | **1 / 9** |
| **383**, our attack's first combat tick | **63** | **105,419** | **38,100** | **11,261.5248…** | **382 / 9** |
| **384**, enclosure cleanup and outgoing retreat | **0**, dead | **116,855** | **0** | None | **383 / 383** |

Final hash **`610006234975374`** exactly reproduces the recorded failure; the input tick-381 display reserve was floored to 11,690. Normal amount sizing used the original unrounded core reserve and the tape's actual integer intent, not a reconstruction from display arithmetic. Normal tick growth occurs before attack initialization, so the next scene's home stock is not simply input stock minus payload. Game execution's internal tick **383** becomes the reported update/scene **384**; both are explicitly labelled in diagnostic events.

## Important correction: no native combat counterattack killed us

The exact source call stack and passive wrappers show:

- **No enemy `AttackExecution` targeting the human was queued after setup**, and no incoming-to-human attack appears in any of the 39 inputs or final scene snapshots.
- **Zero `Config.attackLogic` calls against a Human defender** occurred in the reconstruction.
- Our attack captured **11 tribe tiles**, temporarily expanding us from **52 → 63** at reported tick 383. It did not first lose a tile or exhaust our army.
- At internal tick **383**, **`PlayerExecution.removeCluster`**, not `AttackExecution.handleDeadDefender`, called `Game.conquerPlayer` while we still owned **all 63 tiles**. The bounty event/transfer preceded any human tile loss.
- The same enclosure-cleanup call then transferred **all 63 tiles** to tribe 11. No native counterattack army was required.

Therefore **“we provoked a tribe counterattack, which captured one tile and triggered the sub-100 combat rule” is not the observed mechanism**. Aggression changed relations in the ordinary way, but relation change is not proof of an observed retaliatory attack. The recorded path is territory-gain → dirty cluster recalculation → full enclosed-region transfer.

## Exact source/scheduling path

Pinned engine: `bb8af015b515b3b717bd4d901074c5f4c16641cb`.

1. `PlayerExecution.ts:20-43` has a 20-tick cluster interval and seeded `lastCalc` initialization. The actual human execution's **`lastCalc=9`** persisted; its own `lastTileChange=1` had not advanced throughout the opening waits.
2. `PlayerExecution.ts:111-119` permits a cluster check when more than 20 ticks have elapsed **or** territory is below 100, but only performs recalculation when **`player.lastTileChange() >= lastCalc`**. The second gate was false before our territorial gain. Neighbor expansion updates border status without marking our own territory changed (`GameImpl.ts:762-812`). Thus the already narrow starting territory is not automatically killed merely because it is below 100.
3. Our first normal attack tick gained eleven tiles and set our **`lastTileChange=382`** (`GameImpl.conquer` stamps the owner and prior owner on actual tile changes). The following human `PlayerExecution.tick` passed the dirty gate and set **`lastCalc=383`** before recalculation.
4. The observed one-cluster path in `removeClusters` (`PlayerExecution.ts:135-153`) resolved `surroundedBySamePlayer` to **tribe 11**. This check rejects open/ocean-edge contacts, unowned neighbors and inconsistent single-neighbor enclosure (`:356-416`). The actual border cluster had 24 boundary tiles; that is **not** the total 63 owned tiles.
5. `removeCluster` resolved `getCapturingPlayer` to the same tribe. With no ongoing neighbor attack on the human, the method chooses the largest hostile-neighbor border, not an imaginary counterattack (`:557-600`). Its unchanged **`isEnclosed`** check returned **true**: cardinal traversal through own/unclaimed territory could not reach open water or the map edge (`:509-555`).
6. Whole owned territory equalled the enclosed fill. `PlayerExecution.ts:498-504` therefore called **`Game.conquerPlayer` at 63 still-owned tiles**, then `capturing.conquer(tile)` for every tile. The diagnostic caller stack records `PlayerExecution.removeCluster:499 → removeClusters:150 → tick:118`.

Private scheduling fields/methods are read-only diagnosis of actual core execution, **not deployed model observations**. Wrappers call the original methods once with unchanged arguments/results; they do not force a cluster check or alter source.

The recorded border contacts gradually lost wilderness while we stayed on 52 tiles: the last decision with any wilderness was **331** (three edges); from **341** onward the input had zero wilderness/water/blocked edges and all **32 player edges** belonged to tribe 11. This establishes the contact trace, not that the engine ran an enclosure check at 341. The actual checked enclosure is source-observed at internal 383.

## Why a dead human still has 116,855 troops; why the bounty is 19,100

`PlayerImpl.isAlive` (`:718-720`) means **owned tile count >0**, not reserve >0. Enclosure cleanup transfers land and bounty, not all reserve troops. The human retained **105,594** internal home troops immediately before/after the land transfer. Its existing outgoing attack then found no remaining home border and normally retreated/refunded its **11,261.5248…** survivors (`AttackExecution.ts:210-232,286-293`), yielding **116,855** after integer handling. This is not regeneration saving the player, a combat wipe or a successful defense; it is retained/refunded army on an already tile-less player. Final zero-land capacity was 100,000, but the recorded run stopped before another death-processing tick; do not assume a final stock must equal capacity or zero.

Immediately before credit, human gold was **38,200** and tribe gold **19,100**. Human conquest yields half the victim wallet (`Config.ts:724-732`): the unchanged transfer added **19,100** to the tribe, removed the human's whole wallet, and emitted the original **ConquestEvent at reported tick 384**, conqueror `k62i96c9`, conquered `2wiw51xq`, gold **19100**. The one initialized normal attack means the never-attacking-human bounty exception did not apply (`GameImpl.ts:1386-1425`). This is the tribe's bounty on us, **not our tribe-finish reward**.

Zero engine Win events, original `complete:false`, `win:null` and `human-eliminated-before-win-event` remain unchanged. Confirmed human elimination is not a fabricated timer winner or a completed full-match record.

## Distinguish the two mechanisms before adding vulnerability context

The independent **direct-combat** rule remains source-correct: `AttackExecution.ts:323-325` captures a valid enemy tile, then `:433` checks `target.isPlayer() && target.numTilesOwned()<100` with no reserve-exhaustion condition. For a currently alive player with **T≥1**, the snapshot arithmetic **`max(1,T−99)`** is losses until that *combat conquest/remnant-cleanup trigger*, assuming no intervening gains and actual successful captures. Thus 1–100 tiles can trigger it after one valid tile loss; 101 needs two; zero is already territory-less. It does not guarantee an enemy can capture a tile or that spatial remainder redistribution clears every disconnected holding.

**That arithmetic is not a complete vulnerability model and did not cause this recorded elimination.** PlayerExecution's enclosure path can credit a whole-player conquest **before any hostile combat tile capture**, and can also run above 100 tiles via its ordinary dirty/20-tick condition. Merely growing above 100, keeping a numerically dominant reserve, seeing no incoming attack, or not exhausting troops is not universal protection from an enclosed-territory transfer. Conversely an open exit, friendly relationship, multiple territory components or different scheduling can change the result; do not turn this one trace into an unconditional “attack below 100 always loses” rule.

The extra historical hybrid branch Choice also matters to interface parity: the recorded requests asked both **branch (`wait` / `land_attack`)** and independent **land_action**, even though only land was affordable/offered. Branch waits legitimately suppress their speculative land subanswers. This differs from the browser's transparent land-only fallback; it is a plausible interface hypothesis, **not proof that the extra question alone caused 38 waits**. A future routing correction must select the matching single-land protocol **before inference**, with a new version and fresh approved evidence. Never retroactively execute a speculative subanswer, rewrite Jev's waits or relabel the reconstruction as a successful corrected strategy. D changed none of those shared policy/controller routes.

## Checks and artifact boundaries

- Two final reconstructions with `globalThis.fetch` replaced by an immediate `NETWORK_FORBIDDEN` error matched the original metadata/roster, all 39 physical inputs, one recorded normal intent, ConquestEvents and final **384/hash610006234975374**. Diagnostic JSON was byte-identical on the coordinated final tree: SHA-256 **`0cb70901e04f9043446d8e05227f5256da691a2ece63efd085f9063d54c9f95b`**. A concurrent shared step-helper refactor changed only one caller-stack line versus the earlier diagnostic; all physical states, transfer data and mechanism stayed identical.
- Source-diagnostic assertions require no queued enemy attack against the human, no Human-defender combat calculation, the `PlayerExecution.removeCluster` caller, conquest credit at 63 still-owned tiles, and exactly 63 cleanup tile transfers. These are reconstruction checks, not new model judgments or a counterfactual strategy test.
- `npm test`: **402/402** dependency-free checks passed on the coordinated pre-commit shared tree.
- Only the two new diagnostic/document paths are in this slice. No original paid trace or generated report is committed; no current model/API/browser/held-out experiment, Replay-mode execution or upstream edit occurred.
