import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { WildernessController } from "../web/controller.js";

// Virtual time, including request/border-query completion: no real inference.
function harness({ latencies = [250], borderDelays = [], actions = [] } = {}) {
  let clock = 0;
  let timerId = 0;
  let borderIndex = 0;
  let active = 0;
  let maxActive = 0;
  const timers = new Map();
  const calls = [];
  const attacks = [];
  const setTimer = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { at: clock + delay, fn });
    return id;
  };
  const delay = (ms) => new Promise((resolve) => setTimer(resolve, ms));
  const controller = new WildernessController(
    {
      read: () => ({
        tick: Math.floor(clock / 100),
        troops: 2500 + Math.floor(clock / 10),
        troop_capacity: 12000 + Math.floor(clock / 20),
        ready: true,
        ended: false,
      }),
      canExpand: async () => {
        const ms = borderDelays[borderIndex++] ?? 0;
        if (ms) await delay(ms);
        return true;
      },
      attack: (fraction) => {
        attacks.push(fraction);
        return true;
      },
    },
    {
      now: () => clock,
      setTimer,
      clearTimer: (id) => timers.delete(id),
      decide: async (state) => {
        const index = calls.length;
        const call = { start: clock, state };
        calls.push(call);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          // Deliberately ignores AbortSignal: even an uncooperative late
          // response must not overlap a restarted run or apply its action.
          await delay(latencies[index] ?? 250);
          return { action: actions[index] ?? "wait" };
        } finally {
          call.end = clock;
          active--;
        }
      },
    },
  );
  const advanceTo = async (target) => {
    assert.ok(target >= clock);
    await setImmediate();
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      clock = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await setImmediate();
    }
    clock = target;
    await setImmediate();
  };
  return {
    controller,
    calls,
    attacks,
    timers,
    advanceTo,
    maxActive: () => maxActive,
  };
}

test("default cadence is request-start to request-start; slow calls never overlap or cause catch-up bursts", async () => {
  const h = harness({ latencies: [250, 600, 1400, 100, 250] });
  h.controller.start({ limit: 5 });
  await h.advanceTo(5000);
  assert.deepEqual(
    h.calls.map((c) => c.start),
    [0, 1000, 2000, 3400, 4400],
  );
  assert.deepEqual(
    h.calls.map((c) => c.state.troops),
    [2500, 2600, 2700, 2840, 2940],
  );
  assert.deepEqual(
    h.calls.map((c) => c.state.troop_capacity),
    [12000, 12050, 12100, 12170, 12220],
  );
  assert.equal(h.maxActive(), 1);
  assert.equal(h.controller.running, false);
  assert.equal(h.timers.size, 0);
});

test("slow border preparation does not shorten spacing between actual requests", async () => {
  const h = harness({ borderDelays: [300, 0, 150] });
  h.controller.start({ limit: 3 });
  await h.advanceTo(3000);
  assert.deepEqual(
    h.calls.map((c) => c.start),
    [300, 1300, 2450],
  );
  assert.equal(h.maxActive(), 1);
});

test("Stop cancels the scheduled wake-up", async () => {
  const h = harness();
  h.controller.start();
  await h.advanceTo(400);
  h.controller.stop();
  await h.advanceTo(10000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test("a quick Stop/Start preserves the previous request's one-second deadline", async () => {
  const h = harness();
  h.controller.start();
  await h.advanceTo(400);
  h.controller.stop();
  h.controller.start({ limit: 1 });
  await h.advanceTo(2000);
  assert.deepEqual(
    h.calls.map((c) => c.start),
    [0, 1000],
  );
  assert.equal(h.maxActive(), 1);
});

test("restarting with an outstanding request waits for it and discards its late action", async () => {
  const h = harness({ latencies: [1400, 250], actions: ["attack_20", "wait"] });
  h.controller.start();
  await h.advanceTo(200);
  h.controller.stop();
  h.controller.start({ limit: 1 });
  await h.advanceTo(2500);
  assert.deepEqual(
    h.calls.map((c) => c.start),
    [0, 1400],
  );
  assert.equal(h.maxActive(), 1);
  assert.deepEqual(h.attacks, []);
  assert.equal(h.controller.running, false);
});

test("a request exceeding the freshness limit is discarded and does not queue missed periods", async () => {
  const h = harness({ latencies: [2500, 250, 250], actions: ["attack_20"] });
  h.controller.start({ limit: 3 });
  await h.advanceTo(4000);
  assert.deepEqual(
    h.calls.map((c) => c.start),
    [0, 2500, 3500],
  );
  assert.equal(h.maxActive(), 1);
  assert.deepEqual(h.attacks, []);
});

test("the configured interval still supports slower experiments", async () => {
  const h = harness();
  h.controller.start({ intervalMs: 2000, limit: 2 });
  await h.advanceTo(3000);
  assert.deepEqual(
    h.calls.map((c) => c.start),
    [0, 2000],
  );
});
