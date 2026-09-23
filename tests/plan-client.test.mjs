import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createPlanClient } from "../web/plan-client.js";
import { observation } from "./fixtures/land.mjs";

function setup() {
  const calls = [],
    timers = [];
  const state = { ready: true, ended: false, tick: 100 };
  let token = "local-session-only";
  let respond;
  const planResponse = new Promise((resolve) => {
    respond = resolve;
  });
  const plan = {
    objective: "Expand and invest in City capacity when affordable",
    source_tick: 100,
    expires_tick: 400,
    plan_version: 1,
  };
  const fetchImpl = async (url, opts) => {
    const body = opts.body && JSON.parse(opts.body);
    calls.push({
      path: new URL(url).pathname,
      method: opts.method,
      session: opts.headers["X-Agent-Session"],
      body,
    });
    if (new URL(url).pathname === "/plan" && opts.method === "POST")
      return planResponse;
    if (new URL(url).pathname === "/plan" && opts.method === "GET")
      return new Response(JSON.stringify({ plan }));
    if (new URL(url).pathname === "/plan/heartbeat")
      return new Response(JSON.stringify({ accepted: true }));
    throw new Error("Unexpected URL");
  };
  const client = createPlanClient({
    baseUrl: "http://127.0.0.1:8788/",
    read: () => state,
    getGameId: () => "solo-1",
    getGold: () => "200000",
    getToken: () => token,
    fetchImpl,
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: (fn) => {
      const i = timers.indexOf(fn);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    client,
    calls,
    timers,
    state,
    respond,
    plan,
    setToken: (value) => {
      token = value;
    },
  };
}

test("no browser Copilot request until explicit plan(); heartbeat runs while planning", async () => {
  const s = setup();
  assert.equal(s.calls.length, 0);
  assert.equal(await s.client.getPlan(), null);
  const pending = s.client.plan(
    { tick: 100, land: observation() },
    new AbortController().signal,
  );
  await setImmediate();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].path, "/plan");
  assert.equal(s.calls[0].session, "local-session-only");
  assert.deepEqual(s.calls[0].body.region_ids, []);
  assert.deepEqual(s.calls[0].body.summary.regions, []);
  assert.equal(s.calls[0].body.summary.troops, 2500);
  assert.equal(s.calls[0].body.summary.available_gold, "200000");
  assert.ok(!JSON.stringify(s.calls[0].body).includes("local-session-only"));
  assert.equal(s.timers.length, 1);
  s.state.tick = 101;
  s.timers[0]();
  await setImmediate();
  assert.deepEqual(s.calls[1].body, {
    game_id: "solo-1",
    tick: 101,
    region_ids: [],
  });
  s.respond(new Response(JSON.stringify({ plan: s.plan })));
  assert.deepEqual(await pending, s.plan);
  assert.equal(s.timers.length, 0);
  assert.deepEqual(await s.client.getPlan(), s.plan);
  s.client.stop();
  assert.equal(await s.client.getPlan(), null);
  assert.equal(s.calls.length, 3);
});

test("Stop/abort prevents a late strategic result from becoming active in browser", async () => {
  const s = setup();
  const signal = new AbortController();
  const pending = s.client.plan(
    { tick: 100, land: observation() },
    signal.signal,
  );
  await setImmediate();
  s.client.stop();
  signal.abort();
  s.respond(new Response(JSON.stringify({ plan: s.plan })));
  await assert.rejects(pending, /stale or unavailable/);
  assert.equal(s.timers.length, 0);
  assert.equal(await s.client.getPlan(), null);
});

test("missing Start token or invalid game facts cannot trigger Copilot", async () => {
  const s = setup();
  s.setToken(null);
  await assert.rejects(
    s.client.plan({ tick: 100, land: observation() }),
    /No explicit local Start/,
  );
  assert.equal(s.calls.length, 0);
  const q = setup();
  q.state.ready = false;
  await assert.rejects(
    q.client.plan({ tick: 100, land: observation() }),
    /Game changed/,
  );
  assert.equal(q.calls.length, 0);
});
