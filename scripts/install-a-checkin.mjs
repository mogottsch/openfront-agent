#!/usr/bin/env node
/** Install the local user timer; no root, no repository-owned run logs. */
import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const unitDir = join(homedir(), '.config/systemd/user');
const serviceName = 'openfront-a-checkin.service';
const timerName = 'openfront-a-checkin.timer';
const viewerName = 'openfront-a-checkin-viewer.service';
const quote = (text) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

async function findPi() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const path = join(dir, 'pi');
    try { await access(path, constants.X_OK); return path; } catch { /* next PATH entry */ }
  }
  throw new Error('Could not find pi on PATH');
}

function systemctl(...args) {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
}

if (process.argv.includes('--remove')) {
  systemctl('disable', '--now', timerName, viewerName);
  console.log(`Disabled timer and viewer; local history and unit files are retained.`);
} else {
  const pi = await findPi();
  await mkdir(unitDir, { recursive: true });
  const service = `[Unit]\nDescription=Pi check-in with A (OpenFront)\n\n[Service]\nType=oneshot\nWorkingDirectory=${repo}\nEnvironment=PI_OFFLINE=1\nEnvironment=A_CHECKIN_PI_BIN=${quote(pi)}\nExecStart=${quote(process.execPath)} ${quote(join(repo, 'scripts/a-checkin.mjs'))}\nTimeoutStartSec=13min\n`;
  const timer = `[Unit]\nDescription=Check in with A every 15 minutes\n\n[Timer]\nOnCalendar=*:0/15\nAccuracySec=1s\nPersistent=true\nUnit=${serviceName}\n\n[Install]\nWantedBy=timers.target\n`;
  const viewer = `[Unit]\nDescription=Local HTML viewer for A check-ins\n\n[Service]\nType=simple\nExecStart=${quote(process.execPath)} ${quote(join(repo, 'scripts/serve-a-checkin.mjs'))}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(join(unitDir, serviceName), service);
  await writeFile(join(unitDir, timerName), timer);
  await writeFile(join(unitDir, viewerName), viewer);
  execFileSync(process.execPath, [join(repo, 'scripts/a-checkin.mjs'), '--init'], { stdio: 'inherit' });
  systemctl('daemon-reload');
  systemctl('enable', '--now', viewerName, timerName);
  console.log(`${basename(timerName)} enabled; viewer: http://127.0.0.1:18765/`);
}
