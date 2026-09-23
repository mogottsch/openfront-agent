# Project workflow

- After each small, coherent iteration, run relevant checks, commit the changes, and push to this repository's configured origin. Moritz explicitly requested this workflow.
- Keep commits focused. Do not force-push or publish failing/untested changes as verified work.
- This is a public repository. Never commit API keys, secret files, `.env` files, or generated run logs. Keep TypeSafe credentials in the local Node service, not browser code.
- Track OpenFront integration source in `integration/` and installation logic in `scripts/`. `../OpenFrontIO` is a separate upstream checkout; do not push there. Update the integration source here, then use `npm run install:bridge` to deploy it locally.
- Moritz has now authorized autonomous local development of a hybrid Jev + GitHub Copilot agent intended to beat the strongest native OpenFront bots, including spatial understanding, buildings, upgrades and strategic planning. Expand observations and actions in small, independently tested, clearly versioned slices; do not mistake proposed interfaces in `docs/hybrid-agent-design.html` for deployed features. Local solo remains the only approved execution environment; do not act in multiplayer or push to upstream OpenFront.
- The last committed land baseline was neutral v3; the expanded neutral v3.1 menu was uncommitted. The v4.2 land experiment adds incoming/outgoing attack observations, a tribe commitment ceiling of 20%, and a prompt based on Moritz's reviewed land priorities. Earlier v4 play repeatedly depleted troops; v4.1 overcorrected and waited excessively during a running push; v4.2 improved a paired 30-second Impossible-nation opening but has not demonstrated a full-match win. Do not silently replace Jev choices with heuristics or reinstate the old numeric 30% reserve rule. Cadence (one second start-to-start, single-flight), arithmetic, candidate coverage, and real-game legality belong to the harness. Differentiate observed game results from mocked tests and real model judgments.
- The Copilot connector requires an officially supported backend SDK/API. Keep both providers' credentials server-side. Any new model must return structured, validated planning or bounded candidate IDs, never arbitrary code or client-executed tool calls. Seeded actual-engine matches, including Impossible native bots, are required before claiming competitive performance.

## Checks

- `npm test` — dependency-free agent tests; no real API calls.
- After bridge changes, install it into the sibling checkout, then run `npx tsc --noEmit` there and relevant OpenFront tests (see `README.md`).
- For browser/gameplay changes, use a short, explicitly bounded local solo smoke test. Report the difference between mock tests, real model decisions, emitted intents, and observed game outcomes.
- Both the local game and the Jev sidecar may already be running. Check before starting duplicates. No API requests should occur until the user explicitly starts the controller.
