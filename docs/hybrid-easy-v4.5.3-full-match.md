# Complete v4.5.3 Easy match: Human lost; Switzerland won

## Actual outcome, not a censored milestone

A fresh, explicitly bounded **300-real-response** native-engine local Solo match reached the actual five-minute WinCheck on 2026-10-03:

- **Win event:** reported tick **3011**, **301 game seconds**.
- **Winner:** Switzerland, `ffayim6l`, **86,809 tiles**.
- **Our Human:** alive, **18,525 tiles**, **827,094 internal troops** (~82,709.4 display), **307,750 gold**, **zero Cities**.
- `status:"engine-win"` means the **engine emitted a winner**, not that our agent won. Here `complete:true`, **`win:false`**, one Win event.

This is a **completed Easy loss**, not a victory, elimination, call-cap censor, survival-win or strongest-bot result. Do not promote to Medium based on this match. The [previous real City completion](hybrid-easy-v4.5.3-city-validation.md) remains valid evidence from a **separate 160-call censored run**, not a construction observed here or reliable repetition rate.

## Same disclosed training setup, unchanged source

Production Europe/Compact, seed `europe-focus-001`, 12 native tribes, Easy fixed England/Spain/Switzerland and Human(543,491), ordinary gold/troops. Land policy `land-strategy-v4.5.3-territory-survival-buffer`, flat hybrid `hybrid-branch-v3-defense-post-proposed`, routed loop/final native-pacer submit guards from `0d499fe`; no runtime/policy/loop changes during the game. This started a **fresh world/session**, not a continuation or retry of either prior stopped artifact.

Native AI executes every actual `GameRunner` tick. Engine time pauses during inference; wall freshness still≤2,000 ms, final same-tick worker/identity/ownership validation remains required. No custom funds, scripted or mocked choices, fallback, retries, Copilot, navy or Defense Post execution. No held-out seed was consumed. Easy's native Human stat advantage, sparse/fixed roster/spawn and paused inference remain [competitive limitations](competitive-benchmark-audit.md).

## Replies, intents and a single conquest

The ignored report is `logs/jev-hybrid-europe-easy-v453-full300.json`. Sidecar `logs/decisions-2026-10-03T12-09-41.116Z.jsonl` contains preceding separate20+160 replies, followed by these **300**; compare this experiment's slice, not aggregate three worlds into one match.

| Actual returned/consumed Choice | Count |
|---|---:|
| Wait | 283 |
| Wilderness10% | 3 |
| Wilderness20% | 10 |
| Tribe11 10% | 1 |
| Tribe11 20% | 3 |

**17 normal land intents** were submitted. The tribe focus remained on smallID11 until authoritative death, then wilderness resumed. **ConquestEvent139:** our Human `2wiw51xq` conquered tribe `k62i96c9` for **6,850 gold**. No nation attack or City build was submitted. Late available land menus did include legal nation10–50% actions; those were not selected.

Routes: **287 direct `/decision`** (actual land Choice) and **13 `/hybrid-decision`** with fresh four-site City proposals at **1191, 1341, …, 2991**. All thirteen actual family answers were **wait**; site-child preferences were not execution authority and were not used to override them. Every returned wait was honored. City cost affordability/candidates existed, but no real build occurred in this match.

The observed final reserve was effectively at current capacity (**827,252.002503512 internal**), with307,750 gold unused. Waiting while opponents gained territory is an observed limitation, not proof of why Jev waited. No explanations were requested/returned. In particular, do not assign this result solely to unknown terrain, City branch design, the 'ideally one send' wording, or missing strategic/deadline context without isolated evaluation.

## Timer, arithmetic and shutdown

The existing **300-call hard cap** was respected. At engine elapsed300..302 seconds, source `timedWinCheckBoundary` suppresses new inference **before quota checks** and advances ordinary native empty turns. These are timer-boundary engine turns, not substituted model waits. The actual WinCheck fired before the two-second nonfire fence; no305-call option or extra paid request was used.

- Native live ticks **3→3011**, **3,008 post-setup steps**.
- Gold exactly: `100 +3,008×100 ordinary income +6,850 conquest =307,750`; no spending/funding override.
- Maximum recorded final submission age **367.443 ms**.
- Minimum request-start spacing **1,008.043 ms**, tick-start spacing **100.010 ms**; serial single-flight, no catch-up bursts.
- Finally Stop revoked the session with no stop error; backend idle v4.5.3.

```sh
../OpenFrontIO/node_modules/.bin/tsx --tsconfig ../OpenFrontIO/tsconfig.json \
  scripts/benchmark-hybrid-europe.mts --loop --live --max-calls 300 \
  --max-ticks 3100 --minutes 5 --seed europe-focus-001 \
  --output logs/jev-hybrid-europe-easy-v453-full300.json
```

This spends real requests; the completed artifact is not authorization to repeat it. A has withheld further paid gameplay until another coherent, tested source slice is agreed. Keep credentials, Start tokens and generated logs out of the public repository.

## Next development question

The observed agent can retain and finish a tribe, execute a real City in one experiment, and obey fresh legal choices—but it has **not won Easy**. Source-backed match goals/deadline/eligible standings and complete target-terrain/contact reachability are candidate small observation slices. They must remain factual/unknown-aware, not conquest predictions, mandatory thresholds or hidden answer replacement. Copilot planning still requires its explicit server-only token; no ambient-auth retry or validated Copilot plan has occurred.
