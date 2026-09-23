#!/usr/bin/env node
// Synthetic one-turn probe. This file is NOT connected to OpenFront or its
// controller. Run only after Moritz explicitly approves a standalone model call.
import { createCopilotPlanner } from '../src/copilot-planner.mjs';

const flags = new Set(process.argv.slice(2));
const expectedFlags = new Set(['--run', '--moritz-approved-one-shot', '--max-requests=1']);
if ([...flags].some((flag) => !expectedFlags.has(flag))) {
  throw new Error('Unknown flag; only --run --moritz-approved-one-shot --max-requests=1 are supported');
}

if (!flags.has('--run')) {
  console.log('DRY RUN: official Copilot SDK planner remains inactive. A real model call requires Moritz’s explicit one-shot approval and all three flags: --run --moritz-approved-one-shot --max-requests=1. No game actions are connected.');
} else {
  if (!flags.has('--moritz-approved-one-shot') || !flags.has('--max-requests=1')) {
    throw new Error('No model call: explicit Moritz approval and a one-request cap are required');
  }
  // This asserts operator intent; it cannot substitute for actual user permission.
  // No retries and exactly one application-level SDK turn. The Copilot runtime
  // may make its own provider requests; inspect billing before authorizing.
  const snapshot = {
    game_id: 'synthetic-copilot-probe', tick: 420, observed_at_ms: Date.now(),
    region_ids: ['test-region'],
    summary: { synthetic: true, phase: 'test', gold: 950, pressure: 'unknown' },
  };
  const plan = createCopilotPlanner({
    model: 'gpt-5-mini', timeoutMs: 15_000, maxSnapshotAgeMs: 30_000,
  });
  const response = await plan({
    snapshot,
    getCurrentState: () => ({ game_id: snapshot.game_id, tick: snapshot.tick, plan_version: 0 }),
  });
  console.log(JSON.stringify({
    source: 'real Copilot model response to synthetic snapshot',
    schema: 'locally validated', plan_version: response.plan_version,
    objective: response.objective, region_priorities: response.region_priorities.length,
    engine_effects: 'none (no game connection or intents)',
  }));
}
