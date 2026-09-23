#!/usr/bin/env node
/** Read-only, loopback-only viewer for the local check-in page. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = process.env.A_CHECKIN_STATE_DIR || join(homedir(), '.local/state/openfront-agent/a-checkin');
const port = Number(process.env.A_CHECKIN_PORT || 18765);
const server = createServer(async (req, res) => {
  if (req.method !== 'GET' || !['/', '/index.html'].includes(req.url)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const page = await readFile(join(dir, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(page);
  } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Check-in log not initialized yet.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Check-in log: http://127.0.0.1:${server.address().port}/`));
