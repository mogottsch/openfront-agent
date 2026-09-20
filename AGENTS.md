# Project workflow

- After each small, coherent iteration, run relevant checks, commit the changes, and push to this repository's configured origin. Moritz explicitly requested this workflow.
- Keep commits focused. Do not force-push or publish failing/untested changes as verified work.
- This is a public repository. Never commit API keys, secret files, `.env` files, or generated run logs. Keep TypeSafe credentials in the local Node service, not browser code.
- Track OpenFront integration source in `integration/` and installation logic in `scripts/`. `../OpenFrontIO` is a separate upstream checkout; do not push there. Update the integration source here, then use `npm run install:bridge` to deploy it locally.
- Do not expand the bot's observation or action scope without discussing the change with Moritz. Current approved input: own troops/capacity/territory, border contacts, neighboring players' strength/relationship/legality, incoming attacks, and precomputed ratios. Actions: wait or a 10%/20% land attack on wilderness or a legal bordering player. No boats, buildings, diplomacy, or attack cancellation yet.
- Moritz explicitly wants to observe Jev without a prescribed strategy before deriving the next strategy together. The v3 prompt contains only the goal and data/action semantics; do not restore the old 30% reserve rule or silently replace model choices with heuristics. Cadence (one second, single-flight) and legal execution belong to the harness.

## Checks

- `npm test` — dependency-free agent tests; no real API calls.
- After bridge changes, install it into the sibling checkout, then run `npx tsc --noEmit` there and relevant OpenFront tests (see `README.md`).
- For browser/gameplay changes, use a short, explicitly bounded local solo smoke test. Report the difference between mock tests, real model decisions, emitted intents, and observed game outcomes.
- Both the local game and the Jev sidecar may already be running. Check before starting duplicates. No API requests should occur until the user explicitly starts the controller.
