import assert from "node:assert/strict";
import test from "node:test";
import { createCityUpgradeAdapter } from "../web/city-upgrade-adapter.js";

function fixture(ids = [0], { gold = 400_000n, cost = 250_000n } = {}) {
  const state = { ready: true, ended: false, tick: 100 };
  const ownerByTile = new Uint16Array(64).fill(1);
  let tick = 100;
  let gameId = "upgrade-test";
  let wallet = gold;
  let price = cost;
  let worker = async (tile) => [{ type: "City", canBuild: false,
    canUpgrade: units.find((u) => u.tile() === tile)?.id() ?? false,
    cost: price, upgradeCosts: [price] }];
  let send = (unit, unitId, amount) => { sent.push({ unit, unitId, amount }); return true; };
  const sent = [];
  const calls = [];
  let units = [];
  const player = {
    smallID: () => 1,
    units: (type) => { assert.equal(type, "City"); return units; },
    gold: () => wallet,
    buildables: async (tile, types) => {
      calls.push({ tile, types });
      return worker(tile);
    },
  };
  const newUnit = (id, tile, { level = 1, construction = false,
    active = true, owner = player, type = "City" } = {}) => ({
    id: () => id, tile: () => tile, level: () => level,
    type: () => type, isActive: () => active,
    isUnderConstruction: () => construction, owner: () => owner,
  });
  units = ids.map((id, i) => newUnit(id, 10 + i));
  const game = {
    ticks: () => tick,
    gameID: () => gameId,
    myPlayer: () => player,
    width: () => 8,
    height: () => 8,
    ownerID: (tile) => ownerByTile[tile],
    isLand: () => true,
    isImpassable: () => false,
  };
  const adapter = createCityUpgradeAdapter({ game, read: () => state,
    sendUpgrade: (unit, id, amount) => send(unit, id, amount), cityUnit: "City" });
  return { adapter, game, player, state, sent, calls, ownerByTile,
    clock: (n) => { tick = n; state.tick = n; },
    setGameId: (id) => { gameId = id; },
    setGold: (goldValue) => { wallet = goldValue; },
    setCost: (costValue) => { price = costValue; },
    setWorker: (fn) => { worker = fn; },
    setSend: (fn) => { send = fn; },
    setUnits: (replacement) => { units = replacement; },
    unit: newUnit,
  };
}

const opts = { maxCandidates: 8, maxExamined: 16, maxWorkerChecks: 8 };

test("worker-confirmed unit ID zero upgrades once, without exposing ID or tile", async () => {
  const f = fixture();
  const p = await f.adapter.propose(opts);
  assert.match(p.snapshot_id, /upgrade-test.*@100#/);
  assert.equal(p.available_gold, "400000");
  assert.deepEqual(p.counts, { owned: 1, completed: 1,
    under_construction: 0, pending_unconfirmed: 0 });
  assert.equal(p.coverage.worker_checked, 1);
  assert.equal(p.coverage.omitted_count, 0);
  assert.deepEqual(f.calls[0], { tile: 10, types: ["City"] });
  const candidate = p.candidates[0];
  assert.equal(candidate.kind, "upgrade_city");
  assert.equal(candidate.amount, 1);
  assert.equal(candidate.current_level, 1);
  assert.equal(candidate.cost_gold, "250000");
  assert.equal(candidate.gold_after_estimate, "150000");
  assert.match(candidate.id, /:uc1$/);
  assert.equal("tile" in candidate, false);
  assert.equal("unitId" in candidate, false);
  assert.equal(await f.adapter.canExecute(p.save_gold.id), true);
  assert.equal(await f.adapter.execute(p.save_gold.id), true);
  assert.equal(f.calls.length, 1); // save is a no-op
  assert.equal(f.sent.length, 0);
  assert.equal(await f.adapter.execute(candidate.id), false); // no permit
  assert.equal(await f.adapter.canExecute(candidate.id), true);
  assert.equal(await f.adapter.execute(candidate.id), true);
  assert.deepEqual(f.sent, [{ unit: "City", unitId: 0, amount: 1 }]);
  assert.equal(await f.adapter.execute(candidate.id), false); // single use
  assert.equal(await f.adapter.canExecute(candidate.id), false); // pending
});

test("upgrade cost and remaining gold stay exact above Number.MAX_SAFE_INTEGER", async () => {
  const cost = 2n ** 60n;
  const f = fixture([0], { gold: cost + 7n, cost });
  const p = await f.adapter.propose(opts);
  assert.equal(p.available_gold, (cost + 7n).toString());
  assert.equal(p.candidates[0].cost_gold, cost.toString());
  assert.equal(p.candidates[0].gold_after_estimate, "7");
  assert.equal(await f.adapter.canExecute(p.candidates[0].id), true);
  assert.equal(await f.adapter.execute(p.candidates[0].id), true);
  assert.deepEqual(f.sent, [{ unit: "City", unitId: 0, amount: 1 }]);
});

test("zero owned Cities returns save only without worker calls", async () => {
  const f = fixture([]);
  const p = await f.adapter.propose(opts);
  assert.deepEqual(p.candidates, []);
  assert.equal(p.coverage.total_owned, 0);
  assert.equal(p.coverage.omitted_count, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.adapter.execute(p.save_gold.id), true);
  assert.equal(f.sent.length, 0);
});

test("under-construction, inactive and foreign Cities never become upgrades", async () => {
  const f = fixture([]);
  f.setUnits([f.unit(1, 10, { construction: true }),
    f.unit(2, 11, { active: false }),
    f.unit(3, 12, { owner: {} }),
    f.unit(4, 13, { type: "Factory" })]);
  const p = await f.adapter.propose(opts);
  assert.equal(p.counts.owned, 4);
  assert.equal(p.counts.under_construction, 1);
  assert.equal(p.candidates.length, 0);
  assert.equal(p.omissions.incomplete_or_invalid, 4);
  assert.equal(f.calls.length, 0);
});

test("wrong worker ID, absent upgradeCosts, mismatched cost, unaffordable are disclosed", async () => {
  for (const [worker, reason] of [
    [async () => [{ type: "City", canUpgrade: 99, cost: 250000n,
      upgradeCosts: [250000n] }], "wrong_upgrade_id"],
    [async () => [{ type: "City", canUpgrade: 0, cost: 250000n }],
      "invalid_worker_cost"],
    [async () => [{ type: "City", canUpgrade: 0, cost: 250000n,
      upgradeCosts: [260000n] }], "invalid_worker_cost"],
    [async () => [{ type: "City", canUpgrade: 0, cost: 500000n,
      upgradeCosts: [500000n] }], "unaffordable"],
  ]) {
    const f = fixture();
    f.setWorker(worker);
    const p = await f.adapter.propose(opts);
    assert.equal(p.candidates.length, 0, reason);
    assert.equal(p.omissions[reason], 1, reason);
    assert.equal(p.coverage.worker_checked, 1, reason);
  }
});

test("bounded enumeration and worker checks expose all omissions", async () => {
  const f = fixture(Array.from({ length: 20 }, (_, i) => i));
  const p = await f.adapter.propose({ maxCandidates: 2,
    maxExamined: 8, maxWorkerChecks: 3 });
  assert.equal(f.calls.length, 2); // full offered cohort
  assert.equal(p.coverage.total_owned, 20);
  assert.equal(p.coverage.total_examined, 8);
  assert.equal(p.coverage.offered_count, 2);
  assert.equal(p.omissions.enumeration_capped, 12);
  assert.equal(p.omissions.shortlist_limit, 6);
  assert.equal(p.coverage.omitted_count, 18);
  assert.equal(Object.values(p.omissions).reduce((a, b) => a + b, 0), 18);
  const g = fixture(Array.from({ length: 20 }, (_, i) => i));
  const capped = await g.adapter.propose({ maxCandidates: 8,
    maxExamined: 8, maxWorkerChecks: 2 });
  assert.equal(capped.omissions.worker_unchecked, 6);
  assert.equal(capped.candidates.length, 2);
});

test("after multiple worker awaits all balances use final BigInt gold", async () => {
  const f = fixture([0, 1], { gold: 600000n, cost: 250000n });
  let count = 0;
  f.setWorker(async (tile) => {
    if (++count === 2) f.setGold(300000n);
    return [{ type: "City", canUpgrade: tile - 10,
      cost: 250000n, upgradeCosts: [250000n] }];
  });
  const p = await f.adapter.propose(opts);
  assert.equal(p.available_gold, "300000");
  assert(p.candidates.every((c) => BigInt(c.cost_gold) +
    BigInt(c.gold_after_estimate) === 300000n));
  const g = fixture([0, 1], { gold: 600000n, cost: 250000n });
  let n = 0;
  g.setWorker(async (tile) => {
    if (++n === 2) g.setGold(100000n);
    return [{ type: "City", canUpgrade: tile - 10,
      cost: 250000n, upgradeCosts: [250000n] }];
  });
  const p2 = await g.adapter.propose(opts);
  assert.equal(p2.candidates.length, 0);
  assert.equal(p2.omissions.unaffordable, 1);
  assert.equal(p2.omissions.unaffordable_after_check, 1);
});

test("stale City ID, level, tile, owner, cost or gold invalidates execution", async () => {
  for (const change of ["id", "level", "tile", "owner", "cost", "gold"]) {
    const f = fixture();
    const p = await f.adapter.propose(opts);
    const candidate = p.candidates[0];
    assert.equal(await f.adapter.canExecute(candidate.id), true);
    if (change === "id") f.setUnits([f.unit(2, 10)]);
    if (change === "level") f.setUnits([f.unit(0, 10, { level: 2 })]);
    if (change === "tile") f.setUnits([f.unit(0, 11)]);
    if (change === "owner") f.ownerByTile[10] = 2;
    if (change === "cost") f.setCost(300000n);
    if (change === "gold") f.setGold(300000n);
    assert.equal(await f.adapter.execute(candidate.id), false, change);
    assert.equal(f.sent.length, 0, change);
    assert.equal(await f.adapter.execute(candidate.id), false, `${change} consumed permit`);
  }
});

test("stale tick/game and City changing during worker response cannot authorize an upgrade", async () => {
  const f = fixture();
  const first = await f.adapter.propose(opts);
  f.clock(101);
  assert.equal(await f.adapter.canExecute(first.candidates[0].id), true);
  f.setGameId("another-game");
  assert.equal(await f.adapter.execute(first.candidates[0].id), false);
  assert.equal(f.sent.length, 0);
  const g = fixture();
  const site = (await g.adapter.propose(opts)).candidates[0];
  g.setWorker(async () => {
    g.setUnits([g.unit(0, 10, { construction: true })]);
    return [{ type: "City", canUpgrade: 0, cost: 250000n,
      upgradeCosts: [250000n] }];
  });
  assert.equal(await g.adapter.canExecute(site.id), false);
  assert.equal(g.sent.length, 0);
  const h = fixture();
  const current = (await h.adapter.propose(opts)).candidates[0];
  h.state.ended = true;
  assert.equal(await h.adapter.canExecute(current.id), false);
  assert.equal(await h.adapter.execute(current.id), false);
});

test("same-tick change during final worker await and Stop/restart guard fail closed", async () => {
  for (const change of ["level", "stop"]) {
    const f = fixture();
    const candidate = (await f.adapter.propose(opts)).candidates[0];
    assert.equal(await f.adapter.canExecute(candidate.id), true);
    let release;
    f.setWorker(() => new Promise((resolve) => { release = resolve; }));
    let generation = 7;
    const execution = f.adapter.execute(candidate.id, () => generation === 7);
    if (change === "level") f.setUnits([f.unit(0, 10, { level: 2 })]);
    else generation = 8;
    release([{ type: "City", canUpgrade: 0, cost: 250000n,
      upgradeCosts: [250000n] }]);
    assert.equal(await execution, false, change);
    assert.equal(f.sent.length, 0, change);
  }
});

test("pending intent clears only after observed level increase or 30-tick review", async () => {
  const f = fixture();
  const first = await f.adapter.propose(opts);
  assert.equal(await f.adapter.canExecute(first.candidates[0].id), true);
  assert.equal(await f.adapter.execute(first.candidates[0].id), true);
  f.clock(101);
  const held = await f.adapter.propose(opts);
  assert.equal(held.candidates.length, 0);
  assert.equal(held.omissions.pending_intent, 1);
  f.setUnits([f.unit(0, 10, { level: 2 })]);
  f.setCost(500000n);
  f.setGold(600000n);
  const observed = await f.adapter.propose(opts);
  assert.equal(observed.candidates.length, 1);
  assert.equal(observed.candidates[0].current_level, 2);
  assert.equal(observed.counts.pending_unconfirmed, 0);
  assert.equal(f.sent.length, 1); // never auto-repeat
  const g = fixture();
  const site = (await g.adapter.propose(opts)).candidates[0];
  assert.equal(await g.adapter.canExecute(site.id), true);
  assert.equal(await g.adapter.execute(site.id), true);
  g.clock(129);
  assert.equal((await g.adapter.propose(opts)).omissions.pending_intent, 1);
  g.clock(130);
  assert.equal((await g.adapter.propose(opts)).candidates.length, 1);
  assert.equal(g.sent.length, 1);
});

test("ambiguous send remains pending; explicit false releases for fresh retry", async () => {
  const f = fixture();
  const site = (await f.adapter.propose(opts)).candidates[0];
  f.setSend(() => false);
  assert.equal(await f.adapter.canExecute(site.id), true);
  assert.equal(await f.adapter.execute(site.id), false);
  f.setSend(() => { throw new Error("after intent"); });
  assert.equal(await f.adapter.canExecute(site.id), true);
  assert.equal(await f.adapter.execute(site.id), false);
  f.clock(101);
  assert.equal((await f.adapter.propose(opts)).omissions.pending_intent, 1);
});
