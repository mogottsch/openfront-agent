import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { LandController } from "../web/controller.js";
import { observation } from "./fixtures/land.mjs";

function setup({ action = "attack_wilderness_10", decide } = {}) {
  let time = 0;
  const status = { tick: 100, ready: true, ended: false };
  const input = observation();
  const sent = [],
    observed = [],
    events = [],
    timers = [];
  const adapter = {
    read: () => ({ ...status }),
    observe: async () => ({ tick: status.tick, observation: input }),
    canExecute: async () => true,
    execute: (a) => {
      sent.push({ target: a.target_id, fraction: a.fraction });
      return true;
    },
  };
  const controller = new LandController(adapter, {
    decide: async (o, signal) => {
      observed.push(o);
      return decide
        ? decide(o, signal)
        : { action, confidence: 0.9, probabilities: {}, latencyMs: 200 };
    },
    onUpdate: (e) => events.push(e),
    now: () => time,
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: (callback) => {
      const i = timers.indexOf(callback);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    controller,
    adapter,
    status,
    input,
    sent,
    observed,
    events,
    timers,
    setTime: (v) => {
      time = v;
    },
  };
}

for (const [action, expected] of [
  ["wait", []],
  ["attack_wilderness_10", [{ target: null, fraction: 0.1 }]],
  ["attack_wilderness_20", [{ target: null, fraction: 0.2 }]],
  ["attack_wilderness_30", [{ target: null, fraction: 0.3 }]],
  ["attack_wilderness_40", [{ target: null, fraction: 0.4 }]],
  ["attack_wilderness_50", [{ target: null, fraction: 0.5 }]],
  ["attack_player_2_10", [{ target: 2, fraction: 0.1 }]],
  ["attack_player_2_20", [{ target: 2, fraction: 0.2 }]],
  ["attack_player_2_30", [{ target: 2, fraction: 0.3 }]],
  ["attack_player_2_40", [{ target: 2, fraction: 0.4 }]],
  ["attack_player_2_50", [{ target: 2, fraction: 0.5 }]],
])
  test(`${action} executes the offered bounded candidate with the complete observation`, async () => {
    const s = setup({ action });
    s.controller.start({ limit: 1 });
    await setImmediate();
    assert.deepEqual(s.observed, [s.input]);
    assert.deepEqual(s.sent, expected);
    assert.equal(s.controller.running, false);
    assert.equal(s.timers.length, 0);
  });

test("there is no reserve-strategy override, including a below-target player attack", async () => {
  const s = setup({ action: "attack_player_2_20" });
  s.controller.start({ limit: 1 });
  await setImmediate();
  assert.deepEqual(s.sent, [{ target: 2, fraction: 0.2 }]);
  assert.equal(
    s.events.find((e) => e.decision).decision.observation.self.reserve_percent,
    20.83,
  );
});

test("a player attack is available even with no wilderness", async () => {
  const s = setup({ action: "attack_player_2_10" });
  s.input.border.wilderness_edges = 0;
  s.input.border.total_edges -= 8;
  s.controller.start({ limit: 1 });
  await setImmediate();
  assert.deepEqual(s.sent, [{ target: 2, fraction: 0.1 }]);
});

test("wait-only states poll without spending API calls and can resume when legality changes", async () => {
  const s = setup({ action: "attack_player_2_10" });
  s.input.border.wilderness_edges = 0;
  s.input.border.total_edges -= 8;
  s.input.neighbors[0].can_attack = false;
  s.controller.start({ limit: 1 });
  await setImmediate();
  assert.equal(s.observed.length, 0);
  s.input.neighbors[0].can_attack = true;
  s.setTime(1000);
  s.status.tick += 10;
  s.timers.shift()();
  await setImmediate();
  assert.equal(s.observed.length, 1);
  assert.deepEqual(s.sent, [{ target: 2, fraction: 0.1 }]);
});

test("stopping during inference aborts and prevents late responses from acting", async () => {
  let resolve, signal;
  const s = setup({
    decide: (_o, sig) => {
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
  resolve({ action: "attack_player_2_20" });
  await setImmediate();
  assert.deepEqual(s.sent, []);
  assert.equal(s.timers.length, 0);
});

test("stale model responses are discarded", async () => {
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
  s.status.tick += 25;
  resolve({ action: "attack_wilderness_20" });
  await setImmediate();
  assert.deepEqual(s.sent, []);
  assert.match(s.events.find((e) => e.decision).decision.outcome, /discarded/);
});

test("stale observations are not sent to the API", async () => {
  const s = setup();
  s.adapter.observe = async () => {
    s.setTime(2100);
    return { tick: 100, observation: s.input };
  };
  s.controller.start();
  await setImmediate();
  assert.equal(s.observed.length, 0);
  s.controller.stop();
});

test("spawn/pause or stalled ticks do not generate repeated requests", async () => {
  const s = setup({ action: "wait" });
  s.status.ready = false;
  s.controller.start();
  await setImmediate();
  assert.equal(s.observed.length, 0);
  s.status.ready = true;
  s.setTime(1000);
  s.timers.shift()();
  await setImmediate();
  assert.equal(s.observed.length, 1);
  s.setTime(2000);
  s.timers.shift()();
  await setImmediate();
  assert.equal(s.observed.length, 1);
  s.controller.stop();
});

test("a fabricated target, allied target, or unsupported amount stops without execution", async () => {
  for (const action of [
    "attack_player_99_20",
    "attack_player_3_10",
    "attack_wilderness_100",
    "attack_wilderness_60",
    "attack_player_2_25",
    "attack_0",
  ]) {
    const s = setup({ action });
    s.controller.start();
    await setImmediate();
    assert.equal(s.controller.running, false);
    assert.deepEqual(s.sent, []);
  }
});

test("controller persists Jev's tribe focus after the outgoing stack ends", async () => {
  let calls = 0;
  const s = setup({
    decide: () => ({ action: ++calls === 1 ? "attack_player_2_10" : "wait" }),
  });
  s.input.neighbors[0].type = "tribe";
  s.input.incoming_attacks[0].attacker_type = "tribe";
  s.adapter.observe = async ({ focusId } = {}) => ({
    tick: s.status.tick,
    observation: s.input,
    focus_status:
      focusId === null
        ? null
        : {
            status: "available",
            id: 2,
            tick: s.status.tick,
            game_id: "test-game",
            player_id: "tribe-2",
            alive: true,
            type: "tribe",
            territory_tiles: 100,
            relationship: "unallied",
            adjacent: true,
            worker_checked: true,
            can_attack: true,
            own_reserve_troops: 2500,
            target_reserve_troops: 1000,
            reserve_ratio: 2.5,
            active_outgoing_count: 0,
            active_outgoing_troops: 0,
          },
  });
  s.controller.start({ limit: 2 });
  await setImmediate();
  assert.deepEqual(s.sent, [{ target: 2, fraction: 0.1 }]);
  assert.equal(s.controller.focusTribeId, 2);
  s.input.outgoing_attacks = []; // one-shot push ended, tribe still alive
  s.setTime(1000);
  s.status.tick += 10;
  s.timers.shift()();
  await setImmediate();
  assert.equal(s.controller.focusTribeId, 2);
  assert.equal(s.observed[1].tribe_focus.id, 2);
  assert.deepEqual(s.sent, [{ target: 2, fraction: 0.1 }]); // Jev's wait remains wait
  const second = s.events.filter((x) => x.decision).at(-1).decision;
  assert.equal(second.observation.strategy.mode, "finish_focused_tribe");
  assert.equal(second.observation.tribe_focus.our_active_attack_troops, 0);
});

test("unavailable focus skips paid decision; only authoritative death releases it", async () => {
  let choices = 0;
  const s = setup({
    decide: () => ({
      action: ++choices === 1 ? "attack_player_2_10" : "attack_wilderness_10",
    }),
  });
  s.input.neighbors[0].type = "tribe";
  s.input.incoming_attacks[0].attacker_type = "tribe";
  let focusStatus = "unavailable";
  s.adapter.observe = async ({ focusId } = {}) => ({
    tick: s.status.tick,
    observation: s.input,
    focus_status:
      focusId === null
        ? null
        : focusStatus === "unavailable"
          ? {
              status: "unavailable",
              id: 2,
              tick: s.status.tick,
              reason: "stale_snapshot",
            }
          : {
              status: "dead",
              id: 2,
              tick: s.status.tick,
              game_id: "test-game",
              player_id: "tribe-2",
              alive: false,
              type: "tribe",
              territory_tiles: 0,
            },
  });
  s.controller.start({ limit: 3 });
  await setImmediate();
  assert.equal(s.controller.focusTribeId, 2);
  s.setTime(1000);
  s.status.tick += 10;
  s.timers.shift()();
  await setImmediate();
  assert.equal(s.controller.count, 1);
  assert.equal(s.controller.focusTribeId, 2);
  assert.match(s.events.at(-1).status, /no paid call/);
  focusStatus = "dead";
  s.input.neighbors = s.input.neighbors.filter((n) => n.id !== 2);
  s.input.border.player_edges -= 5;
  s.input.border.total_edges -= 5;
  s.input.incoming_attacks = [];
  s.setTime(2000);
  s.status.tick += 10;
  s.timers.shift()();
  await setImmediate();
  assert.equal(s.controller.focusTribeId, null);
  assert.equal(s.controller.count, 2);
  assert.deepEqual(s.sent, [
    { target: 2, fraction: 0.1 },
    { target: null, fraction: 0.1 },
  ]);
});

test("a larger tribe attack returned by a model is rejected, not silently reduced", async () => {
  const s = setup({ action: "attack_player_2_50" });
  s.input.neighbors[0].type = "tribe";
  s.input.incoming_attacks[0].attacker_type = "tribe";
  s.controller.start();
  await setImmediate();
  assert.deepEqual(s.sent, []);
  assert.equal(s.controller.running, false);
});

test("a target becoming illegal during inference is not replaced with another target", async () => {
  const s = setup({ action: "attack_player_2_20" });
  s.adapter.canExecute = async () => false;
  s.controller.start({ limit: 1 });
  await setImmediate();
  assert.deepEqual(s.sent, []);
  assert.match(
    s.events.find((e) => e.decision).decision.outcome,
    /target no longer legal/,
  );
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
  s.status.ended = true;
  resolve({ action: "attack_wilderness_20" });
  await setImmediate();
  assert.deepEqual(s.sent, []);
});

test("API errors stop rather than choosing an action in code", async () => {
  const s = setup({
    decide: async () => {
      throw new Error("unavailable");
    },
  });
  s.controller.start();
  await setImmediate();
  assert.equal(s.controller.running, false);
  assert.deepEqual(s.sent, []);
});
