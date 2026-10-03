# OpenFront · Jev + Copilot hybrid agent (in development)

Current playable slice: a local-solo OpenFront bot using TypeSafe Jev to select bounded land actions. **Current policy: `land-strategy-v4.5.1-reference-clock-clarity`.** Transparent pre-inference user-strategy gates keep an unfinished tribe focus before opening another front, and withhold nations while unallied bordering tribes remain. Jev compares 10%, 20% and wait using factual focus progress; tribes remain capped at 20%, and home defense includes combined incoming force. This is **not yet a competitive hybrid bot**: an opt-in local Hybrid panel can offer worker-checked City candidates beside land attacks, and four legal City sites were offered in a bounded real-model match with custom 1M starting gold. Jev chose wait/save gold rather than build; no City intent or accepted construction has been observed. An opt-in server-owned Copilot planner is wired but has produced **no valid plan**: safe SDK diagnostics found GitHub authorization 403. The sidecar now refuses ambient auth fallback and requires a server-only `COPILOT_GITHUB_TOKEN` with Copilot Requests permission; no Copilot-guided game decision has been observed. A separate opt-in worker-checked transport path exists, but no real Jev-selected boat intent/landing has been verified; earlier inference sometimes returned HTTP 529. See the [hybrid spatial design](docs/hybrid-agent-design.html) and [primary-source Jev guidance](docs/jev-founder-guidance.md).

**Latest observed milestone:** a bounded real Jev **Easy Europe/Compact** run finished one native tribe and collected **7,350 conquest gold** through an actual engine ConquestEvent. Three normal tribe sends were all 20%; there were no new fronts during that fight. The 90-call, land-only headless run was **censored, not a match win**, and pauses engine ticks during inference. No completed Easy/higher-difficulty Jev win or live model-selected City/Post/boat outcome is established. See [exact scenario and evidence](docs/focus-easy-v4.5.1-validation.md), [current harness visualization](docs/harness-logic.html), and [nation one-send limits](docs/nation-one-send.md).

## What Jev sees and can do

The observation describes:

- **Us:** available troops, capacity, territory size, optional exact decimal gold, computed reserve percentage and troop density.
- **Persistent tribe focus:** authoritative target alive/strength/border facts and optional progress, including emitted land-intent count and territory delta. The reference tick/tiles are the associated decision-observation snapshot, not emission time; history is unknown when only recovering an already active attack.
- **Our border:** cardinal edge counts and shares touching wilderness, players, water, or blocked terrain/map boundaries.
- **Each directly bordering player:** numeric ID, human/nation/tribe type, ally/teammate/unallied relationship, shared border, troops, capacity, territory size, reserve percentage, troop density, current attack legality, and attackers currently attacking that neighbor.
- **Attacks on us:** attacker ID/type/reserve, attacking troops and retreat status, including attackers outside the neighbor list. The attacker comparison counts their home reserve once **plus** all active forces incoming to us.
- **Outgoing land attacks:** target, troops and retreat status, including whether a wilderness push is already running and how many troops we have committed to a neighboring target.

Code computes ratios rather than asking Jev to do arithmetic. Troop counts are in display units (internal troops / 10, rounded down). The game supplies capacity through `Config.maxTroops(player)`.

A single Choice selects among the current legal candidates:

```text
wait
attack_wilderness_10
attack_wilderness_20
attack_wilderness_30
attack_wilderness_40
attack_wilderness_50
attack_player_71_10
attack_player_71_20
...for a legal nation/human target, also attack_player_71_30/_40/_50
...for a tribe target, only _10/_20
```

Wilderness options are absent when there is no adjacent claimable wilderness. Allied, teammate, and currently immune/non-attackable players are not attack candidates. Each attack option includes its estimated troop commitment, remaining reserve, reserve percentage after the send, and committed-force/defender-troops ratio. **0% is collapsed into wait** rather than duplicated per target.

The model selects the offered action. The harness never substitutes another target/amount or imposes the earlier numeric 30% reserve strategy. **User-authored strategy gates apply transparently before inference**, with withheld target IDs/reasons exposed in model state, panel and logs: an alive tribe focus permits same-target/wait or explicit lost-border wilderness reconnection; unfinished tribe stacks cannot open a new tribe front; unallied bordering tribes withhold nations, not humans when no tribe fight is underway. Hard constraints also enforce the ≤20% tribe ceiling and current legality. It checks membership in the offered choices, freshness, and real game legality before emitting a normal attack intent. See [the schema, execution contract, and live results](docs/land-v3.md).

## Run

Requires Node 22+, the sibling `../OpenFrontIO` checkout and its installed dependencies. Run `npm ci` to install the pinned official GitHub Copilot SDK dependency; the standard land mode does not call Copilot.

```bash
cd ~/dev/openfront-agent
npm run install:bridge
set +x
source ~/.secrets
npm start
```

The sidecar reads `TYPESAFE_AI_API_KEY`, listens on `127.0.0.1:8788`, and calls `https://api.typesafe.ai/v1/systemone` only after an explicit local Start. It requires a short-lived session token for every paid land/hybrid decision; Stop or the call cap revokes it. The key remains server-side and is not logged. Optional `TYPESAFE_MODEL` overrides `jev-latest`. The pinned official Copilot SDK is called only if both local Hybrid and Copilot flags are enabled, an explicit `COPILOT_GITHUB_TOKEN` is configured server-side, and **Start Hybrid** is clicked; it has a separate three-attempt-per-Start cap and shares the application-level model single-flight lock. Without that token `/health` reports `plannerStatus: token_missing` and no Copilot call is attempted.

Start OpenFront in another terminal if needed:

```bash
cd ~/dev/OpenFrontIO
SKIP_BROWSER_OPEN=true npm run dev
```

Open **http://localhost:9000/** in hardware-accelerated Chrome, start a **Solo** match, spawn, and click **Start Jev** in the panel. No model requests happen before Start. For the separate experimental **Start Hybrid** button, start the sidecar with `OPENFRONT_HYBRID_EXPERIMENT=1 npm start` and restart the match. Hybrid normally scans City/coast/Post opportunities every 15 seconds, **not** every Jev call; stranded or absent-site cases can recheck after five seconds. Before the expensive City or Post scan, the real worker computes the current build cost; unaffordable actions are omitted for that tick. Without an owned shore, a cheap worker-border preflight skips the full naval map pass and checks again within five seconds. When no legal land action or naval site exists, coast/structure scans can also advance to five-second spacing. Expired and zero-eligible scans are distinguished in the panel. To also permit port-free transport-boat choices, enable both `OPENFRONT_HYBRID_EXPERIMENT=1 OPENFRONT_NAVAL_EXPERIMENT=1` on the sidecar; it will scan worker-checkable shores on that same bounded schedule. When no fresh legal City/boat candidate exists it transparently asks Jev the land-only question. Region/candidate omissions are displayed; geometry alone is not claimed to guarantee a route or landing. To opt into a strategic-plan attempt as well, set `COPILOT_GITHUB_TOKEN` in your local secrets (never in Git or the browser) and start with `OPENFRONT_HYBRID_EXPERIMENT=1 OPENFRONT_COPILOT_PLANNER=1 npm start`. The Node sidecar exclusively owns the validated plan; the browser cannot supply an objective or credentials. Earlier ambient-auth SDK attempts produced typed GitHub authorization 403 without a plan. The sidecar now uses only the explicit Copilot token, so its success with that credential is still **unverified**; a failed plan never becomes a fabricated objective. Jev continues without one. A Copilot call can pause Jev for up to its 15-second timeout; do not infer non-overlap of the SDK's internal provider requests from our application-level single-flight guard. The panel shows model state, offered candidates, decision probabilities, actions, and failures.

- Default: one request per second, measured start-to-start, at most 30 calls per Start. Both are adjustable.
- At most one in flight. Slow responses delay the next call; missed periods are never queued/caught up.
- The sidecar independently enforces single-flight and one-second upstream start spacing.
- Only loopback-hosted development singleplayer is supported. Standard mode emits land attacks only. Opt-in Hybrid can emit normal **City**, separately flagged **TransportShip** and **Defense Post** intents after Jev selects opaque worker-checked sites/sizes and code revalidates them. Flags are `OPENFRONT_HYBRID_EXPERIMENT=1`, `OPENFRONT_NAVAL_EXPERIMENT=1`, `OPENFRONT_DEFENSE_POST_EXPERIMENT=1`, and optionally `OPENFRONT_DECOMPOSED_NAVAL_LIVE=1`. No live model-selected City, boat or Post intent has yet been verified. Upgrades, public/private multiplayer, replays, diplomacy and attack cancellation are not wired yet.
- If the sidecar starts after a match, start a new match to load the panel. After a schema/prompt/bridge update, reinstall the bridge if changed, restart the sidecar, and reload the game page. Older schemas are rejected, not guessed.

## Guards and lifecycle

The game-state adapter reads `GameView`, asks the simulation worker for borders and `PlayerActions.canAttack`, and rechecks the selected target immediately before sending. A disappeared border, new alliance, immunity, pause/death, changed validation tick, or stale observation prevents execution; it does not cause a fallback attack on someone else.

- Troops committed are 10–50% (in 10-point steps) of the **current internal troop pool at execution time**; tribe targets allow only 10% or 20%, rechecked against the live target type. Candidate counts are estimates from the earlier observation.
- Snapshot age is bounded by two seconds and 20 simulation ticks, including observation preparation time.
- Spawn/pause/stalled ticks do not spend API calls. If wait is the only option, the harness polls locally until legal attacks become available (e.g. immunity expires).
- Stops on death/victory, request cap, API/validation error, hidden tab, or explicit Stop. Teardown aborts pending work; late replies cannot act.
- No automatic API retries. An aborted request may already have consumed tokens.
- The model response must name an offered action and provide a valid probability distribution over exactly those options.
- Explicit bounds: 126 observed neighbors, 256 total attack records (our incoming/outgoing and neighbors' incoming), and a 64 KiB raw observation. A separate guard rejects more than 255 generated choices. Non-attackable neighbors do not consume action slots. Oversized observations/candidate sets fail rather than silently dropping targets.

## Files

| File                                   | Responsibility                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `web/observation.js`                   | Shared strict schema, computed features, dynamic action candidates                             |
| `web/game-adapter.js`                  | Border collection, worker legality queries, target-ID mapping and attack execution             |
| `src/policy.mjs`                       | Reviewed land-strategy prompt and Choice response validation                                  |
| `src/server.mjs`                       | Local HTTP service, Start sessions, credentials, TypeSafe calls, pacing and JSONL logging      |
| `web/controller.js`                    | Single-flight loop, snapshots, lifecycle, freshness and candidate validation                   |
| `web/hybrid-controller.js`             | Opt-in City/naval scans, bounded multi-Choice routing, fresh worker permits                   |
| `web/building-adapter.js`              | Worker-checked City shortlist, gold and pending-intent validation                              |
| `web/naval-spatial.js` / `web/naval-adapter.js` | Geographic coast prefilter and separately authoritative worker transport checks         |
| `web/defense-post-adapter.js` / `web/defense-observation.js` | Worker-checked Post sites and strictly labeled potential front coverage |
| `src/copilot-planner.mjs` / `src/plan-session.mjs` | Official SDK connector and server-owned bounded plan lifecycle                      |
| `web/agent.js`                         | In-game standard/Hybrid Start, Stop, session lifecycle and decision inspector                  |
| `integration/WildernessAgentBridge.ts` | Small dev-only connection to OpenFront; historical filename retained for upgrade compatibility |
| `scripts/install-bridge.mjs`           | Installs/removes that bridge and the client start/stop hook                                    |

The installer changes only a client bridge and five hook lines in `../OpenFrontIO/src/client/ClientGameRunner.ts`, not the deterministic core. Track the integration source here; never push to the upstream checkout. Set `OPENFRONT_DIR` for a different checkout. Remove with `node scripts/install-bridge.mjs --remove`.

Ignored `logs/decisions-*.jsonl` records the exact model state, prompt, offered candidates, response probabilities, resolved model, usage, upstream start time and latency. These are **inference records, not execution receipts**. The panel separately distinguishes sent intents from no-ops/discarded decisions; final application still belongs to the game's normal simulation.

## Land strategy: implemented experiment, not an evaluated winner

[Moritz's reviewed land priorities](docs/strategy-review.html) are in the current v4.2 experiment. It now observes incoming pressure, each neighbor's attackers, outgoing pushes and calculated post-send reserve; terrain and enemy Defense Post coverage are **not** present. The earlier v4 live trace repeatedly selected 30% wilderness attacks and collapsed reserves. A bounded v4.1 local run selected seven 10% wilderness attacks, 22 waits and one 10% tribe attack without reserve collapse. However, in a matched 30-second Impossible-nation benchmark, v4.1 sent only five attacks and captured 2,370 tiles versus 5,237 for a reckless 20%-per-second baseline. The v4.2 prompt removes the unconditional active-wilderness wait: in the same seed/30-second benchmark Jev sent 17 legal 10% wilderness intents, reached 4,828 tiles and retained 10,568 display troops; the baseline retained 1,088. Both runs were **censored** before a game win/loss, and the v4.2 actions are model choices, not harness substitutions. Ignored local evidence: `logs/jev-impossible-30-calls.json` and `logs/jev-impossible-v4.2-30-calls.json`. A subsequent **complete** five-minute Onion/Impossible match on that seed made 46 real Jev decisions (21 wilderness attacks, 25 waits), then found no legal land attack from second 46 onward. It owned the 6,505-tile starting island, remained alive but **lost the engine timer victory** to Outer Enclave (109,234 tiles, one City, two Defense Posts). The paired deterministic 20% control also lost on the same island. Those are complete observed engine results, not model-call counts or a claim that a prompt alone can solve water crossings. [The controlled naval mechanics study](docs/naval-mechanics.md) confirmed a normal transport-ship intent can launch port-free across Onion water and land; a small boat-enabled scripted control still lost all three five-minute Impossible seeds ([results](docs/benchmark-naval-control.md)). The opt-in local Hybrid controller now has a worker-checked boat action, but TypeSafe HTTP 529 prevented a real-model boat decision/intent in the first bounded browser attempts. Separately, a **mock-choice** adapter-to-engine check verified a normal boat intent and observed landing off the island; it is not Jev gameplay ([naval mechanics](docs/naval-mechanics.md)). `npm run analyze:combat` separately reproduces passive-tribe sizing cases (real engine, no Jev calls).

The [source-grounded Onion naval report](docs/naval-mechanics.md) distinguishes an engine-verified mock-selected boat landing from one real Jev judgment on an engine snapshot: Jev narrowly preferred the boat branch (0.51) but chose **wait** in its independent 56-option site/size Choice, so there was **no boat intent**. A follow-up timed out; TypeSafe HTTP 529 also stopped two bounded headed runs. `node scripts/probe-naval-decision.mjs` is dry by default; `--run --max-requests=1` starts one local authenticated session and makes exactly one Jev request using ignored, actual-engine snapshot evidence, without emitting a game action. Do not use a real-model judgment from that script as a gameplay result. The target/size-decomposed Choice is separately enabled for live **Hybrid** only with `OPENFRONT_DECOMPOSED_NAVAL_LIVE=1`; wait at any branch/target/size level still means no intent. Fixed-snapshot responses support investigating it, not a live landing or improved win rate.

## Checks and experiments

```bash
npm test
npm run install:bridge
npm run test:bridge
cd ../OpenFrontIO
npx tsc --noEmit
npx vitest run tests/client/ClientGameRunnerActions.test.ts tests/client/ClientGameRunnerMessages.test.ts tests/client/LocalServer.test.ts tests/core/game/TransportShipUtils.test.ts
```

The historical v3.1 amount-menu smoke test made five real requests with all five wilderness sizes offered. Jev chose 10% each time; the new 30/40/50% execution paths are covered by adapter/controller tests, not claimed as model-selected live moves in that test. Neutral instructions were checked unchanged byte-for-byte.

The v3 live test included a 30-decision opening and a separate 10-decision continuation after an idle interval. Jev first selected 10% wilderness expansion throughout. In the continuation it waited six times, made one wilderness attack, and selected three 20% attacks on neighboring players. Incoming attacks and changing target availability were present; player attacks were visible in the game. This verifies the expanded integration, not strategic quality. Full conditions and limitations are in [the v3 report](docs/land-v3.md).

Historical work (not instructions used by v3):

- [Reserve-v2 prompt and live validation](docs/reserve-v2-validation.md): numeric policy following was imperfect.
- [Engine-based opening comparison](docs/opening-analysis.md): deterministic reserve-policy baselines, separate from the live model. Reproduce with `npm run analyze:opening` or `npm run analyze:opening -- --smoke`; these make no Jev calls.
