# Europe Compact: Easy nations, native tribes, focused mock controls

`scripts/benchmark-europe-tribes.mts` is a **network-free headless OpenFront experiment**, not a Jev/Copilot decision or the deployed bot. It loads fresh production Europe `map4x.bin`/`map16x.bin` instances for each paired control; the real `GameRunner`/`Executor`, 12 native `TribeSpawner` bots, and three Easy native `NationExecution` AIs run normally. It uses one fixed human at compact France `(543,491)`. The three manifest nations are intentionally fixed nearby **England, Spain and Switzerland**, with their documented Compact coordinate scaling, rather than the map's default all-nations roster. This designed matchup and one seed are **not representative win-rate evidence**. No browser game/controller, TypeSafe/Copilot request, or upstream edit is involved.

```sh
# Bounded, deliberately censored 60-second mechanical smoke.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-europe-tribes.mts --smoke --output logs/europe-tribes-smoke.json

# Complete five-minute native WinCheck (three paired control arms, one seed).
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json scripts/benchmark-europe-tribes.mts --nation-probe --output logs/europe-tribes-full.json
```

`--seed <safe-ID>`, `--minutes 1..120` and `--output logs/name.json` customize a separate run; the default seed is `europe-focus-001`. Reports under ignored `logs/` must not be committed. Repeated full reports were **byte-identical**. The script checks all 15 opponent IDs/names/types/spawn coordinates match across controls and stops with an error rather than silently accepting an unpaired roster. Five-minute complete runs receive the engine's own Win event; the `--smoke` rows are `censored-tick-cap` and `win:null`, not losses.

## What the three *explicit mock* controls do

1. `fixed20-wilderness` sends 20% of available human troops to bordering wilderness once per simulated second, never a boat, building, tribe or nation attack. This is a deliberately weak control.
2. `mock-one-tribe-at-a-time` otherwise uses the same wilderness control, but on first legal bordering Bot chooses the **lowest smallID** as a reproducible mock target (not a model preference), then sends at most 20% of current available troops to that **same** tribe once per simulated second until it is eliminated. If that target becomes non-bordering while alive, it waits rather than secretly switching targets. It never attacks a nation. This is not a recommended troop reserve/timing policy; the approved live bot still needs its own observation, Jev choice and legality checks.
3. Only with `--nation-probe`, `mock-tribes-then-one-nation-poke` runs the same focused control but performs **one explicit negative-control 10% nation attack** after its current tribe is finished, **when zero tribes border and a legal nation does**. That once-only probe takes precedence over available wilderness solely to observe the engine's hostile relation transition. It is deliberately **not a credible whole-conquest strategy**, must not be copied into the live controller, and cannot establish any safe nation-attack size.

No arm sends more than the tribe-specific 20% ceiling; the one nation poke targets a `PlayerType.Nation`, not a tribe. Each row records focus start/end, progress snapshots of target tiles and wallet with conquest-event count, every normal attack intent, human gold/troops/tiles, native ConquestEvents, 30-second checkpoints, nation contacts with contemporaneous bordering tribe IDs, and the engine's actual winner.

## Observed default seed (five simulated minutes)

| Arm | Focused tribe captured / event gold | Final human tiles / gold | Nation poke | Engine result |
| --- | --- | ---: | --- | --- |
| Fixed wilderness | none / **0** | 9,152 / 300,900 | none | Lost to England |
| One-tribe mock focus | one / **9,050** | 10,531 / 309,950 | none | Lost to England |
| Focus + optional one-off nation probe | one / **9,050** | 10,569 / 309,950 | once at second 64 | Lost to England |

At second **4**, the focused Bot had **389 tiles / 1,950 gold**. While partially damaged it still held **366 tiles / 4,450 gold** at second 9 and **235 tiles / 6,950 gold** at second 14; **zero** ConquestEvents for it had occurred, and the human's gold increases to those moments matched ordinary worker income. At **tick 183** it was eliminated below the engine's 100-tile threshold and **one** human-attributed ConquestEvent credited **9,050 gold**. The increasing target wallet includes native Bot worker income; this is *remaining wallet at conquest*, not a fixed kill bonus. A second tribe was first focused at second 287 in the default focus arm but was still alive at the timer: its large wallet produced **no additional conquest gold**, even as it lost tiles. See `docs/tribe-gold-and-nation-hostility.md` for exact source and a smaller passive-target proof. Final differences in territory/troops are outcomes of different games, not the isolated monetary value of the 9,050 gold.

In the optional probe arm, no tribe bordered when Switzerland first became legally adjacent at second **64**. The 10% nation attack was submitted through a normal intent, and Switzerland's relation to the human changed **Neutral (2) → Hostile (0)** during AttackExecution initialization; a temporary embargo was observed. At +10 seconds it remained Hostile, +30 seconds Distrustful (1), and +120 seconds Neutral again, although the embargo flag was still present at that sample. **No active Swiss-to-human incoming attack was observed at those checkpoints**; unlike the earlier Impossible synthetic retaliatory example, an Easy nation's response is *not* guaranteed simply by Hostile relation. The probe did not conquer Switzerland or win. Omitted attacks, transient attacks between sparse checkpoints, and other nations' later behavior are not disproven by those samples. A credible whole-nation conquest threshold remains unknown; this deliberately partial poke is evidence of a cost of aggression, not an instruction to repeat it.

This single seeded Easy matchup **did not beat native nations** with any of the three mock controls (0/1 each). It **does** show one real tribe can be finished for observable gold while partial attrition alone awards no conquest bounty. It does **not** answer whether Jev's new focused policy can beat Easy, or whether finishing *all* bordering tribes first is sufficient: no real Jev decision or complete model-controlled Easy win is in this report. Those claims require Moritz-authorized paid, paced model choices through a guarded live controller, normal accepted intents, and completed held-out games with more than one seed.
