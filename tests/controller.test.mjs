import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { WildernessController } from "../web/controller.js";

function setup({ action = "attack_10", decide, canExpand } = {}) {
  let time = 0;
  const state = { tick: 100, troops: 2500, ready: true, ended: false };
  const sent = [],
    observed = [],
    events = [],
    timers = [];
  const controller = new WildernessController(
    {
      read: () => ({ ...state }),
      canExpand: canExpand || (async () => true),
      attack: (fraction) => {
        sent.push(fraction);
        return true;
      },
    },
    {
      decide: async (observation, signal) => {
        observed.push(observation);
        if (decide) return decide(observation, signal);
        return { action, confidence: 0.9, probabilities: {}, latencyMs: 500 };
      },
      onUpdate: (event) => events.push(event),
      setTimer: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimer: (callback) => {
        const i = timers.indexOf(callback);
        if (i >= 0) timers.splice(i, 1);
      },
      now: () => time,
    },
  );
  return {
    controller,
    state,
    sent,
    observed,
    events,
    timers,
    setTime: (value) => {
      time = value;
    },
  };
}

for (const [action, expected] of [
  ["wait", []],
  ["attack_0", []],
  ["attack_10", [0.1]],
  ["attack_20", [0.2]],
]) {
  test(`${action} maps to the bounded action; only troops reach Jev`, async () => {
    const s = setup({ action });
    s.controller.start({ limit: 1 });
    await setImmediate();
    assert.deepEqual(s.observed, [{ troops: 2500 }]);
    assert.deepEqual(s.sent, expected);
    assert.equal(s.controller.running, false);
    assert.equal(s.timers.length, 0);
  });
}

test("stopping during inference prevents the late response from acting", async () => {
  let resolve, signal;
  const s = setup({
    decide: (_state, sig) => {
      signal = sig;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  s.controller.start();
  await setImmediate();
  s.controller.stop();
  assert.equal(signal.aborted, true);
  resolve({ action: "attack_20" });
  await setImmediate();
  assert.deepEqual(s.sent, []);
  assert.equal(s.timers.length, 0);
});

test("stale model responses do not act", async () => {
  let resolve;
  const s = setup({
    decide: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  s.controller.start({ limit: 1 });
  await setImmediate();
  s.setTime(2500);
  s.state.tick += 25;
  resolve({ action: "attack_20" });
  await setImmediate();
  assert.deepEqual(s.sent, []);
  assert.match(s.events.find((e) => e.decision).decision.outcome, /discarded/);
});

test("no wilderness stops without spending an API request", async () => {
  const s = setup({ canExpand: async () => false });
  s.controller.start();
  await setImmediate();
  assert.equal(s.controller.running, false);
  assert.deepEqual(s.observed, []);
});

test("spawn/pause waits without a model request; a stalled tick does not repeat requests", async () => {
  const s = setup({ action: "wait" });
  s.state.ready = false;
  s.controller.start();
  await setImmediate();
  assert.equal(s.observed.length, 0);
  s.state.ready = true;
  s.timers.shift()();
  await setImmediate();
  assert.equal(s.observed.length, 1);
  s.timers.shift()();
  await setImmediate();
  assert.equal(s.observed.length, 1);
  s.controller.stop();
});

test("invalid actions and network errors stop without sending attacks", async () => {
  for (const decide of [
    async () => ({ action: "attack_100" }),
    async () => {
      throw new Error("unavailable");
    },
  ]) {
    const s = setup({ decide });
    s.controller.start();
    await setImmediate();
    assert.equal(s.controller.running, false);
    assert.deepEqual(s.sent, []);
  }
});

test("wilderness disappearing during inference suppresses the attack", async () => {
  let queries = 0;
  const s = setup({ canExpand: async () => ++queries === 1 });
  s.controller.start({ limit: 1 });
  await setImmediate();
  assert.deepEqual(s.sent, []);
  assert.equal(queries, 2);
});

test("game ending during a request prevents action", async () => {
  let resolve;
  const s = setup({
    decide: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  s.controller.start({ limit: 1 });
  await setImmediate();
  s.state.ended = true;
  resolve({ action: "attack_20" });
  await setImmediate();
  assert.deepEqual(s.sent, []);
});
