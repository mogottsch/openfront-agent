# OpenFront · Jev land-action experiment

A local-solo OpenFront bot using TypeSafe Jev to select bounded land actions. **Current policy: `land-observation-v3`.** It provides a goal (survive and gain territory), field definitions, and action descriptions—**no prescribed reserve target, opening sequence, or tactical strategy**.

## What Jev sees and can do

The observation describes:

- **Us:** available troops, capacity, territory size, computed reserve percentage and troop density.
- **Our border:** cardinal edge counts and shares touching wilderness, players, water, or blocked terrain/map boundaries.
- **Each directly bordering player:** numeric ID, human/nation/tribe type, ally/teammate/unallied relationship, shared border, troops, capacity, territory size, reserve percentage, troop density, troops attacking us, and current attack legality.
- **Incoming land attacks:** attacker ID, remaining troops, and retreat status, including attackers not currently in the neighbor list.

Code computes ratios rather than asking Jev to do arithmetic. Troop counts are in display units (internal troops / 10, rounded down). The game supplies capacity through `Config.maxTroops(player)`.

A single Choice selects among the current legal candidates:

```text
wait
attack_wilderness_10
attack_wilderness_20
attack_player_71_10
attack_player_71_20
...one pair per legal neighboring target
```

Wilderness options are absent when there is no adjacent claimable wilderness. Allied, teammate, and currently immune/non-attackable players are not attack candidates. Each attack option includes its estimated troop commitment, remaining reserve, and committed-force/defender-troops ratio. **0% is collapsed into wait** rather than duplicated per target.

The model selects the action. The harness does not substitute a heuristic, prefer a target, or impose the earlier 30% reserve strategy. It checks membership in the offered choices, freshness, and real game legality before emitting a normal attack intent. See [the schema, execution contract, and live results](docs/land-v3.md).

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

- Troops committed are 10% or 20% of the **current internal troop pool at execution time**. Candidate counts are estimates from the earlier observation.
- Snapshot age is bounded by two seconds and 20 simulation ticks, including observation preparation time.
- Spawn/pause/stalled ticks do not spend API calls. If wait is the only option, the harness polls locally until legal attacks become available (e.g. immunity expires).
- Stops on death/victory, request cap, API/validation error, hidden tab, or explicit Stop. Teardown aborts pending work; late replies cannot act.
- No automatic API retries. An aborted request may already have consumed tokens.
- The model response must name an offered action and provide a valid probability distribution over exactly those options.
- Explicit bounds: 126 neighbors, 256 incoming attacks, and a 64 KiB raw observation. Oversized observations fail rather than silently dropping targets. The neighbor bound keeps the Choice at or below the API's 255-option limit.

## Files

| File                                   | Responsibility                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `web/observation.js`                   | Shared strict schema, computed features, dynamic action candidates                             |
| `web/game-adapter.js`                  | Border collection, worker legality queries, target-ID mapping and attack execution             |
| `src/policy.mjs`                       | Minimal goal/semantics prompt and Choice response validation                                   |
| `src/server.mjs`                       | Local HTTP service, credentials, TypeSafe calls, pacing and JSONL logging                      |
| `web/controller.js`                    | Single-flight loop, snapshots, lifecycle, freshness and candidate validation                   |
| `web/agent.js`                         | In-game controls and input/action/decision inspector                                           |
| `integration/WildernessAgentBridge.ts` | Small dev-only connection to OpenFront; historical filename retained for upgrade compatibility |
| `scripts/install-bridge.mjs`           | Installs/removes that bridge and the client start/stop hook                                    |

The installer changes only a client bridge and five hook lines in `../OpenFrontIO/src/client/ClientGameRunner.ts`, not the deterministic core. Track the integration source here; never push to the upstream checkout. Set `OPENFRONT_DIR` for a different checkout. Remove with `node scripts/install-bridge.mjs --remove`.

Ignored `logs/decisions-*.jsonl` records the exact model state, prompt, offered candidates, response probabilities, resolved model, usage, upstream start time and latency. These are **inference records, not execution receipts**. The panel separately distinguishes sent intents from no-ops/discarded decisions; final application still belongs to the game's normal simulation.

## Checks and experiments

```bash
npm test
cd ../OpenFrontIO
npx tsc --noEmit
npx vitest run tests/client/ClientGameRunnerActions.test.ts tests/client/ClientGameRunnerMessages.test.ts tests/client/LocalServer.test.ts
```

The v3 live test included a 30-decision opening and a separate 10-decision continuation after an idle interval. Jev first selected 10% wilderness expansion throughout. In the continuation it waited six times, made one wilderness attack, and selected three 20% attacks on neighboring players. Incoming attacks and changing target availability were present; player attacks were visible in the game. This verifies the expanded integration, not strategic quality. Full conditions and limitations are in [the v3 report](docs/land-v3.md).

Historical work (not instructions used by v3):

- [Reserve-v2 prompt and live validation](docs/reserve-v2-validation.md): numeric policy following was imperfect.
- [Engine-based opening comparison](docs/opening-analysis.md): deterministic reserve-policy baselines, separate from the live model. Reproduce with `npm run analyze:opening` or `npm run analyze:opening -- --smoke`; these make no Jev calls.
