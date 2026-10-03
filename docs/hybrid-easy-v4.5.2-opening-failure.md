# Real hybrid opening: human eliminated before City affordability

## Observed result, not a completed match

On 2026-10-03 A started an explicitly bounded **160-call maximum** flat land+City experiment from the ordinary seeded Europe/Compact Easy world. It stopped after **39 successful real Jev responses** when our Human was **conquered by tribe 11 at tick 384 / 38.3 game seconds**. No City was offered or built; no engine Win event or native match winner was observed. `complete:false`, `win:null`, `status:"human-eliminated-before-win-event"`.

This is a genuine observed **player elimination**, not an HTTP/model-validation failure, a five-minute completed match or a win-rate estimate. The sidecar session was revoked successfully and returned to idle. No automatic retry, heuristic replacement or speculative answer promotion occurred.

## Scenario and execution interface

- Fresh actual OpenFront `GameRunner`/`Executor`, engine `bb8af015b515b3b717bd4d901074c5f4c16641cb`.
- Driver `e466655`; policy `land-strategy-v4.5.2-neighbor-structure-facts`, hybrid policy `hybrid-branch-v3-defense-post-proposed`.
- Europe / Compact, seed `europe-focus-001`, Human France spawn (543,491), 12 native tribes, fixed Easy England/Spain/Switzerland.
- Default gold and ordinary troop rules; five-minute timer, 160 requests / 1,700 live ticks maximum.
- **Land+City only**, no navy/Post/Copilot. Headless engine pauses during inference; final execution requires both a ≤2,000 ms capture age and same current engine tick. This is not browser-clock equivalence.
- Provider response model: `jev-1.13.0`.

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --loop --live --max-calls 160 \
  --max-ticks 1700 --minutes 5 --seed europe-focus-001 \
  --output logs/jev-hybrid-europe-easy-v452-first160.json
```

The command consumes real requests and requires explicit bounded local authorization. It documents this historical invocation, not a recommendation to repeat a known failed driver unchanged.

## Exactly what Jev chose and what executed

The 39 sidecar records in `logs/decisions-2026-10-03T10-47-13.920Z.jsonl` match the 39 successful driver replies. The original ignored artifact is retained unchanged.

| Consumed family Choice | Count |
|---|---:|
| Wait | 38 |
| Land attack | 1 |

The independent **speculative**, not necessarily consumed `land_action` choices were: wilderness 20% once; tribe 11 20% 22 times; tribe 11 10% twice; wait 14 times. These do **not** describe emitted intents. The harness honored the selected family wait rather than silently using an attractive child answer.

- **Tick 3:** Human 52 tiles, 2,533 display troops, 12,141 display capacity, 100 gold; no neighbors/incoming/outgoing attacks. Family `wait` probability **0.80**; speculative wilderness 20% probability **0.36**. The consumed answer was **wait**.
- The Human remained on its **52-tile spawn** throughout the waiting phase. At tick 381 it had 11,690 display available troops, 37,900 gold, no observed incoming attack, and bordering tribe 11 had 3,180 tiles / 1,595 display reserve.
- **Tick 381:** family `land_attack`, selected `attack_player_11_10`. This was the only consumed attack.
- **Tick 382:** one normal stamped land intent to tribe `k62i96c9`, payload **11,690 internal troops** (10% of the current internal pool, not a full send).
- **Tick 384:** actual engine ConquestEvent: conqueror `k62i96c9` / tribe 11, conquered `2wiw51xq` / our Human, gold **19,100**.
- End: Human `alive:false`, zero tiles/gold/Cities. The core retained a **116,855 internal troop counter after elimination**. That counter is not a usable post-death army or a measured immediate pre-capture balance.

Measured minimum starts: **100.026 ms** engine ticks and **1,042.261 ms** requests. All 39 provider replies were structurally valid; no City option existed because ordinary funds never reached the first 125,000 cost.

## Exact elimination mechanism: enclosure cleanup, not combat retaliation

D's separate network-forbidden reconstruction reproduced all 39 physical inputs, the sole normal intent, ConquestEvent and final tick/hash. It recorded **zero incoming attacks to the Human, zero combat calls against the Human, and no queued tribe→Human AttackExecution**.

| Reported tick | Recorded physical event |
|---:|---|
| 382 | Human still 52 tiles; our outgoing 11,690-internal attack exists. |
| 383 | Our attack captures **11 tribe tiles**, raising the Human to **63 tiles**. |
| 384 | `PlayerExecution.removeClusters → removeCluster` calls `Game.conquerPlayer` while the Human **still has all 63 tiles**; then the enclosed territory's 63 tiles are handed to tribe 11. |

The Human's last cluster calculation stayed at internal tick 9 and last own tile change at 1 while it waited. Its own new captures updated the dirty/last-change state to 382; the next eligible PlayerExecution recalculation found `surroundedBySamePlayer: tribe11`, `getCapturingPlayer: tribe11`, and `isEnclosed:true`.

The immediate pre-cleanup Human home counter was **105,594 internal troops**, with **11,261.5** still in its outgoing stack. Later retreat/refund accounts for the retained post-elimination counter. The observed **19,100** loot is the source's half-wallet transfer for this Human victim, not proof the attacker exhausted its army.

This is **not a native counterattack, combat depletion, or provocation/hostility attribution**. The territory-cleanup path is independent of the attack-after-capture `<100` rule discussed below. A colony with more than 100 tiles is not automatically protected from enclosure cleanup. See D's [source instrumentation and reconstruction](hybrid-opening-failure.md).

## Concrete interface and observation deficiencies

### 1. The headless driver differed from the browser's single-family route

This first full headless loop always called `/hybrid-decision`, asking an additional `branch` Choice even when City was unaffordable and **land was the only actionable family**. Its land criterion said “Consider a normal land attack **or wait** after reviewing attack target/size choices,” beside a separate explicit family wait. The child's attack judgment could therefore be vetoed by another wait judgment.

The existing browser Hybrid controller instead transparently calls the **direct land decision** when there are no fresh legal City/naval/Post candidates. The headless loop did not yet mirror that routing. The proposed correction is **pre-inference**: if no real fresh City is offered, use the exact land request and `/decision`; otherwise use the full City+land request. The actual returned wait or attack will still be honored. Do not reinterpret or retroactively replace any of these 39 answers.

This is an observed routing/interface difference, not proof that every wait was caused by it or that a corrected route guarantees survival. Different question/state composition also means this is not a pure controlled comparison with [the earlier successful v4.5.1 land-only tribe run](focus-easy-v4.5.1-validation.md).

### 2. Home reserve does not encode distinct territory-elimination mechanisms

**General rule, NOT the observed trigger here:** `AttackExecution.ts:323-325` conquers a valid enemy tile and then calls `handleDeadDefender`; at `:433-436` a player with **fewer than 100 remaining tiles** is passed to `conquerPlayer`. The rule does not require home reserves to be exhausted. It applies to Human/Nation/Bot players, not wilderness.

At **1–100 currently owned tiles**, one successful enemy land-tile capture can therefore cross the elimination check, assuming no intervening territory gains/other changes. This does **not** say an enemy can necessarily reach or successfully capture that tile. Immunity, defense, terrain, active force and first-tile combat still matter.

Source v4.5.3 derives factual fields (without changing raw input): positive tile count `T` gives `tile_losses_until_elimination_threshold = max(1,T-99)` and `one_successful_tile_loss_can_trigger_elimination = (T<=100)`; zero territory gives null/false rather than guessing authoritative death. These facts should help Jev consider an early territorial survival buffer, **without removing wait, resizing an answer or adding an arbitrary reserve threshold**. Those combat-buffer facts do **not** diagnose this enclosure loss or establish that expanding beyond 100 tiles guarantees safety. A separate v4.5.3 derived border fact names only whether all observed frontier edges contact one unallied player (with no wilderness/water/blocked edges); it is not an `is_enclosed` or cleanup-scheduled assertion. Actual per-cluster bounds, free-land escape graph and recalculation state remain separate.

## What remains established

The prior v4.5.1 real model run did finish one tribe and collect 7,350 gold on this training scenario. C also separately observed an ordinary-income **explicitly mocked** Human City start/completion and +250,000 internal capacity. Neither becomes a real Jev City or a completed Easy victory because of this failed opening. No real model-selected City/Post/boat outcome or completed Easy/higher model win is established.

Next: tested pre-inference route parity and source-backed territory-buffer facts, then a separately authorized bounded opening check before another long hybrid experiment. Held-out seed panels remain distinct and unconsumed by this training-seed smoke.
