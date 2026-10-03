# Competitive benchmark audit and first held-out Easy panel

**Status: read-only source critique and proposed protocol, not new gameplay evidence or execution authorization.** No engine game, browser, provider request or upstream edit was made for this review. Only this new document is owned by D. Sources reviewed include the focused-Europe runner, its offline controls, the City-only seam, the native-pilot comparator, agent checkout through `86322da`, and OpenFront `bb8af015b515b3b717bd4d901074c5f4c16641cb`. Dependency-free `npm test` passed **370/370** during review; no engine benchmark was executed.

The [v4.5.1 milestone](focus-easy-v4.5.1-validation.md) is real: Jev chose three 20% sends at one tribe, normal engine intents executed, and **ConquestEvent tick 149 paid 7,350 gold**. Its 90-call cap, zero Win events and `win:null` make it a **censored tribe-finish success, not a match win**. Neither that result nor the [185 prepared nation one-send trials](nation-one-send.md) establishes competitive performance.

## 1. Human/native statistics are asymmetric, and Easy favors the human

`Config.ts:992-1079` uses these production rules, with no harness cheats:

| Actor | Starting internal troops | Capacity at equal territory and completed City levels | Growth multiplier before final capacity clamp |
| --- | ---: | ---: | ---: |
| Human | 25,000 | 1× base | 1× |
| Tribe (`Bot`) | 10,000 | ⅓ base | 0.5× |
| Easy nation | 12,500 | 0.5× base | 0.9× |
| Medium nation | 18,750 | 0.75× base | 0.95× |
| Hard nation | 25,000 | 1× base | 1× |
| Impossible nation | 31,250 | 1.25× base | 1.05× |

The base includes territory and completed City-level capacity. Growth also depends on **current reserve and its distance from that actor's capacity**; the last column is not a constant ratio of observed troop income between actors. Internal troops divide by ten for display.

Easy gives the human twice a nation's initial army and capacity under otherwise equal conditions. Impossible reverses the capacity/start advantage. Regular nation-AI decision scheduling is also difficulty-dependent: **65–99 ticks on Easy versus 30–49 on Impossible**, before its other checks and separate structure/ship behavior (`NationExecution.ts:51-89,173-207`). Tribes retain their own seeded 40–79-tick scheduling and ratios (`TribeExecution.ts:21-29`); calling them “Easy tribes” must not imply that every tribe mechanic receives the nation handicap.

**Keep these native rules unchanged** for the practical question “can our Human agent beat the shipped AI?” A result should name the actor types and difficulty, not call this equal-stat policy isolation. Hard has the listed statistical parity, but still does not equalize available behavior, perception, diplomacy or actions. The [Impossible native pilot](benchmark-native-pilot.md) substitutes `NationExecution` and Nation stats for the Human slot, permits all native behaviors, relocates its seeded spawn and adds setup ticks. It is a useful separately labelled comparator, **not an identical-slot Human policy, a Jev control, or the unbeatable ceiling**. It also uses Onion/no tribes, not this Europe roster. Do not port its 0/3 result into a Europe/Easy comparison.

## 2. Twelve tribes and three selected nations are a reduced custom scenario

The focused runner fixes **12 tribes and England/Spain/Switzerland** on Europe Compact, rather than the earlier browser configuration of **400 tribes/five nations**. The three names are selected before seed generation; `NationCreation` shuffles those three, but cannot introduce the other Europe nations. The checked Europe manifest contains **52** nations; the engine's Singleplayer `nations:"default"` path uses the supplied manifest, unlike the Public-Compact reduced-count path (`NationCreation.ts:32-107`). This benchmark is neither that default nation roster nor the 400-tribe browser scenario.

Going from 400 to 12 is a **33⅓-fold change in tribe count on the same terrain**, affecting early contacts, wilderness availability, troop packing, bounties, nation expansion, border pressure and target observation coverage. It is not safe to assume monotonic difficulty: more tribes can constrain expansion but also supply more conquest gold; fewer can make wilderness easier but leave nations room to grow. We cannot attribute the v4.4→v4.5.1 conquest difference solely to the prompt or focus history when roster, spawn and cadence changed too.

Recommendation: keep the small scenario as a named **reduced-roster Easy milestone**. After it yields complete wins, run a separately locked dense panel matching the approved browser roster, then harder native difficulties. Do not silently increase bot count in an existing seed panel or call a reduced Easy win evidence of beating the strongest bots. A 400-tribe world also needs actual adapter/menu-capacity checks; sparse-roster coverage alone does not verify that dense observations remain representable and correctly tribe-gated.

## 3. France is a fixed opening, not a random-map sample

Human spawn **(543,491)** is exactly the Europe manifest France coordinate after Compact scaling: floor((1087,983)/2). The human does not have a France nation opponent in this selected roster. England, Spain and Switzerland have seeded placement near their manifest cells, not necessarily the exact manifest center (`NationExecution.ts:100-163,260-289`); record the actual settled coordinates.

All held-out seeds below therefore test **new native identities/spawns/AI phases on the same map and human opening**, not new human spawn locations or terrain. This is useful for separating seed robustness from an untested setup change, but cannot establish map/spawn generalization. France's land/water access, proximity to Spain/Switzerland, missing neighboring nations and available wilderness can be unusually favorable or unfavorable. Static passable-tile legality alone does not establish a comparable opening.

For a later panel, predeclare several legal mainland/coastal/island spawn strata and another map, before inspecting results. Do not relocate after observing a poor opening or omit seeds with difficult contact. That broader panel needs new harness configuration support: the current focused CLI exposes `--seed`, not map/spawn/roster overrides. “New seed” does **not** randomize its fixed human spawn.

## 4. Pairing is good reproducibility, not automatic causal isolation

The focused and deterministic-control constructors use fresh map buffers, the same seeded Human ID and nation creation sequence, actual `TribeSpawner`, normal spawn/attack intents, and real WinCheck. The control script already checks equality of native IDs and settled spawns between its own arms. This avoids the mutable terrain-loader cache trap.

For each future candidate/control pair, assert equal **entire setup metadata**: engine/agent commits, terrain/manifest hashes, config and actor types, human ID/coordinate, complete native roster/IDs/coordinates, initial armies/gold/City levels, and observation-start tick. The focused report currently saves opponents' roster but not its own stable ID or each actor's initial stats; its first human snapshot records some of these. Cross-script pairing must be checked, not inferred from a matching seed label. A HEAD hash alone does not capture uncommitted engine/core changes or agent overlays: freeze the actual executable sources and record relevant dirty-tree differences/fingerprints. A locally installed client bridge must not be mistaken for an upstream core revision.

Different human actions should make later native decisions diverge; requiring identical post-action traces would erase the experimental effect. Pairing reduces setup variation, but does not make an external Jev answer deterministic or guarantee independent outcomes. Record all model/version metadata and failures. Repeat a seed when diagnosing reproducibility, but do not count it as an additional independent held-out seed or repeatedly select its best result.

An offline first-offered mock and a fixed-20 wilderness control are integration/weak-policy references, not native-strength measurements or the agent's strategy. A City-capable candidate against a land-only control measures the **whole candidate package**, not the isolated City value or a pure prompt improvement. Use a fixed matched action envelope if causal action/prompt attribution is needed; do not silently give the reference native AI or hidden heuristic rescue.

## 5. A full five-minute result still has important boundaries

- **Win definition:** native `WinCheckExecution.ts:89-152` chooses the leading alive player at timer expiry, or earlier after its land-share condition. A five-minute timer win need not mean all opponents were conquered, nor even that most of the map was held. Save winner, Win event and **timer versus land-share rule**, own and opponent land shares/standings, not just tribe gold or survival. The focused report currently lacks final opponent standings and an explicit win-rule label.
- **Censoring:** the 90-call result is explicitly incomplete. The current runner also stops immediately if the human dies before a Win event; that is a confirmed human elimination but **not a completed engine-winner record**. To finish that record would require separately implemented, bounded empty-turn collection through WinCheck after human elimination, not a substitute policy. Until then retain the elimination label and missing winner honestly.
- **Budget:** a five-minute, once-per-game-second run can need **300** decisions. `--max-calls 300`, `--max-ticks 3050`, `--minutes 5` are reasonable proposed hard bounds for this existing focused runner, with its existing bounded empty-turn WinCheck grace and no 301st decision. A call cap, error or timer grace failure remains explicitly incomplete; do not manufacture a full result by reducing the timer, retrying choices or running a heuristic remainder.
- **Cadence:** native ticks pause during headless inference. Single-flight and ≥1-second wall-clock request starts are safety facts, not proof of browser equivalence. The frozen observation gives the human no game-state movement while thinking; browser play can have stale snapshots and incoming pressure during inference. Longer wall time cannot be counted as more simulated tactical pressure. Validate browser cadence separately before claiming that competitive outcome transfers.
- **Action coverage:** the focused runner remains land-only. C's inspected hybrid file is a **mock-only, one-choice City seam**, with no full live match executor yet. A worker-legal candidate, an actual mock City build, a real model City selection, and a completed hybrid match are separate milestones. Boats, Posts, upgrades and Copilot are not assumed deployed because a proposed design contains them.
- **Denominator:** publish all three scheduled slots, including completed wins/losses, eliminations, caps and model/legality errors. Do not hide inconvenient incomplete seeds and quote only completed survivors as a representative win rate. Even 3/3 complete wins would be an encouraging smoke panel, not a credible global win-rate estimate or strongest-native claim.

## Proposed first three held-out Easy seeds

Freeze the candidate, executable harness, input/menu schema and model settings **before the first run**. Do not mix policy revisions within this panel. If the current hybrid executor is not complete and tested, use the actual land runner and label the panel land-only, or defer it—do not turn the City-only mock seam into a claimed hybrid strategy.

| Scheduled slot | Game ID / seed | Engine `simpleHash` | Proposed config |
| --- | --- | ---: | --- |
| 1 | `easy-heldout-europe-001` | 801671557 | Europe / Compact / Easy, reduced fixed roster below |
| 2 | `easy-heldout-europe-002` | 801671558 | Identical config; new native seed |
| 3 | `easy-heldout-europe-003` | 801671559 | Identical config; new native seed |

These exact strings were absent from local `docs/`, `scripts/`, `tests/` and `logs/` during this read-only review; their distinct hashes were calculated without instantiating a game. This is **local non-use evidence**, not proof about external runs or model training. Seeds are declared before seeing their spawn rosters or outcomes. If they influence subsequent prompt/action tuning, they become development seeds; use a newly declared panel for the next held-out claim. The engine PRNG diffuses sequential input seeds, but these remain three samples of one fixed map/config, not independent maps.

**First-panel config, deliberately unchanged from the milestone:**

- Production Europe Compact: fresh `map4x.bin` (1452×836, 568,335 land tiles), `map16x.bin`, current manifest, Singleplayer FFA.
- One normal **Human**, fixed spawn **(543,491)**, default starting gold/troops, no injected economy; 12 native **Bot tribes**, three native **Easy nations** named England/Spain/Switzerland; all 15 opponents must actually spawn.
- Five-minute timer, normal win threshold, `randomSpawn:false`, no infinite troops/gold or instant builds, donation settings unchanged. Record resolved relevant engine defaults, including spawn immunity and disabled units, rather than imply omitted settings are zero/disabled.
- Up to 300 single-flight decision attempts per explicitly authorized Start session and 3,050 live ticks; zero automatic retries/fallbacks. Stop/revoke on errors. No Copilot or new model unless separately approved and recorded in the frozen package.
- Pair a disclosed offline control using the same setup constructor/config/seed, with fresh maps and setup equality assertions. Actual seeded native opponents remain in every arm. If paid reference-policy pairing is wanted, budget and authorize it separately; it is not part of this proposal's implicit permission.
- Publish a per-slot evidence chain: **real bounded model answer → selected ID → normal intent → actual engine execution/build/landing/conquest → Win event/rule**, with separate count/status fields. Missing stages remain missing. Keep raw reports ignored, never commit credentials or session tokens.

Inspected asset SHA-256 values to freeze for reproducibility (not new run hashes):

- `map4x.bin`: `bb78c04e50c086b3e302e7e4e5089cab2dc08a39517c4d601907fc0efcb2f2a7`
- `map16x.bin`: `e1f86e312066b1290adbb8a0c0488efd7a5a65198bfd37b4da15ea43b4b015ba`
- `manifest.json`: `4bc18123ce2aade9c3684a9fbca8cc63df071a4d6c666510478437bfb9fb9448`

**Why not change to 400 tribes or rotate maps in these first three?** The immediate missing evidence is a complete, repeatable Easy outcome following the first verified tribe bounty. Keeping config fixed answers that narrow next question without confounding it with a new roster/map and without demanding undeployed CLI options. It is not the final competitive benchmark. After full Easy wins, predeclare the dense browser-like roster and map/spawn panel; only then move to Medium/Hard/Impossible with frozen per-difficulty configurations. Any future execution still needs Moritz's explicit bounded approval.
