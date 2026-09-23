# OpenFront · Jev + Copilot hybrid agent (in development)

Current playable slice: a local-solo OpenFront bot using TypeSafe Jev to select bounded land actions. **Current experiment: `land-strategy-v4.2`.** Its reviewed land priorities favor growth-preserving wilderness expansion, a 20% tribe ceiling, contested-tribe conquest gold, and patient defense against combined incoming force. This is **not yet a competitive hybrid bot**: spatial building actions and the Copilot strategic planner are separately tested prototypes, not connected to live games. See the [hybrid spatial design](docs/hybrid-agent-design.html) and [primary-source Jev guidance](docs/jev-founder-guidance.md).

## What Jev sees and can do

The observation describes:

- **Us:** available troops, capacity, territory size, computed reserve percentage and troop density.
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

The model selects the action. The harness does not substitute a heuristic, prefer a target, or impose the earlier 30% reserve strategy. Hard constraints enforce the ≤20% tribe ceiling and current legality. It checks membership in the offered choices, freshness, and real game legality before emitting a normal attack intent. See [the schema, execution contract, and live results](docs/land-v3.md).

## Run

Requires Node 22+, the sibling `../OpenFrontIO` checkout and its installed dependencies. This project has no npm dependencies.

```bash
cd ~/dev/openfront-agent
npm run install:bridge
set +x
source ~/.secrets
npm start
```

The sidecar reads `TYPESAFE_AI_API_KEY`, listens on `127.0.0.1:8788`, and calls `https://api.typesafe.ai/v1/systemone`. The key remains server-side and is not logged. Optional `TYPESAFE_MODEL` overrides `jev-latest`.

Start OpenFront in another terminal if needed:

```bash
cd ~/dev/OpenFrontIO
SKIP_BROWSER_OPEN=true npm run dev
```

Open **http://localhost:9000/** in hardware-accelerated Chrome, start a **Solo** match, spawn, and click **Start Jev** in the panel. No model requests happen before Start. The panel exposes the exact model state and candidate descriptions under **Input and available actions**, plus recent decisions and outcomes.

- Default: one request per second, measured start-to-start, at most 30 calls per Start. Both are adjustable.
- At most one in flight. Slow responses delay the next call; missed periods are never queued/caught up.
- The sidecar independently enforces single-flight and one-second upstream start spacing.
- Only loopback-hosted development singleplayer is supported. No public/private multiplayer, replays, naval actions, building, diplomacy, or cancelling existing attacks in this version.
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
| `src/server.mjs`                       | Local HTTP service, credentials, TypeSafe calls, pacing and JSONL logging                      |
| `web/controller.js`                    | Single-flight loop, snapshots, lifecycle, freshness and candidate validation                   |
| `web/agent.js`                         | In-game controls and input/action/decision inspector                                           |
| `integration/WildernessAgentBridge.ts` | Small dev-only connection to OpenFront; historical filename retained for upgrade compatibility |
| `scripts/install-bridge.mjs`           | Installs/removes that bridge and the client start/stop hook                                    |

The installer changes only a client bridge and five hook lines in `../OpenFrontIO/src/client/ClientGameRunner.ts`, not the deterministic core. Track the integration source here; never push to the upstream checkout. Set `OPENFRONT_DIR` for a different checkout. Remove with `node scripts/install-bridge.mjs --remove`.

Ignored `logs/decisions-*.jsonl` records the exact model state, prompt, offered candidates, response probabilities, resolved model, usage, upstream start time and latency. These are **inference records, not execution receipts**. The panel separately distinguishes sent intents from no-ops/discarded decisions; final application still belongs to the game's normal simulation.

## Land strategy: implemented experiment, not an evaluated winner

[Moritz's reviewed land priorities](docs/strategy-review.html) are in the current v4.2 experiment. It now observes incoming pressure, each neighbor's attackers, outgoing pushes and calculated post-send reserve; terrain and enemy Defense Post coverage are **not** present. The earlier v4 live trace repeatedly selected 30% wilderness attacks and collapsed reserves. A bounded v4.1 local run selected seven 10% wilderness attacks, 22 waits and one 10% tribe attack without reserve collapse. However, in a matched 30-second Impossible-nation benchmark, v4.1 sent only five attacks and captured 2,370 tiles versus 5,237 for a reckless 20%-per-second baseline. The v4.2 prompt removes the unconditional active-wilderness wait: in the same seed/30-second benchmark Jev sent 17 legal 10% wilderness intents, reached 4,828 tiles and retained 10,568 display troops; the baseline retained 1,088. Both runs were **censored** before a game win/loss, and the v4.2 actions are model choices, not harness substitutions. Ignored local evidence: `logs/jev-impossible-30-calls.json` and `logs/jev-impossible-v4.2-30-calls.json`. These do not prove hardest-bot wins. `npm run analyze:combat` reproduces controlled passive-tribe sizing cases (real engine, no Jev calls).

## Checks and experiments

```bash
npm test
cd ../OpenFrontIO
npx tsc --noEmit
npx vitest run tests/client/ClientGameRunnerActions.test.ts tests/client/ClientGameRunnerMessages.test.ts tests/client/LocalServer.test.ts
```

The historical v3.1 amount-menu smoke test made five real requests with all five wilderness sizes offered. Jev chose 10% each time; the new 30/40/50% execution paths are covered by adapter/controller tests, not claimed as model-selected live moves in that test. Neutral instructions were checked unchanged byte-for-byte.

The v3 live test included a 30-decision opening and a separate 10-decision continuation after an idle interval. Jev first selected 10% wilderness expansion throughout. In the continuation it waited six times, made one wilderness attack, and selected three 20% attacks on neighboring players. Incoming attacks and changing target availability were present; player attacks were visible in the game. This verifies the expanded integration, not strategic quality. Full conditions and limitations are in [the v3 report](docs/land-v3.md).

Historical work (not instructions used by v3):

- [Reserve-v2 prompt and live validation](docs/reserve-v2-validation.md): numeric policy following was imperfect.
- [Engine-based opening comparison](docs/opening-analysis.md): deterministic reserve-policy baselines, separate from the live model. Reproduce with `npm run analyze:opening` or `npm run analyze:opening -- --smoke`; these make no Jev calls.
