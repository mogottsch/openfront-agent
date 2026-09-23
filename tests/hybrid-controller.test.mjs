import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { HybridController } from "../web/hybrid-controller.js";
import { observation } from "./fixtures/land.mjs";

function siteProposal() {
  const snapshot_id = "solo-1/map@100#1";
  return {
    snapshot_id,
    source_tick: 100,
    current_tick: 100,
    map_id: "solo-1/map",
    available_gold: "1000",
    city_counts: { owned: 0, pending: 0 },
    candidates: [
      {
        id: `${snapshot_id}:c1`,
        kind: "build_city",
        region_id: `${snapshot_id}:r1`,
        front_id: null,
        water_ids: [],
        distance_to_land_border: 5,
        distance_to_player_border: -1,
        marginal_coverage_tiles: 75,
        cost_gold: "300",
        gold_after_estimate: "700",
      },
    ],
    save_gold: { id: `${snapshot_id}:save_gold`, kind: "save_gold" },
    coverage: {
      total_eligible: 3,
      total_examined: 2,
      worker_checked: 1,
      offered_count: 1,
      omitted_count: 2,
      model: "Euclidean tile disc over owned passable land; geometric only",
    },
    omissions: {
      not_examined: 1,
      prefilter_limit: 1,
      worker_unchecked: 0,
      pending_intent: 0,
      not_buildable: 0,
      relocated: 0,
      upgrade_not_city_build: 0,
      unaffordable: 0,
      unaffordable_after_check: 0,
      invalid_worker_result: 0,
      invalid_gold: 0,
      shortlist_limit: 0,
    },
  };
}
function setup({ decision, decideHybrid, propose } = {}) {
  let time = 0;
  const status = { ready: true, ended: false, tick: 100 };
  const land = observation(8000, 20000, "tribe");
  const calls = [],
    updates = [],
    timers = [],
    sends = [];
  const adapter = {
    read: () => ({ ...status }),
    observe: async () => ({ tick: status.tick, observation: land }),
    canExecute: async () => true,
    execute: (a) => {
      sends.push({ kind: "land", action: a });
      return true;
    },
  };
  const builder = {
    propose: async (opts) => {
      calls.push({ kind: "scan", opts });
      return propose ? propose(opts) : siteProposal();
    },
    canExecute: async (id) => {
      calls.push({ kind: "legal", id });
      return true;
    },
    execute: async (id, isCurrent) => {
      calls.push({ kind: "send", id });
      if (!isCurrent()) return false;
      sends.push({ kind: "city", id });
      return true;
    },
  };
  const controller = new HybridController(adapter, builder, {
    gameId: () => "solo-1",
    mapId: () => "map",
    existingCityTiles: () => [],
    decideLand: async () => ({ action: "wait", confidence: 1 }),
    decideHybrid: async (input, signal) => {
      calls.push({ kind: "jev", input });
      if (decideHybrid) return decideHybrid(input, signal);
      return (
        decision ?? {
          branch: "city_build",
          kind: "city",
          selected: "build_city_1",
          candidate_id: siteProposal().candidates[0].id,
          context: {
            game_id: "solo-1",
            snapshot_tick: 100,
            building_snapshot_id: "solo-1/map@100#1",
            plan_version: null,
          },
          decisions: {
            branch: { confidence: 0.8 },
            city_site: { confidence: 0.7 },
          },
          latencyMs: 150,
        }
      );
    },
    onUpdate: (x) => updates.push(x),
    now: () => time,
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
    controller,
    adapter,
    builder,
    status,
    calls,
    updates,
    timers,
    sends,
    setTime: (v) => {
      time = v;
    },
  };
}

test("opt-in hybrid chooses the exact opaque City candidate and emits one callback", async () => {
  const s = setup();
  s.controller.start({ limit: 1 });
  await setImmediate();
  assert.equal(s.controller.running, false);
  assert.deepEqual(
    s.calls.map((c) => c.kind),
    ["scan", "jev", "legal", "send"],
  );
  assert.equal(s.calls[0].opts.maxWorkerChecks, 12);
  assert.deepEqual(s.sends, [{ kind: "city", id: "solo-1/map@100#1:c1" }]);
  assert.equal(
    s.updates.find((e) => e.decision).decision.outcome,
    "City build intent sent",
  );
});

test("branch wait ignores attractive speculative choices; land branch sends only the selected legal land action", async () => {
  const context = {
    game_id: "solo-1",
    snapshot_tick: 100,
    building_snapshot_id: "solo-1/map@100#1",
    plan_version: null,
  };
  const waiting = setup({
    decision: {
      branch: "wait",
      kind: "wait",
      selected: "wait",
      candidate_id: null,
      context,
    },
  });
  waiting.controller.start({ limit: 1 });
  await setImmediate();
  assert.deepEqual(waiting.sends, []);
  const attacking = setup({
    decision: {
      branch: "land_attack",
      kind: "land",
      selected: "attack_wilderness_10",
      candidate_id: null,
      context,
    },
  });
  attacking.controller.start({ limit: 1 });
  await setImmediate();
  assert.deepEqual(
    attacking.sends.map((x) => [x.kind, x.action.target_id, x.action.fraction]),
    [["land", null, 0.1]],
  );
});

test("fabricated City identity cannot be silently mapped to site index", async () => {
  const s = setup({
    decision: {
      branch: "city_build",
      kind: "city",
      selected: "build_city_1",
      candidate_id: "forged:site",
      context: {
        game_id: "solo-1",
        snapshot_tick: 100,
        building_snapshot_id: "solo-1/map@100#1",
        plan_version: null,
      },
    },
  });
  s.controller.start({ limit: 1 });
  await setImmediate();
  assert.deepEqual(s.sends, []);
  assert.match(s.updates.at(-1).status, /City choice was not an offered site/);
});

test("stale reply and explicit stop both forbid late City sends", async () => {
  for (const stop of [false, true]) {
    let release;
    const s = setup({
      decideHybrid: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    s.controller.start({ limit: 1 });
    await setImmediate();
    if (stop) s.controller.stop("Stopped by user");
    else {
      s.setTime(2500);
      s.status.tick = 126;
    }
    release({
      branch: "city_build",
      kind: "city",
      selected: "build_city_1",
      candidate_id: "solo-1/map@100#1:c1",
      context: {
        game_id: "solo-1",
        snapshot_tick: 100,
        building_snapshot_id: "solo-1/map@100#1",
        plan_version: null,
      },
    });
    await setImmediate();
    assert.deepEqual(s.sends, []);
    if (!stop)
      assert.match(
        s.updates.find((x) => x.decision).decision.outcome,
        /discarded/,
      );
  }
});

test("scan errors are explicit and do not trigger model-supplied City guesses", async () => {
  const s = setup({
    propose: () => {
      throw new Error("worker unavailable");
    },
  });
  s.controller.start({ limit: 1 });
  await setImmediate();
  assert.deepEqual(s.sends, []);
  assert.equal(
    s.calls.some((x) => x.kind === "jev"),
    false,
  );
  assert.match(
    s.updates
      .map((x) => x.status)
      .filter(Boolean)
      .join(" "),
    /City scan unavailable/,
  );
});
