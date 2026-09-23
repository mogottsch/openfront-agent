#!/usr/bin/env node
/** A bounded, single-flight Pi check-in. Generated state stays outside the repo. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stateDir = process.env.A_CHECKIN_STATE_DIR || join(homedir(), '.local/state/openfront-agent/a-checkin');
const statePath = join(stateDir, 'history.json');
const htmlPath = join(stateDir, 'index.html');
const sessionDir = join(stateDir, 'sessions');
const timeoutMs = Number(process.env.A_CHECKIN_TIMEOUT_MS || 12 * 60_000);
const maxOutput = 12_000;

const prompt = `You are ACheckin, Moritz's scheduled 15-minute check-in, running in openfront-agent. This is a recurring, bounded session, not the project orchestrator. Use Pi Messenger: join/reconnect, rename yourself ACheckin if needed, inspect A's presence and recent feed, and ask A for a SHORT status and whether they are blocked, unless A already gave a status in the last 10 minutes. If there is an unanswered recent check-in, do not pile on another ping; inspect activity and wait until the next run instead. Check for replies to earlier check-ins, including after you last exited. If A reports a concrete blocker, coordinate with A and resolve it yourself when within the current approved scope. Ask A before touching their reserved paths; do not take over A's work. Follow AGENTS.md: no new gameplay observation/action scope or unapproved strategy, no OpenFront controller or Jev sidecar requests, run relevant checks, commit and push only focused verified changes. Do not spawn agents or Crew workers. If the blocker requires a user decision or is outside approval, do not guess; record it for the HTML log and leave it with A. No blocker alerts to Moritz and no routine broadcasts. Keep the check-in brief; you have at most 12 minutes. Finish with a concise plain-text report: A's status (or no response), blocker, your action/outcome, and any remaining limitation. No secrets in the report.`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function html(entries) {
  const rows = entries.map(({ started, finished, status, summary }) => `<article class="entry ${escapeHtml(status)}"><div class="meta"><time>${escapeHtml(started)}</time><span>${escapeHtml(status)}</span>${finished ? `<small>finished ${escapeHtml(finished)}</small>` : ''}</div><p>${escapeHtml(summary)}</p></article>`).join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="15"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>A · check-in log</title><style>body{font:15px/1.5 system-ui,sans-serif;background:#10191c;color:#dfedea;max-width:780px;margin:4vh auto;padding:0 20px}h1{font-size:1.4rem;margin-bottom:0}header p{color:#9fb4b1;margin-top:.2rem}.entry{border:1px solid #29403e;border-left:3px solid #6eaaa0;border-radius:5px;margin:12px 0;padding:12px 15px;background:#172426}.entry.error{border-left-color:#dd8d70}.entry.running{border-left-color:#e5bf74}.meta{display:flex;gap:12px;flex-wrap:wrap;color:#a7c0bb;font-size:.82rem}.meta span{text-transform:uppercase;letter-spacing:.07em}.entry p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0}</style><header><h1>A · check-in log</h1><p>Every 15 minutes · Pi / GPT-6 Luna · local only · refreshes automatically</p></header><main>${rows || '<p>No check-ins yet.</p>'}</main></html>\n`;
}

async function history() {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8'));
    return Array.isArray(value) ? value.slice(0, 40) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function save(entries) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (const [path, data] of [[statePath, JSON.stringify(entries.slice(0, 40), null, 2)], [htmlPath, html(entries.slice(0, 40))]]) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);
  }
}

async function runPi() {
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const args = ['--offline', '--approve', '--model', 'github-copilot/gpt-6-luna', '--session-dir', sessionDir,
    '--session-id', '5bf837b4-25aa-4bcc-a622-688853ba90bd', '--name', 'A Check-in', '-p', prompt];
  const child = spawn(process.env.A_CHECKIN_PI_BIN || 'pi', args, { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const append = (current, chunk) => (current + chunk).slice(-maxOutput);
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk.toString()); });
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString()); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  const result = await new Promise((done) => {
    child.once('error', (error) => done({ error }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  return { ...result, timedOut, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function main() {
  const entries = await history();
  if (process.argv.includes('--init')) { await save(entries); console.log(htmlPath); return; }
  const entry = { started: new Date().toISOString(), status: 'running', summary: 'Checking in with A…' };
  entries.unshift(entry);
  await save(entries);
  try {
    const result = await runPi();
    entry.status = result.code === 0 && !result.timedOut ? 'complete' : 'error';
    entry.summary = result.timedOut ? 'Timed out after 12 minutes; will resume next check-in.'
      : result.error ? `Could not start Pi: ${result.error.message}`
      : result.stdout || result.stderr || `Pi exited with code ${result.code ?? result.signal}.`;
    if (entry.status === 'error' && result.stderr && result.stdout) entry.summary += `\nError: ${result.stderr.slice(-1000)}`;
  } catch (error) {
    entry.status = 'error';
    entry.summary = `Check-in failed: ${error.message}`;
  }
  entry.finished = new Date().toISOString();
  await save(entries);
  console.log(`${entry.status}: ${entry.summary}`);
  if (entry.status === 'error') process.exitCode = 1;
}

await main();
