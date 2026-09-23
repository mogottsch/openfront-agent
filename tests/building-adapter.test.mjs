import assert from "node:assert/strict";
import test from "node:test";
import { createBuildingAdapter } from "../web/building-adapter.js";

function fixture(rows = ["A"], { gold = 100n, cost = 10n } = {}) {
  const width = rows[0].length;
  const height = rows.length;
  const owner = Array.from(rows.join(""), (s) => s === "A" ? 1 : s === "B" ? 2 : 0);
  const state = { ready: true, tick: 100 };
  let tick = 100;
  let gameID = "game-one";
  let wallet = gold;
  let price = cost;
  let cityTiles = [];
  let worker = async (tile) => [{ type: "City", canBuild: tile,
    canUpgrade: false, cost: price }];
  const calls = [];
  const sent = [];
  let player = {
    smallID: () => 1,
    gold: () => wallet,
    units: () => cityTiles.map((tile) => ({ tile: () => tile })),
    buildables: async (tile, types) => {
      calls.push({ tile, types });
      return worker(tile);
    },
  };
  const game = {
    width: () => width,
    height: () => height,
    ref: (x, y) => y * width + x,
    ownerID: (tile) => owner[tile],
    isLand: () => true,
    isImpassable: () => false,
    neighbors: (tile) => [tile >= width ? tile - width : null,
      tile < (height - 1) * width ? tile + width : null,
      tile % width ? tile - 1 : null,
      tile % width < width - 1 ? tile + 1 : null].filter((t) => t !== null),
    gameID: () => gameID,
    ticks: () => tick,
    myPlayer: () => player,
  };
  let send = (unit, tile) => { sent.push({ unit, tile }); return true; };
  const adapter = createBuildingAdapter({ game, read: () => state,
    sendBuild: (unit, tile) => send(unit, tile), cityUnit: "City" });
  const clock = (value) => { tick = value; state.tick = value; };
  return { adapter, game, owner, state, calls, sent, clock,
    setWorker: (fn) => { worker = fn; },
    setGold: (value) => { wallet = value; },
    setCost: (value) => { price = value; },
    setCityTiles: (tiles) => { cityTiles = tiles; },
    setPlayer: (value) => { player = value; },
    setGameID: (value) => { gameID = value; },
    setSend: (fn) => { send = fn; } };
}

const opts = { coverageRadius: 0, maxCandidates: 4, maxExamined: 16, maxWorkerChecks: 4 };

test("worker-legal CITY at tile zero, exact BigInt gold strings and no-op save_gold", async () => {
  const value = 2n ** 60n;
  const f = fixture(["AAA"], { gold: value + 3n, cost: value });
  f.setCityTiles([1, 2]);
  const proposal = await f.adapter.propose(opts);
  assert.equal(proposal.source_tick, 100);
  assert.equal(proposal.current_tick, 100);
  assert.match(proposal.snapshot_id, /game-one.*@100#/);
  assert.equal(proposal.available_gold, (value + 3n).toString());
  assert.deepEqual(proposal.city_counts, { owned: 2, pending: 0 });
  assert.equal(proposal.candidates[0].kind, "build_city");
  assert.equal(proposal.candidates[0].cost_gold, value.toString());
  assert.equal(proposal.candidates[0].gold_after_estimate, "3");
  assert.equal("tile" in proposal.candidates[0], false);
  assert.deepEqual(f.calls[0], { tile: 0, types: ["City"] });
  assert.equal(await f.adapter.canExecute(proposal.save_gold.id), true);
  assert.equal(await f.adapter.execute(proposal.save_gold.id), true);
  assert.equal(f.sent.length, 0);
  assert.equal(f.calls.length, 1); // save never queries the worker
  const id = proposal.candidates[0].id;
  assert.equal(await f.adapter.execute(id), false); // no build permit
  assert.equal(await f.adapter.canExecute(id), true);
  assert.equal(await f.adapter.execute(id), true);
  assert.deepEqual(f.sent, [{ unit: "City", tile: 0 }]);
  assert.equal(await f.adapter.execute(id), false); // consumed
  assert.equal(await f.adapter.canExecute(id), false); // pending intent
});

test("worker canBuild relocation/upgrade/affordability are rejected and reported", async () => {
  const f = fixture(["AAAAAA"], { gold: 11n, cost: 10n });
  let calls = 0;
  f.setWorker(async (tile) => {
    calls++;
    if (calls === 1) return [{ type: "City", canBuild: (tile + 1) % 6,
      canUpgrade: false, cost: 10n }];
    if (calls === 2) return [{ type: "City", canBuild: tile,
      canUpgrade: 0, cost: 10n }];
    if (calls === 3) return [{ type: "City", canBuild: tile,
      canUpgrade: false, cost: 12n }];
    return [{ type: "City", canBuild: tile, canUpgrade: false, cost: 10n }];
  });
  const p = await f.adapter.propose({ ...opts, maxCandidates: 3, maxWorkerChecks: 4 });
  assert.equal(p.omissions.relocated, 1);
  assert.equal(p.omissions.upgrade_not_city_build, 1);
  assert.equal(p.omissions.unaffordable, 1);
  assert.equal(p.candidates.length, 1);
  assert.equal(p.coverage.worker_checked, 4);
  assert.equal(p.coverage.omitted_count, 5);
  assert.equal(Object.values(p.omissions).reduce((n, v) => n + v, 0), 5);
});

test("all estimated balances use one final gold snapshot across worker awaits", async () => {
  const f = fixture(["AAA"], { gold: 30n, cost: 10n });
  let count = 0;
  f.setWorker(async (tile) => {
    if (++count === 3) f.setGold(12n);
    return [{ type: "City", canBuild: tile, canUpgrade: false, cost: 10n }];
  });
  const p = await f.adapter.propose({ ...opts, maxWorkerChecks: 3 });
  assert.equal(p.available_gold, "12");
  assert(p.candidates.every((c) => BigInt(c.cost_gold) +
    BigInt(c.gold_after_estimate) === 12n));
  const low = fixture(["AA"], { gold: 30n, cost: 10n });
  let calls = 0;
  low.setWorker(async (tile) => {
    if (++calls === 2) low.setGold(4n);
    return [{ type: "City", canBuild: tile, canUpgrade: false, cost: 10n }];
  });
  const changed = await low.adapter.propose({ ...opts, maxWorkerChecks: 2 });
  assert.equal(changed.candidates.length, 0);
  assert.equal(changed.omissions.unaffordable_after_check, 1);
  assert.equal(changed.omissions.unaffordable, 1);
  assert.equal(changed.coverage.omitted_count, 2);
});

test("bounded cohort reports prefilter, worker and final shortlist omissions", async () => {
  const f = fixture(["A".repeat(40)]);
  const p = await f.adapter.propose({ ...opts,
    maxCandidates: 2, maxExamined: 10, maxWorkerChecks: 3 });
  assert.equal(f.calls.length, 2); // stop once the cohort is full
  assert.equal(p.coverage.total_eligible, 40);
  assert.equal(p.coverage.total_examined, 10);
  assert.equal(p.coverage.worker_checked, 2);
  assert.equal(p.candidates.length, 2);
  assert.equal(p.omissions.not_examined, 30);
  assert.equal(p.omissions.prefilter_limit, 7);
  assert.equal(p.omissions.shortlist_limit, 1);
  assert.equal(p.coverage.omitted_count, 38);
  const f2 = fixture(["A".repeat(40)]);
  const capped = await f2.adapter.propose({ ...opts,
    maxCandidates: 8, maxExamined: 10, maxWorkerChecks: 2 });
  assert.equal(f2.calls.length, 2);
  assert.equal(capped.omissions.worker_unchecked, 6);
  assert.equal(capped.coverage.omitted_count, 38);
  assert.equal(capped.candidates.length, 2);
});

test("proposal tolerates bounded tick drift but rejects stale or changed game", async () => {
  const f = fixture();
  f.setWorker(async (tile) => {
    f.clock(106);
    return [{ type: "City", canBuild: tile, canUpgrade: false, cost: 10n }];
  });
  const p = await f.adapter.propose(opts);
  assert.equal(p.source_tick, 100);
  assert.equal(p.current_tick, 106);
  assert.equal(await f.adapter.canExecute(p.candidates[0].id), true);
  f.clock(107);
  assert.equal(await f.adapter.execute(p.candidates[0].id), false);
  assert.equal(f.sent.length, 0);
  f.clock(121);
  assert.equal(await f.adapter.canExecute(p.save_gold.id), false);
  const g = fixture();
  g.setWorker(async (tile) => {
    g.clock(121);
    return [{ type: "City", canBuild: tile, canUpgrade: false, cost: 10n }];
  });
  await assert.rejects(g.adapter.propose(opts), /source_tick=100 current_tick=121/);
  const h = fixture();
  h.setWorker(async (tile) => {
    h.setGameID("another-game");
    return [{ type: "City", canBuild: tile, canUpgrade: false, cost: 10n }];
  });
  await assert.rejects(h.adapter.propose(opts), /Building snapshot stale/);
});

test("ended game cannot propose or execute a city", async () => {
  const f = fixture();
  const p = await f.adapter.propose(opts);
  f.state.ended = true;
  assert.equal(await f.adapter.canExecute(p.candidates[0].id), false);
  assert.equal(await f.adapter.execute(p.save_gold.id), false);
  await assert.rejects(f.adapter.propose(opts), /not ready/);
  assert.equal(f.sent.length, 0);
});

test("a tick advancing during the final worker request discards the permit", async () => {
  const f = fixture();
  const p = await f.adapter.propose(opts);
  const id = p.candidates[0].id;
  assert.equal(await f.adapter.canExecute(id), true);
  f.setWorker(async (tile) => {
    f.clock(101);
    return [{ type: "City", canBuild: tile, canUpgrade: false, cost: 10n }];
  });
  assert.equal(await f.adapter.execute(id), false);
  assert.equal(f.sent.length, 0);
});

test("execution rejects changing ownership, myPlayer, gold and worker result", async () => {
  for (const change of ["owner", "player", "gold", "worker"]) {
    const f = fixture();
    const p = await f.adapter.propose(opts);
    const id = p.candidates[0].id;
    assert.equal(await f.adapter.canExecute(id), true, change);
    if (change === "owner") f.owner[0] = 2;
    if (change === "player") f.setPlayer({ smallID: () => 1 });
    if (change === "gold") f.setGold(9n);
    if (change === "worker") f.setWorker(async () => [{ type: "City", canBuild: false,
      canUpgrade: false, cost: 10n }]);
    assert.equal(await f.adapter.execute(id), false, change);
    assert.equal(f.sent.length, 0, change);
    assert.equal(await f.adapter.execute(id), false, `single-use ${change}`);
  }
});

test("gold changing after proposal requires a new proposal, not a silent updated site", async () => {
  const f = fixture();
  const p = await f.adapter.propose(opts);
  f.setGold(99n);
  assert.equal(await f.adapter.canExecute(p.candidates[0].id), false);
  assert.equal(f.sent.length, 0);
});

test("same-tick cost or gold changes reject the permit even when still affordable", async () => {
  for (const change of ["cost", "gold"]) {
    const f = fixture();
    const p = await f.adapter.propose(opts);
    const id = p.candidates[0].id;
    assert.equal(await f.adapter.canExecute(id), true);
    if (change === "cost") f.setCost(11n);
    else f.setGold(99n);
    assert.equal(await f.adapter.execute(id), false);
    assert.equal(f.sent.length, 0);
  }
});

test("successful intent is pending across proposals; failed send releases reservation", async () => {
  const f = fixture();
  const first = await f.adapter.propose(opts);
  const id = first.candidates[0].id;
  f.setSend(() => false);
  assert.equal(await f.adapter.canExecute(id), true);
  assert.equal(await f.adapter.execute(id), false);
  f.setSend((unit, tile) => { f.sent.push({ unit, tile }); return true; });
  assert.equal(await f.adapter.canExecute(id), true);
  assert.equal(await f.adapter.execute(id), true);
  f.clock(101);
  const next = await f.adapter.propose(opts);
  assert.equal(next.candidates.length, 0);
  assert.equal(next.omissions.pending_intent, 1);
  assert.equal(next.city_counts.pending, 1);
  assert.equal(await f.adapter.canExecute(id), false);
  assert.equal(f.sent.length, 1);
  // No city appeared: after a bounded pending window, an explicit proposal
  // reopens the tile only via another fresh worker legality check.
  f.clock(130);
  const retry = await f.adapter.propose(opts);
  assert.equal(retry.city_counts.pending, 0);
  assert.equal(retry.candidates.length, 1);
  assert.equal(f.calls.length > 3, true);
});

test("ambiguous throwing send stays pending rather than risking duplicate intent", async () => {
  const f = fixture();
  const p = await f.adapter.propose(opts);
  const id = p.candidates[0].id;
  f.setSend((unit, tile) => {
    f.sent.push({ unit, tile }); // simulated emit followed by an error
    throw new Error("after emission");
  });
  assert.equal(await f.adapter.canExecute(id), true);
  assert.equal(await f.adapter.execute(id), false);
  assert.equal(await f.adapter.canExecute(id), false);
  f.clock(101);
  const pending = await f.adapter.propose(opts);
  assert.equal(pending.omissions.pending_intent, 1);
  assert.equal(f.sent.length, 1);
});

test("observed or under-construction city resolves pending and excludes occupied site", async () => {
  const f = fixture();
  const p = await f.adapter.propose(opts);
  assert.equal(await f.adapter.canExecute(p.candidates[0].id), true);
  assert.equal(await f.adapter.execute(p.candidates[0].id), true);
  f.setCityTiles([0]); // includes under-construction cities
  f.setWorker(async () => [{ type: "City", canBuild: false,
    canUpgrade: false, cost: 10n }]);
  f.clock(101);
  const observed = await f.adapter.propose(opts);
  assert.deepEqual(observed.city_counts, { owned: 1, pending: 0 });
  assert.equal(observed.candidates.length, 0);
  assert.equal(observed.omissions.occupied_city, 1);
  assert.equal(f.sent.length, 1);
});

test("single-flight proposals and execute in-flight permit cannot emit twice", async () => {
  const f = fixture();
  let release;
  f.setWorker(() => new Promise((resolve) => { release = resolve; }));
  const first = f.adapter.propose(opts);
  await assert.rejects(f.adapter.propose(opts), /already in flight/);
  release([{ type: "City", canBuild: 0, canUpgrade: false, cost: 10n }]);
  const p = await first;
  const id = p.candidates[0].id;
  const permit = f.adapter.canExecute(id);
  release([{ type: "City", canBuild: 0, canUpgrade: false, cost: 10n }]);
  assert.equal(await permit, true);
  const execution = f.adapter.execute(id);
  assert.equal(await f.adapter.execute(id), false);
  release([{ type: "City", canBuild: 0, canUpgrade: false, cost: 10n }]);
  assert.equal(await execution, true);
  assert.equal(f.sent.length, 1);
});
