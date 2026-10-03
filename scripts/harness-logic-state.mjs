// Read-only evidence for the living harness diagram. Never imports policy code,
// starts a controller, reads credentials, or makes an inference request.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const LOGIC_SOURCES = [
  'src/policy.mjs', 'src/hybrid-policy.mjs', 'src/naval-decomposed-policy.mjs',
  'web/observation.js', 'web/naval-observation.js', 'web/controller.js',
  'web/hybrid-controller.js', 'web/tribe-focus.js', 'web/neighbor-defenses.js',
  'web/game-adapter.js', 'web/building-adapter.js', 'web/defense-post-adapter.js',
  'web/naval-adapter.js', 'web/spatial-map.js', 'web/naval-spatial.js',
  'web/hybrid-observation.js', 'web/defense-observation.js',
  'scripts/harness-logic-examples.mjs',
];

export function instructionsFrom(source) {
  return [...source.matchAll(/instructions:\s*\[([\s\S]*?)\n\s*\]/g)].map((block) =>
    [...block[1].matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/gm)].map((line) => JSON.parse(line[1])),
  ).filter((lines) => lines.length);
}

function version(source, name) {
  return source.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`))?.[1] ?? 'unavailable';
}

export async function readLogicState({ repoUrl = new URL('../', import.meta.url), fetchHealth = fetch } = {}) {
  const sources = await Promise.all(LOGIC_SOURCES.map(async (path) => [path, await readFile(new URL(path, repoUrl), 'utf8')]));
  const files = Object.fromEntries(sources);
  const fingerprint = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  let runtime = null;
  try {
    // Exactly one fixed loopback GET. Timeout/offline means unknown, not disabled.
    const response = await fetchHealth('http://127.0.0.1:8788/health', { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) throw new Error('health unavailable');
    const value = await response.json();
    const flags = ['hybridEnabled', 'navalEnabled', 'defensePostEnabled', 'decomposedNavalLiveEnabled', 'plannerEnabled', 'sessionActive', 'requiresStart'];
    runtime = Object.fromEntries(flags.map((key) => [key, typeof value[key] === 'boolean' ? value[key] : null]));
    for (const key of ['policy', 'hybridPolicy', 'plannerStatus']) runtime[key] = typeof value[key] === 'string' ? value[key].slice(0, 160) : null;
  } catch { /* offline health is explicitly shown as unknown */ }
  return {
    checkedAt: new Date().toISOString(), fingerprint,
    repository: {
      landVersion: version(files['src/policy.mjs'], 'POLICY_VERSION'),
      hybridVersion: version(files['src/hybrid-policy.mjs'], 'HYBRID_POLICY_VERSION'),
      navalVersion: version(files['src/naval-decomposed-policy.mjs'], 'NAVAL_DECOMPOSED_POLICY_VERSION'),
      landInstructions: instructionsFrom(files['src/policy.mjs']).flat(),
      hybridInstructions: instructionsFrom(files['src/hybrid-policy.mjs']),
      navalInstructions: instructionsFrom(files['src/naval-decomposed-policy.mjs']),
    },
    runtime,
  };
}
