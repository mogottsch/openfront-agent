import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = join(repo, 'scripts/a-checkin.mjs');

async function fixture(code) {
  const root = await mkdtemp(join(tmpdir(), 'a-checkin-'));
  const pi = join(root, 'pi');
  await writeFile(pi, `#!/usr/bin/env node\n${code}\n`);
  await chmod(pi, 0o755);
  return { root, pi, state: join(root, 'state') };
}

test('initializes an empty, auto-refreshing local HTML page without calling Pi', async () => {
  const { state } = await fixture('throw new Error("must not launch")');
  const path = execFileSync(process.execPath, [script, '--init'], { env: { ...process.env, A_CHECKIN_STATE_DIR: state }, encoding: 'utf8' }).trim();
  assert.equal(path, join(state, 'index.html'));
  const page = await readFile(path, 'utf8');
  assert.match(page, /refresh" content="15"/);
  assert.match(page, /<h1>A · progress<\/h1>/);
  assert.deepEqual(JSON.parse(await readFile(join(state, 'history.json'), 'utf8')), []);
});

test('records bounded Pi summary, escapes HTML, and selects a dedicated Luna session', async () => {
  const { root, state, pi } = await fixture('process.stdout.write("A says <blocked> & working.\\n"); process.env.A_CHECKIN_STATE_DIR && require("node:fs").writeFileSync(require("node:path").join(process.env.A_CHECKIN_STATE_DIR,"args.json"),JSON.stringify(process.argv.slice(2)));');
  const result = spawnSync(process.execPath, [script], { env: { ...process.env, A_CHECKIN_STATE_DIR: state, A_CHECKIN_PI_BIN: pi }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const entries = JSON.parse(await readFile(join(state, 'history.json'), 'utf8'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'complete');
  assert.match(entries[0].summary, /<blocked>/);
  const page = await readFile(join(state, 'index.html'), 'utf8');
  assert.match(page, /&lt;blocked&gt; &amp; working/);
  assert.doesNotMatch(page, /<blocked>/);
  assert.match(page, /<time datetime="\d{4}-\d{2}-\d{2}T/);
  const args = JSON.parse(await readFile(join(state, 'args.json'), 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'github-copilot/gpt-6-luna']);
  assert.equal(args[args.indexOf('--session-dir') + 1], join(state, 'sessions'));
  assert.ok(args.includes('--session-id'));
  assert.ok(args.includes('-p'));
  assert.match(args.at(-1), /what moved forward since the last check-in/);
  assert.match(args.at(-1), /Avoid commit hashes, file names, test counts/);
  assert.match(args.at(-1), /If nothing new happened or A did not reply, say that plainly/);
  assert.ok(!args.includes('--no-session'));
  assert.ok(!result.stdout.includes('API_KEY'));
  assert.equal(root.startsWith(repo), false);
});

test('failed Pi invocation is visible in the page and exits nonzero', async () => {
  const { state, pi } = await fixture('process.stderr.write("test failure\\n"); process.exit(2)');
  const result = spawnSync(process.execPath, [script], { env: { ...process.env, A_CHECKIN_STATE_DIR: state, A_CHECKIN_PI_BIN: pi }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match((await readFile(join(state, 'index.html'), 'utf8')), /class="entry error"/);
});

test('installer writes a 15-minute user timer without scheduling a real run', async () => {
  const { root, pi } = await fixture('');
  const bin = join(root, 'bin');
  await mkdir(bin);
  const ctl = join(bin, 'systemctl');
  await writeFile(ctl, '#!/bin/sh\nexit 0\n');
  await chmod(ctl, 0o755);
  const result = spawnSync(process.execPath, [join(repo, 'scripts/install-a-checkin.mjs')], {
    env: { ...process.env, HOME: root, PATH: `${bin}:${root}:${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const unitDir = join(root, '.config/systemd/user');
  const service = await readFile(join(unitDir, 'openfront-a-checkin.service'), 'utf8');
  const timer = await readFile(join(unitDir, 'openfront-a-checkin.timer'), 'utf8');
  const viewer = await readFile(join(unitDir, 'openfront-a-checkin-viewer.service'), 'utf8');
  assert.match(timer, /OnCalendar=\*:0\/15/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /a-checkin\.mjs/);
  assert.match(service, new RegExp(pi.replaceAll('/', '\\/')));
  assert.match(viewer, /serve-a-checkin\.mjs/);
});
