# Recorded Easy wilderness opportunity: Solo engine reconstruction

**Fresh Singleplayer/Solo engine replay of recorded normal intents + post-hoc geometry. This is NOT OpenFront Replay mode, bridge Replay execution, or autonomous Replay UI play. No model runs in this reconstruction context; it is not a fresh model strategy result or model override.** This study replays only the eleven normal attack intents recorded in A's earlier [real 90-decision v4.5.1 trace](focus-easy-v4.5.1-validation.md), at their original `submitted_tick`. It requests no model choice, changes no troop amount/target, injects no gold/terrain, makes no API/Start/browser call, and uses none of the held-out seeds. Native Easy AI continues normally. The original match remains **censored, not won**.

## Reproduction is verified before geometry is credited

`scripts/analyze-recorded-wilderness.mts` uses C's fresh `createFocusedEuropeWorld`: production Europe Compact, Easy, seed **`europe-focus-001`**, human **(543,491)**, twelve tribes and England/Spain/Switzerland, original five-minute config. It explicitly asserts **`GameType.Singleplayer`**, then the complete original metadata/settled roster before progressing, and exactly matches the original tick-3 starting state. All historical intents pass through the normal Solo `GameRunner`/`Executor` pipeline; no Replay-mode or bridge execution path is used.

The replay matched **all 90 historical physical observation snapshots** (self, raw borders, neighbors, incoming/outgoing attacks), all eleven normal intents, actual ConquestEvents, and zero Win events. Final state is identical:

| Field | Reproduced value |
| --- | ---: |
| Final tick / gameplay ticks replayed | **901 / 898** |
| Engine hash | **1839361844077469** |
| Human territory | **9,919 tiles** |
| Human internal reserve | **554,559** |
| Human gold | **97,250** |
| Tribe conquest | Original tick **149**, **7,350** gold |

The tape records **8 wilderness 20% choices, 3 tribe-11 20% choices and 79 waits**. Those are past model choices, not newly selected replay actions. The input remains ignored `logs/jev-focused-europe-easy-v451-first90.json`, SHA-256 **`03aed19621b721dea58b4b1b8baff6e83068ab07077d5ce9b4e6231cfe5f9b4c`**. Missing tape or any metadata/input/hash mismatch fails closed; the script never substitutes a policy or fabricates a reconstruction. Geometry is written only after the final reproduction checks pass.

```sh
# Injected-array geometry checks: no engine game or model request.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/analyze-recorded-wilderness.mts --self-test

# OFFLINE fresh Singleplayer/Solo engine replay of recorded normal intents.
# NOT OpenFront Replay mode or bridge Replay execution; no current model inference.
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/analyze-recorded-wilderness.mts --replay
```

Only `--self-test` or `--replay` is accepted. Here `--replay` names **offline recorded-intent reconstruction in a fresh Singleplayer/Solo engine**, not an OpenFront game/UI mode or permission to run a model in Replay context. It requires the original local ignored tape; it is not a new standalone seeded strategy benchmark. No upstream source is edited.

## What exactly was scanned

At the **last model input tick 891**, and again at final **tick 901**, classify **all 1,213,872 main-map tiles** (1452×836), under a hard **4.2-million-tile** limit. Count global owner-0 land separately from owner-0 water/impassable cells. Enumerate every cardinal neighbor of our owned tiles; retain distinct **owner-0, land, passable** seed tiles. Flood every such seed's neutral component using the production cardinal `neighbors4` topology. Deduplicate shared seeds and components. Do not cross water, diagonals, impassable tiles or any owned tile, including ours; a separate neutral component touching another part of our border is counted separately.

The scan independently recomputes all raw border-edge categories and asserts equality with `summarizeBorders`; tick 891 also matches the recorded model input. Every component has exact area, seed refs, bounds and terrain histogram. Source stamps bind game ID, stable human identity, tick, dimensions, inspected tile count, method, `complete:true` and `sampled:false`. Terrain names come from the pinned engine enum, not an inferred map palette. Source: `GameMap.ts:378-426` (terrain/cardinals), `AttackExecution.ts:385-400` (normal attack's cardinal, passable, target-owner expansion), and `web/game-adapter.js:6-53` (edge counts).

## Exact opportunity at the two verified snapshots

| Measure | Last real model input, **891** | Historical end, **901** |
| --- | ---: | ---: |
| Raw wilderness **edges** | **63** | **63** |
| Distinct adjacent neutral **seed tiles** | **43** | **43** |
| Reachable neutral components | **5** | **5** |
| Total reachable passable neutral area | **1,962** | **1,696** |
| Largest component | **1,930** | **1,664** |
| Other components | **28, 1, 2, 1** | **28, 1, 2, 1** |
| Global unclaimed passable land | **379,786** | **376,345** |
| Global unclaimed land outside these border-reached components | **377,824** | **374,649** |
| Reachable area / global unclaimed passable land | **0.517%** | **0.451%** |
| Reachable area / our current 9,919 tiles | **19.78%** | **17.10%** |

There are **not 63 distinct neutral tiles or 63 independent regions**. Multiple cardinal edges touch the same seed; twenty-five distinct seeds touch the largest component. Fourteen seeds touch the 28-tile pocket; the remaining seeds touch the 1/2/1-tile pockets. The raw border also has **1,238 water edges**, **37 player edges** and **0 blocked edges**, totaling **1,338**, at both snapshots.

Exact terrain counts:

| Snapshot / component | Plains | Highland | Mountain | Total |
| --- | ---: | ---: | ---: | ---: |
| 891: largest region | 742 | 790 | 398 | 1,930 |
| 891: all five regions | **746** | **816** | **400** | **1,962** |
| 901: largest region | 646 | 648 | 370 | 1,664 |
| 901: all five regions | **650** | **674** | **372** | **1,696** |

The small regions together contain 4 plains, 26 highland and 2 mountain tiles. The largest component's bounds shrink from **x475–530 / y545–608** to **x478–530 / y550–608**. Its cardinally reachable neutral area falls by **266 tiles over ten ticks**, while the raw edge count, distinct seeds and our territory remain unchanged. The two snapshots do not attribute that loss to a named native actor or forecast subsequent access.

Global owner-0 counts including water are **1,025,323** at 891 and **1,021,882** at 901; these must **not** be presented as unclaimed land. Both snapshots have zero owner-0 impassable land. Full global neutral-passable terrain histograms and all 43 seed coordinates are in ignored `logs/recorded-wilderness.json`.

## Diagnosis and limits

The terminal opportunity is **neither only tiny neutral pockets nor hundreds of thousands of directly accessible wilderness tiles**. It is one finite, mixed-terrain patch of roughly **1.7–2.0k tiles**, plus **32 tiny-pocket tiles**. Relative to our 9,919 tiles, that is a nontrivial *geometric* upper bound; relative to global neutral land, it is tiny. Roughly **62%** of reachable tiles are Highland/Mountain, so treating the region as uniformly plains would also be wrong.

This corrects two tempting inferences:

1. **“63 wilderness edges means large profitable expansion.”** Edges say current contact exists, not how much territory lies behind it or its terrain cost. Here the same 63 edges mask a shrinking component.
2. **“Nearly 380k neutral land remains, so Jev ignored a vast land opportunity.”** Most of that land cannot currently be reached by staying within cardinally connected neutral passable regions from our border. Water, claimed territory and future ownership changes need separate planning/actions; a global count does not establish current land reachability.

**No ROI or counterfactual conquest was measured.** We did not send an alternative wilderness attack, replay another choice, estimate how much a chosen fraction would capture, or test safety against native counters. A component's exact area is not guaranteed gain: troop losses, border speed, future opponent expansion and changing ownership matter. The original last input chose wait while legal wilderness and nation candidates were present, but it did **not** contain these component sizes/histograms. This study does not show Jev knew the pockets were limited, establish that wait was optimal, or explain all **79** waits from two late snapshots. Earlier decision opportunities require their own explicitly scoped historical scans, not extrapolation from these two.

The measurements are **post-hoc source evidence only**. No live geometry field, strategic gate, fraction override, City/boat/Post behavior or planner intervention was deployed in this slice. A future bounded spatial observation could distinguish border contact from region area, but that is a separate interface/versioning task, not an authorization to replace model decisions with a scan-derived heuristic.

## Checks

- Injected-array checks cover shared seeds/edge multiplicity, terrain counts, water exclusion, impassable exclusion, separate components/no diagonal shortcut, zero neutral reachability, map-edge/ref-zero handling and hard size rejection. These are geometry unit checks, not real model or gameplay outcomes.
- Two final fetch-forbidden **Singleplayer/Solo recorded-intent reconstructions** matched the original final hash/roster/all 90 physical inputs and produced byte-identical schema-v2 diagnostic JSON: SHA-256 **`05e8d1e9b5a7ddc0697b8cda17d7648853233ed11c305cafa33cbf95b3d962c5`**. The v2 environment-label clarification and explicit Singleplayer assertion change no historical physical result or geometry.
- `npm test`: **389/389** dependency-free checks passed on the coordinated pre-commit tree; the pinned historical replay also reproduced unchanged after the City-loop commit.
- No API/browser/held-out-seed run, upstream edit or new competitive result. Generated reports and original run logs remain ignored.
