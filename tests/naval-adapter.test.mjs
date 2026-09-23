import assert from "node:assert/strict";
import test from "node:test";
import { createNavalAdapter } from "../web/naval-adapter.js";

function fixture(rows = ["A~B"], { targetType = "NATION", troops = 1000,
  gold = 100n, cost = 0n } = {}) {
  const width = rows[0].length;
  const height = rows.length;
  assert(rows.every((row) => row.length === width));
  const cells = rows.join("").split("");
  const owner = cells.map((c) => ({ A: 1, B: 2, C: 3 })[c] ?? 0);
  const state = { ready: true, ended: false, tick: 100 };
  let tick = 100;
  let gameId = "game-naval";
  let army = troops;
  let wallet = gold;
  let boatCost = cost;
  let cap = 3;
  let humanImmune = false;
  let nationImmune = false;
  let allied = false;
  let kind = targetType;
  let boats = [];
  let worker = async () => [{ type: "Transport", canBuild: 0,
    canUpgrade: false, cost: boatCost }];
  const calls = [];
  const sent = [];
  const other = { smallID: () => 2, isPlayer: () => true,
    isAlive: () => true, type: () => kind,
    isFriendly: () => allied,
    isOnSameTeam: () => false };
  let me = { smallID: () => 1, troops: () => army, gold: () => wallet,
    units: () => boats,
    isFriendly: () => allied,
    isOnSameTeam: () => false,
    buildables: async (tile, types) => {
      calls.push({ tile, types });
      return worker(tile);
    } };
  const neighbors = (tile) => {
    const x = tile % width;
    const y = Math.floor(tile / width);
    return [y > 0 ? tile - width : null,
      y < height - 1 ? tile + width : null,
      x > 0 ? tile - 1 : null,
      x < width - 1 ? tile + 1 : null].filter((n) => n !== null);
  };
  const game = { width: () => width, height: () => height,
    ref: (x, y) => y * width + x, ticks: () => tick,
    gameID: () => gameId,
    myPlayer: () => me,
    playerBySmallID: (id) => { if (id !== 2) throw new Error("not a player"); return other; },
    ownerID: (tile) => owner[tile],
    isLand: (tile) => !["~", "O"].includes(cells[tile]),
    isWater: (tile) => ["~", "O"].includes(cells[tile]),
    isOcean: (tile) => cells[tile] === "O",
    isImpassable: (tile) => cells[tile] === "#",
    isShore: (tile) => !["~", "O", "#"].includes(cells[tile]) &&
      neighbors(tile).some((n) => ["~", "O"].includes(cells[n])),
    neighbors,
    isSpawnImmunityActive: () => humanImmune,
    isNationSpawnImmunityActive: () => nationImmune,
    config: () => ({ boatMaxNumber: () => cap }),
  };
  let send = (dst, count) => { sent.push({ dst, troops: count }); return true; };
  const adapter = createNavalAdapter({ game, read: () => state,
    sendBoat: (dst, count) => send(dst, count), transportUnit: "Transport" });
  return { adapter, game, state, calls, sent, owner,
    clock: (n) => { tick = n; state.tick = n; },
    setArmy: (n) => { army = n; },
    setGold: (n) => { wallet = n; },
    setCost: (n) => { boatCost = n; },
    setCap: (n) => { cap = n; },
    setBoats: (units) => { boats = units; },
    setAllied: (value) => { allied = value; },
    setTargetType: (value) => { kind = value; },
    setHumanImmune: (value) => { humanImmune = value; },
    setNationImmune: (value) => { nationImmune = value; },
    setGameId: (value) => { gameId = value; },
    setMe: (value) => { me = value; },
    setWorker: (fn) => { worker = fn; },
    setSend: (fn) => { send = fn; } };
}

const opts = { maxCandidates: 8, maxCoastTiles: 20, maxPairs: 20,
  maxWorkerChecks: 8 };

const first = async (f) => (await f.adapter.propose(opts)).candidates[0];

test("worker canBuild source ref zero is legal, ID opaque, exact internal troop fraction", async () => {
  const f = fixture();
  const p = await f.adapter.propose(opts);
  assert.equal(p.candidates.length, 1);
  assert.equal(p.candidates[0].kind, "boat");
  assert.equal(p.candidates[0].target_type, "nation");
  assert.equal("target_shore_tile" in p.candidates[0], false);
  assert.equal("source_shore_tile" in p.candidates[0], false);
  assert.match(p.candidates[0].id, /:boat1$/);
  assert.deepEqual(f.calls[0], { tile: 2, types: ["Transport"] });
  assert.equal(p.boats.cap, 3);
  assert.equal(p.boats.active_count, 0);
  assert.equal(p.available_troops_internal, 1000);
  assert.equal(await f.adapter.canExecute(p.candidates[0].id, 0.3), true);
  assert.equal(await f.adapter.execute(p.candidates[0].id, 0.3), true);
  assert.deepEqual(f.sent, [{ dst: 2, troops: 300 }]);
  assert.equal(await f.adapter.execute(p.candidates[0].id, 0.3), false);
  assert.equal(await f.adapter.canExecute(p.candidates[0].id, 0.3), false);
});

test("fractional live reserve stays exact until 10% integer intent; boat facts may be fractional", async () => {
  const f = fixture(undefined, { troops: 9624.8 });
  f.setBoats([{ id: () => 5, isActive: () => true,
    targetTile: () => 2, troops: () => 74.5 }]);
  const p = await f.adapter.propose(opts);
  assert.equal(p.available_troops_internal, 9624.8);
  assert.deepEqual(p.boats.active_transports,
    [{ destination_tile: 2, troops_internal: 74.5 }]);
  const id = p.candidates[0].id;
  assert.equal(await f.adapter.canExecute(id, 0.1), true);
  assert.equal(await f.adapter.execute(id, 0.1), true);
  assert.deepEqual(f.sent, [{ dst: 2, troops: 962 }]);
  const negative = fixture(undefined, { troops: -0.5 });
  await assert.rejects(negative.adapter.propose(opts), /Invalid available troops/);
});

test("hard fraction envelope rejects fabricated values and tribe >20% at both stages", async () => {
  const f = fixture(undefined, { targetType: "BOT" });
  const site = await first(f);
  for (const fraction of [0.05, 0.15, 0.3, 0.5, 0.6, -0.1, NaN]) {
    assert.equal(await f.adapter.canExecute(site.id, fraction), false, String(fraction));
  }
  assert.equal(await f.adapter.canExecute(site.id, 0.2), true);
  assert.equal(await f.adapter.execute(site.id, 0.3), false); // fabricated execute
  assert.equal(await f.adapter.canExecute(site.id, 0.2), true);
  assert.equal(await f.adapter.execute(site.id, 0.2), true);
  assert.deepEqual(f.sent, [{ dst: 2, troops: 200 }]);
});

test("owner, live type, friendliness and immunity changes fail closed", async () => {
  for (const change of ["owner", "type", "ally", "immune"]) {
    const f = fixture();
    const site = await first(f);
    assert.equal(await f.adapter.canExecute(site.id, 0.3), true);
    if (change === "owner") f.owner[2] = 1;
    if (change === "type") f.setTargetType("BOT");
    if (change === "ally") f.setAllied(true);
    if (change === "immune") f.setNationImmune(true);
    assert.equal(await f.adapter.execute(site.id, 0.3), false, change);
    assert.equal(f.sent.length, 0, change);
  }
  const human = fixture(undefined, { targetType: "HUMAN" });
  const site = await first(human);
  human.setHumanImmune(true);
  assert.equal(await human.adapter.canExecute(site.id, 0.2), false);
});

test("boat cap, disabled transport, worker false/invalid source and affordability reject", async () => {
  const f = fixture();
  f.setCap(0);
  const disabled = await f.adapter.propose(opts);
  assert.equal(disabled.candidates.length, 0);
  assert.equal(disabled.omissions.cap_blocked, 1);
  assert.equal(f.calls.length, 0);
  f.setCap(3);
  f.setBoats([0, 1, 2].map(() => ({ isActive: () => true })));
  const full = await f.adapter.propose(opts);
  assert.equal(full.boats.active_count, 3);
  assert.equal(full.candidates.length, 0);
  f.setBoats([]);
  for (const [result, reason] of [
    [{ type: "Transport", canBuild: false, canUpgrade: false, cost: 0n }, "not_buildable"],
    [{ type: "Transport", canBuild: 1, canUpgrade: false, cost: 0n }, "invalid_source"],
    [{ type: "Transport", canBuild: 0, canUpgrade: false, cost: 200n }, "unaffordable"],
  ]) {
    f.setWorker(async () => [result]);
    const p = await f.adapter.propose(opts);
    assert.equal(p.candidates.length, 0);
    assert.equal(p.omissions[reason], 1);
  }
});

test("worker source/cost/troop pool changes after permit cannot move or resize an attack", async () => {
  for (const change of ["source", "cost", "army", "gold"]) {
    const f = fixture(["AA~B"]); // both own shore tiles possible source
    f.setWorker(async () => [{ type: "Transport", canBuild: 1,
      canUpgrade: false, cost: 0n }]);
    const site = await first(f);
    assert.equal(await f.adapter.canExecute(site.id, 0.2), true);
    if (change === "source") f.setWorker(async () => [{ type: "Transport", canBuild: 0,
      canUpgrade: false, cost: 0n }]);
    if (change === "cost") f.setWorker(async () => [{ type: "Transport",
      canBuild: 1, canUpgrade: false, cost: 1n }]);
    if (change === "army") f.setArmy(900);
    if (change === "gold") f.setGold(99n);
    assert.equal(await f.adapter.execute(site.id, 0.2), false, change);
    assert.equal(f.sent.length, 0, change);
  }
});

test("cap and worker result are rechecked after permit; failed send can be retried explicitly", async () => {
  for (const change of ["disabled", "full", "worker_false"]) {
    const f = fixture();
    const site = await first(f);
    assert.equal(await f.adapter.canExecute(site.id, 0.2), true);
    if (change === "disabled") f.setCap(0);
    if (change === "full") f.setBoats([0, 1, 2].map(() => ({ isActive: () => true })));
    if (change === "worker_false") f.setWorker(async () => [{ type: "Transport",
      canBuild: false, canUpgrade: false, cost: 0n }]);
    assert.equal(await f.adapter.execute(site.id, 0.2), false, change);
    assert.equal(f.sent.length, 0, change);
  }
  const f = fixture();
  const site = await first(f);
  f.setSend(() => false);
  assert.equal(await f.adapter.canExecute(site.id, 0.2), true);
  assert.equal(await f.adapter.execute(site.id, 0.2), false);
  f.setSend((dst, troops) => { f.sent.push({ dst, troops }); return true; });
  assert.equal(await f.adapter.canExecute(site.id, 0.2), true);
  assert.equal(await f.adapter.execute(site.id, 0.2), true);
  assert.equal(f.sent.length, 1);
});

test("Stop/restart during final worker wait consumes permit without late boat", async () => {
  const f = fixture();
  const site = await first(f);
  assert.equal(await f.adapter.canExecute(site.id, 0.2), true);
  let release;
  f.setWorker(() => new Promise((resolve) => { release = resolve; }));
  let generation = 1;
  const execution = f.adapter.execute(site.id, 0.2, () => generation === 1);
  generation = 2;
  release([{ type: "Transport", canBuild: 0, canUpgrade: false, cost: 0n }]);
  assert.equal(await execution, false);
  assert.equal(await f.adapter.execute(site.id, 0.2), false);
  assert.equal(f.sent.length, 0);
});

test("pending intent blocks same target until observed transport or bounded review", async () => {
  const f = fixture();
  const site = await first(f);
  assert.equal(await f.adapter.canExecute(site.id, 0.1), true);
  assert.equal(await f.adapter.execute(site.id, 0.1), true);
  f.clock(101);
  const unconfirmed = await f.adapter.propose(opts);
  assert.equal(unconfirmed.candidates.length, 0);
  assert.equal(unconfirmed.omissions.pending_intent, 1);
  f.setBoats([{ id: () => 101, isActive: () => true,
    targetTile: () => 2, troops: () => 100 }]);
  const observed = await f.adapter.propose(opts);
  assert.equal(observed.boats.active_count, 1);
  assert.deepEqual(observed.boats.active_transports,
    [{ destination_tile: 2, troops_internal: 100 }]);
  assert.equal(observed.candidates.length, 1); // intentional reinforcement possible
  assert.equal(f.sent.length, 1); // no automatic resend
  const stale = fixture();
  const firstSite = await first(stale);
  assert.equal(await stale.adapter.canExecute(firstSite.id, 0.1), true);
  assert.equal(await stale.adapter.execute(firstSite.id, 0.1), true);
  stale.clock(130);
  const review = await stale.adapter.propose(opts);
  assert.equal(review.candidates.length, 1); // fresh worker was queried
  assert.equal(stale.calls.length > 3, true);
});

test("pre-existing transport at a destination cannot falsely confirm a new intent", async () => {
  const f = fixture();
  const oldBoat = { id: () => 7, isActive: () => true,
    targetTile: () => 2, troops: () => 100 };
  f.setBoats([oldBoat]);
  const site = await first(f);
  assert.equal(await f.adapter.canExecute(site.id, 0.1), true);
  assert.equal(await f.adapter.execute(site.id, 0.1), true);
  f.clock(101);
  const unchanged = await f.adapter.propose(opts);
  assert.equal(unchanged.omissions.pending_intent, 1);
  f.setBoats([oldBoat, { id: () => 8, isActive: () => true,
    targetTile: () => 2, troops: () => 100 }]);
  const observed = await f.adapter.propose(opts);
  assert.equal(observed.candidates.length, 1);
  assert.equal(observed.boats.active_count, 2);
});

test("bounded geometric cohort and worker checks disclose every omission", async () => {
  const f = fixture(["A~B~B~B~B~B", "A~~~~~~~~~~"]);
  const p = await f.adapter.propose({ ...opts, maxCandidates: 4,
    maxCoastTiles: 10, maxPairs: 10, maxWorkerChecks: 2 });
  assert.equal(p.coverage.total_eligible, 5);
  assert.equal(p.candidates.length, 2);
  assert.equal(p.coverage.worker_checked, 2);
  assert.equal(p.omissions.worker_unchecked, 2);
  assert.equal(p.omissions.geometry_shortlist_limit, 1);
  assert.equal(p.coverage.omitted_count, 3);
  assert.equal(Object.values(p.omissions).reduce((sum, n) => sum + n, 0), 3);
});

test("tick drift bounded during proposal; final worker must stay on permit tick", async () => {
  const f = fixture();
  f.setWorker(async () => {
    f.clock(105);
    return [{ type: "Transport", canBuild: 0, canUpgrade: false, cost: 0n }];
  });
  const p = await f.adapter.propose(opts);
  assert.equal(p.source_tick, 100);
  assert.equal(p.current_tick, 105);
  const site = p.candidates[0];
  assert.equal(await f.adapter.canExecute(site.id, 0.2), true);
  f.clock(106);
  assert.equal(await f.adapter.execute(site.id, 0.2), false);
  const g = fixture();
  g.setWorker(async () => {
    g.clock(121);
    return [{ type: "Transport", canBuild: 0, canUpgrade: false, cost: 0n }];
  });
  await assert.rejects(g.adapter.propose(opts), /source_tick=100 current_tick=121/);
});
