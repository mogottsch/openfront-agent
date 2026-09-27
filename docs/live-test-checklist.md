# Moritz's local observation session — run sheet

**State:** prepared, not started by the agent. Moritz will start the game and click **Start Hybrid** himself when ready. No credentials are needed in the browser. This is an experimental Jev action agent, **not yet the full Jev + Copilot agent**: GitHub rejected the previous ambient Copilot login with authorization 403, and the current sidecar disables planning unless Moritz separately configures a server-only `COPILOT_GITHUB_TOKEN` with Copilot Requests permission.

## Preflight (agent, without starting a game)

- `npm test`, `npm run test:bridge`, OpenFront `npx tsc --noEmit` and focused bridge tests pass; bridge source and sibling installation match.
- Sidecar `/health` shows `requiresStart:true`, `sessionActive:false`, `hybridEnabled:true`, `navalEnabled:true`, `defensePostEnabled:true`, `decomposedNavalLiveEnabled:true`; `plannerEnabled:false` until Copilot auth is explicitly configured. A decision POST without Start returns 403.
- Game dev server at <http://localhost:9000/> responds. Browser needs headed hardware-accelerated Chrome. The user starts the match and clicks Start; none of these preflight checks spends model tokens.

## Choose a scenario together, not silently

**For critique of land play:** Europe, Solo, a few native Impossible nations and ample tribes. Standard starting gold tests the economy and whether Jev eventually builds once affordable. A custom 1M starting gold deliberately tests early City/Post decisions, **not** ordinary competitive opening economics.

**For testing water crossings:** Onion, Solo, native Impossible nations, preferably a known island spawn. Start Hybrid with naval flag on; otherwise land-only mode can be trapped after filling the island. A boat Choice is based on worker-confirmed launch but neither a real path nor successful landing is guaranteed at selection time.

The user's preferred map, difficulty, starting gold, speed and desired observation duration decide the run. Default panel limit is only 30 calls (~30 seconds); raise explicitly for a longer test (maximum 300 per Start, one request-start ≥1 second apart, single-flight). A 5-minute full match may outlast that call budget; do not claim victory from a partial session. **No automatic API retries:** TypeSafe HTTP 529 (overloaded) stops the controller; the user may choose to restart later, not a hidden fallback heuristic.

## What to watch and report

- **Available army vs troop capacity:** repeated sends, regrowth, reserve collapse or excessive waiting.
- **Priority:** wilderness, weak tribes, tribes another nation/human is attacking for conquest gold; ≤20% against any tribe even via boats.
- **Under attack:** our reserve compared with attacker reserve **plus** their forces already attacking us; no panic full-send.
- **City / Post:** whether the worker offered sites, whether Jev selected a build or save_gold, actual intent sent, construction seen and completed. Potential Defense Post coverage is geometry, not an observed attack route.
- **Boats:** target shortlist and omitted count, Jev branch/target/size vs wait, actual normal boat intent, unit launch, shore landing, later ownership. A model-probe Choice is not gameplay.
- **Mode and failure:** the panel's decision scope shows whether City/boat/Post sites are fresh, expired, unaffordable or unavailable. Normal full-map scans are on a bounded 15-second schedule; a cheap worker cost/shore preflight skips impossible scans, and stranded/no-site situations recheck within five seconds. If no legal action remains, local polling does not make paid inference calls. A stopped run is not silently continued.

Generated inference logs and browser evidence are ignored under `logs/` and must not be committed. Report *real model replies*, *emitted normal intents*, and *observed game changes/winner* separately; do not infer an effect from one without the next.
