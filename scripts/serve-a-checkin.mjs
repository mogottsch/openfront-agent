#!/usr/bin/env node
/** Read-only, loopback-only viewer for the local check-in page. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicState } from './harness-logic-state.mjs';

const dir = process.env.A_CHECKIN_STATE_DIR || join(homedir(), '.local/state/openfront-agent/a-checkin');
const port = Number(process.env.A_CHECKIN_PORT || 18765);

export function createViewer({ stateDir = dir, getLogicState = readLogicState } = {}) {
  return createServer(async (req, res) => {
    const path = req.url;
    const doc = path?.match(/^\/docs\/([a-z0-9-]+\.(?:md|html))$/)?.[1];
    if (req.method !== 'GET' || !(['/', '/index.html', '/logic', '/logic-state'].includes(path) || doc)) {
      res.writeHead(404).end();
      return;
    }
    try {
      let body;
      let type = 'text/html; charset=utf-8';
      if (path === '/logic-state') {
        body = JSON.stringify(await getLogicState());
        type = 'application/json; charset=utf-8';
      } else if (path === '/logic') {
        body = await readFile(new URL('../docs/harness-logic.html', import.meta.url));
      } else if (doc) {
        body = await readFile(new URL(`../docs/${doc}`, import.meta.url));
        if (doc.endsWith('.md')) type = 'text/plain; charset=utf-8';
      } else body = await readFile(join(stateDir, 'index.html'));
      res.writeHead(200, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(path === '/logic' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" } : {}),
      });
      res.end(body);
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Local document or status unavailable.');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createViewer();
  server.listen(port, '127.0.0.1', () => console.log(`Progress: http://127.0.0.1:${server.address().port}/ · logic: /logic`));
}
