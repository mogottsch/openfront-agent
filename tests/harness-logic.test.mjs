import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOGIC_SOURCES, instructionsFrom, readLogicState } from '../scripts/harness-logic-state.mjs';
import { createViewer } from '../scripts/serve-a-checkin.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'harness-logic-'));
  for (const path of LOGIC_SOURCES) {
    await mkdir(join(dir, path.split('/')[0]), { recursive: true });
    await writeFile(join(dir, path), '// source');
  }
  await writeFile(join(dir, 'src/policy.mjs'), 'export const POLICY_VERSION = "new-land";\nconst q = {instructions: [\n "Keep the army.",\n "Finish the \\"tribe\\".",\n ]};'.replaceAll('\\\\', '\\'));
  return { dir, repoUrl: pathToFileURL(`${dir}/`) };
}

test('extracts literal instructions only; never evaluates source code', () => {
  assert.deepEqual(instructionsFrom('instructions: [\n "Wait.",\n ...other.instructions,\n dangerous(),\n ]'), [['Wait.']]);
});

test('exposes current source versus running health with only a fixed read-only GET', async () => {
  const { repoUrl } = await fixture();
  const calls = [];
  const state = await readLogicState({ repoUrl, fetchHealth: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ policy: 'old-land', hybridEnabled: true, sessionActive: false, token: 'must-not-leak', keyConfigured: true, plannerEnabled: false }) };
  } });
  assert.equal(state.repository.landVersion, 'new-land');
  assert.equal(state.runtime.policy, 'old-land');
  assert.equal(state.runtime.sessionActive, false);
  assert.equal(state.runtime.navalEnabled, null);
  assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8788/health');
  assert.equal(calls[0].options.method, undefined); // fetch default is GET
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.stringify(state).includes('must-not-leak'), false);
  assert.equal(Object.hasOwn(state.runtime, 'keyConfigured'), false);
});

test('offline health is unknown; relevant source edits change review fingerprint', async () => {
  const { dir, repoUrl } = await fixture();
  const offline = async () => { throw new Error('offline'); };
  const first = await readLogicState({ repoUrl, fetchHealth: offline });
  assert.equal(first.runtime, null);
  await writeFile(join(dir, 'web/controller.js'), '// changed cadence');
  const second = await readLogicState({ repoUrl, fetchHealth: offline });
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('viewer serves progress and diagram, and blocks action endpoints, POST and traversal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-viewer-'));
  await writeFile(join(dir, 'index.html'), '<h1>Progress</h1>');
  let polls = 0;
  const server = createViewer({ stateDir: dir, getLogicState: async () => { polls++; return { runtime: null }; } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(base)).text(), /Progress/);
  const page = await fetch(`${base}/logic`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /Hard harness rules vs\. Jev judgments/);
  assert.deepEqual(await (await fetch(`${base}/logic-state`)).json(), { runtime: null });
  assert.equal(polls, 1);
  for (const path of ['/session', '/decision', '/plan', '/docs/..%2FAGENTS.md', '/docs/%2e%2e/secrets', '/logic-state?target=https://outside']) assert.equal((await fetch(`${base}${path}`)).status, 404);
  assert.equal((await fetch(`${base}/logic-state`, { method: 'POST' })).status, 404);
  assert.equal(polls, 1);
});

test('visual uses safe text insertion and makes source review/version boundaries visible', async () => {
  const page = await readFile(new URL('../docs/harness-logic.html', import.meta.url), 'utf8');
  assert.match(page, /reviewedFingerprint/);
  assert.match(page, /Repository land:/);
  assert.match(page, /running land:/);
  assert.match(page, /setInterval\(refresh,20000\)/);
  assert.doesNotMatch(page, /innerHTML|src="https?:/);
});
