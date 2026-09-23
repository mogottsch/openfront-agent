import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createDefensePostAdapter } from "../web/defense-post-adapter.js";

function fixture(rows = ["A"], { gold = 100n, cost = 10n,
  range = 2, constructionTicks = 50 } = {}) {
  const width = rows[0].length;
  const height = rows.length;
  assert(rows.every((row) => row.length === width));
  const cells = rows.join("").split("");
  const owner = cells.map((c) => ({ A: 1, B: 2, C: 3 })[c] ?? 0);
  const state = { ready: true, ended: false, tick: 100 };
  let tick = 100;
  let gameID = "defense-game";
  let wallet = gold;
  let price = cost;
  let posts = [];
  let incoming = [];
  let friendly = false;
  let worker = async (tile) => [{ type: "Defense Post", canBuild: tile,
    canUpgrade: false, cost: price }];
  const calls = [];
  const sent = [];
  const me = { smallID: () => 1, gold: () => wallet,
    incomingAttacks: () => incoming,
    isFriendly: () => friendly,
    isOnSameTeam: () => false,
    units: () => posts,
    buildables: async (tile, types) => {
      calls.push({ tile, types });
      return worker(tile);
    } };
  const others = new Map([2, 3].map((id) => [id, {
    smallID: () => id, isPlayer: () => true, isAlive: () => true,
    isFriendly: () => friendly, isOnSameTeam: () => false,
  }]));
  const neighbors = (tile) => {
    const x = tile % width;
    const y = Math.floor(tile / width);
    return [y > 0 ? tile - width : null,
      y < height - 1 ? tile + width : null,
      x > 0 ? tile - 1 : null,
      x < width - 1 ? tile + 1 : null].filter((n) => n !== null);
  };
  const game = { width: () => width, height: () => height,
    ref: (x, y) => y * width + x,
    ownerID: (tile) => owner[tile],
    isLand: () => true,
    isImpassable: (tile) => cells[tile] === "#",
    neighbors, ticks: () => tick,
    gameID: () => gameID,
    myPlayer: () => me,
    playerBySmallID: (id) => others.get(id),
    config: () => ({ defensePostRange: () => range,
      unitInfo: (unit) => {
        assert.equal(unit, "Defense Post");
        return { constructionDuration: constructionTicks };
      } }),
  };
  let send = (unit, tile) => { sent.push({ unit, tile }); return true; };
  const adapter = createDefensePostAdapter({ game, read: () => state,
    sendBuild: (unit, tile) => send(unit, tile), defenseUnit: "Defense Post" });
  return { adapter, state, game, owner, calls, sent,
    clock: (n) => { tick = n; state.tick = n; },
    setGameID: (id) => { gameID = id; },
    setGold: (n) => { wallet = n; },
    setCost: (n) => { price = n; },
    setPosts: (items) => { posts = items; },
    setIncoming: (items) => { incoming = items; },
    setFriendly: (value) => { friendly = value; },
    setWorker: (fn) => { worker = fn; },
    setSend: (fn) => { send = fn; } };
}

function post(tile, construction = false, active = true) {
  return { tile: () => tile, isUnderConstruction: () => construction,
    isActive: () => active };
}

const opts = { maxCandidates: 8, maxExamined: 64, maxWorkerChecks: 8 };
const first = async (f) => (await f.adapter.propose(opts)).candidates[0];

test("tile-zero worker legality, BigInt gold, opaque ID and explicit save_gold no-op", async () => {
  const cost = 2n ** 60n;
  const f = fixture(["A"], { gold: cost + 7n, cost });
  const p = await f.adapter.propose(opts);
  assert.equal(p.mechanics.range_tiles, 2);
  assert.equal(p.mechanics.construction_ticks, 50);
  assert.match(p.mechanics.coverage_model, /not promised combat protection/);
  assert.equal(p.available_gold, (cost + 7n).toString());
  assert.deepEqual(p.posts, { active_completed: 0, under_construction: 0,
    status_unknown: 0, pending_unconfirmed: 0 });
  const candidate = p.candidates[0];
  assert.equal(candidate.cost_gold, cost.toString());
  assert.equal(candidate.gold_after_estimate, "7");
  assert.equal(candidate.kind, "build_defense_post");
  assert.equal(candidate.marginal_owned_territory_tiles, 1);
  assert.equal("marginal_coverage_tiles" in candidate, false);
  assert.match(candidate.id, /:dp1$/);
  assert.equal("tile" in candidate, false);
  assert.deepEqual(f.calls[0], { tile: 0, types: ["Defense Post"] });
  assert.equal(await f.adapter.canExecute(p.save_gold.id), true);
  assert.equal(await f.adapter.execute(p.save_gold.id), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(await f.adapter.execute(candidate.id), false); // no permit
  assert.equal(await f.adapter.canExecute(candidate.id), true);
  assert.equal(await f.adapter.execute(candidate.id), true);
  assert.deepEqual(f.sent, [{ unit: "Defense Post", tile: 0 }]);
  assert.equal(await f.adapter.execute(candidate.id), false);
});

test("active completed post covers radius; construction and unknown status do not", async () => {
  const f = fixture([
    "BBBBBBB",
    "AAAAAAA",
    "AAAAAAA",
    "AAAAAAA",
  ]);
  f.setPosts([post(f.game.ref(0, 2)), post(f.game.ref(6, 2), true)]);
  f.setIncoming([{ attackerID: 2, retreating: false, troops: 100 },
    { attackerID: 3, retreating: false, troops: 100 }]);
  const p = await f.adapter.propose(opts);
  assert.equal(p.posts.active_completed, 1);
  assert.equal(p.posts.under_construction, 1);
  assert.deepEqual(p.incoming.observed_attacker_ids, [2, 3]);
  assert.deepEqual(p.incoming.non_retreating_attacker_ids, [2, 3]);
  assert.deepEqual(p.incoming.ids_without_land_contact, [3]);
  assert.equal(p.incoming.contact_is_only_potential, true);
  // Own front is row y=1, x=0..6. Radius-2 post at (0,2) covers x=0,1;
  // the construction at (6,2) must NOT claim to cover x=5,6 yet.
  assert.equal(p.coverage.uncovered_hostile_front_contacts, 5);
  assert.equal(p.coverage.uncovered_potential_incoming_front_contacts, 5);
  assert(p.candidates.some((c) => c.marginal_hostile_front_contacts > 0));
  assert(p.candidates.some((c) =>
    c.marginal_potential_incoming_front_contacts > 0 &&
    c.potential_incoming_contact_ids.includes(2)));
  const noIncoming = fixture(["BBBB", "AAAA", "AAAA"]);
  const quiet = await noIncoming.adapter.propose(opts);
  assert(quiet.candidates.some((c) => c.marginal_hostile_front_contacts > 0));
  assert(quiet.candidates.every((c) => c.marginal_potential_incoming_front_contacts === 0));
});

test("configured radius larger than map width still covers diagonal corners exactly", async () => {
  const f = fixture(Array.from({ length: 5 }, () => "AAAAA"), { range: 6 });
  const p = await f.adapter.propose({ maxCandidates: 25,
    maxExamined: 25, maxWorkerChecks: 25 });
  const index = f.calls.findIndex(({ tile }) => tile === 0);
  assert(index >= 0);
  assert.equal(p.candidates[index].marginal_owned_territory_tiles, 25);
  assert.equal(p.mechanics.range_tiles, 6);
});

test("unrelated incoming attacker ID never invents a border path", async () => {
  const f = fixture(["AAAA", "AAAA"]);
  f.setIncoming([{ attackerID: 3, retreating: false, troops: 10 }]);
  const p = await f.adapter.propose(opts);
  assert.deepEqual(p.incoming.ids_without_land_contact, [3]);
  assert(p.candidates.every((c) =>
    c.marginal_potential_incoming_front_contacts === 0));
});

test("unknown post status never claims coverage; friendly/retreating contacts are not incoming threats", async () => {
  const f = fixture(["BB", "AA"]);
  f.setPosts([{ tile: () => 2, isActive: () => true },
    { tile: () => 3, isUnderConstruction: () => false }]);
  f.setIncoming([{ attackerID: 2, retreating: true, troops: 100 }]);
  const p = await f.adapter.propose(opts);
  assert.equal(p.posts.active_completed, 0);
  assert.equal(p.posts.status_unknown, 2);
  assert.equal(p.coverage.uncovered_hostile_front_contacts, 2);
  assert.equal(p.coverage.uncovered_potential_incoming_front_contacts, 0);
  assert.deepEqual(p.incoming.observed_attacker_ids, [2]);
  assert.deepEqual(p.incoming.non_retreating_attacker_ids, []);
  assert.equal(p.omissions.occupied_post, 2);
  const allied = fixture(["BB", "AA"]);
  allied.setFriendly(true);
  const q = await allied.adapter.propose(opts);
  assert.equal(q.coverage.uncovered_hostile_front_contacts, 0);
});

test("worker relocation, upgrade and insufficient gold never become build candidates", async () => {
  const f = fixture(["AAAAA"], { gold: 11n, cost: 10n });
  let n = 0;
  f.setWorker(async (tile) => {
    n++;
    if (n === 1) return [{ type: "Defense Post", canBuild: (tile + 1) % 5,
      canUpgrade: false, cost: 10n }];
    if (n === 2) return [{ type: "Defense Post", canBuild: tile,
      canUpgrade: 0, cost: 10n }];
    if (n === 3) return [{ type: "Defense Post", canBuild: tile,
      canUpgrade: false, cost: 12n }];
    return [{ type: "Defense Post", canBuild: tile,
      canUpgrade: false, cost: 10n }];
  });
  const p = await f.adapter.propose({ ...opts, maxCandidates: 3,
    maxWorkerChecks: 4 });
  assert.equal(p.omissions.relocated, 1);
  assert.equal(p.omissions.upgrade_not_build, 1);
  assert.equal(p.omissions.unaffordable, 1);
  assert.equal(p.candidates.length, 1);
  assert.equal(p.coverage.omitted_count, 4);
});

test("all candidate balances use one final gold snapshot across worker awaits", async () => {
  const f = fixture(["AAA"], { gold: 30n, cost: 10n });
  let count = 0;
  f.setWorker(async (tile) => {
    if (++count === 3) f.setGold(12n);
    return [{ type: "Defense Post", canBuild: tile,
      canUpgrade: false, cost: 10n }];
  });
  const p = await f.adapter.propose({ ...opts, maxWorkerChecks: 3 });
  assert.equal(p.available_gold, "12");
  assert(p.candidates.every((c) => BigInt(c.cost_gold) +
    BigInt(c.gold_after_estimate) === 12n));
  const low = fixture(["AA"], { gold: 30n, cost: 10n });
  let attempts = 0;
  low.setWorker(async (tile) => {
    if (++attempts === 2) low.setGold(4n);
    return [{ type: "Defense Post", canBuild: tile,
      canUpgrade: false, cost: 10n }];
  });
  const changed = await low.adapter.propose({ ...opts, maxWorkerChecks: 2 });
  assert.equal(changed.candidates.length, 0);
  assert.equal(changed.omissions.unaffordable_after_check, 1);
  assert.equal(changed.omissions.unaffordable, 1);
});

test("bounded prefilter/worker cohort reports every omitted site", async () => {
  const f = fixture(["A".repeat(40)]);
  const p = await f.adapter.propose({ ...opts, maxCandidates: 2,
    maxExamined: 10, maxWorkerChecks: 3 });
  assert.equal(f.calls.length, 2); // stops once cohort is full
  assert.equal(p.coverage.total_eligible, 40);
  assert.equal(p.coverage.total_examined, 10);
  assert.equal(p.coverage.worker_checked, 2);
  assert.equal(p.omissions.not_examined, 30);
  assert.equal(p.omissions.geometry_shortlist_limit, 7);
  assert.equal(p.omissions.shortlist_limit, 1);
  assert.equal(p.coverage.omitted_count, 38);
  assert.equal(Object.values(p.omissions).reduce((n, value) => n + value, 0), 38);
});

test("pending spend waits for observed post or construction-duration review", async () => {
  const f = fixture();
  const site = await first(f);
  assert.equal(await f.adapter.canExecute(site.id), true);
  assert.equal(await f.adapter.execute(site.id), true);
  f.clock(101);
  const unconfirmed = await f.adapter.propose(opts);
  assert.equal(unconfirmed.candidates.length, 0);
  assert.equal(unconfirmed.omissions.pending_intent, 1);
  assert.equal(unconfirmed.posts.pending_unconfirmed, 1);
  f.setPosts([post(0, true)]);
  const visible = await f.adapter.propose(opts);
  assert.equal(visible.posts.under_construction, 1);
  assert.equal(visible.posts.active_completed, 0);
  assert.equal(visible.posts.pending_unconfirmed, 0);
  assert.equal(visible.omissions.occupied_post, 1);
  const stale = fixture();
  const firstSite = await first(stale);
  assert.equal(await stale.adapter.canExecute(firstSite.id), true);
  assert.equal(await stale.adapter.execute(firstSite.id), true);
  stale.clock(159); // < construction 50 + 10 ticks
  assert.equal((await stale.adapter.propose(opts)).omissions.pending_intent, 1);
  stale.clock(160);
  assert.equal((await stale.adapter.propose(opts)).candidates.length, 1);
  assert.equal(stale.sent.length, 1); // never resends automatically
});

test("same-tick worker, gold, ownership and post-status changes discard permit", async () => {
  for (const change of ["worker", "gold", "owner", "construction"]) {
    const f = fixture();
    const site = await first(f);
    assert.equal(await f.adapter.canExecute(site.id), true);
    if (change === "worker") f.setWorker(async () => [{ type: "Defense Post",
      canBuild: false, canUpgrade: false, cost: 10n }]);
    if (change === "gold") f.setGold(9n);
    if (change === "owner") f.owner[0] = 2;
    if (change === "construction") f.setPosts([post(0, true)]);
    assert.equal(await f.adapter.execute(site.id), false, change);
    assert.equal(f.sent.length, 0, change);
  }
});

test("Stop/restart during final worker wait consumes permit; save needs no worker", async () => {
  const f = fixture();
  const p = await f.adapter.propose(opts);
  const site = p.candidates[0];
  assert.equal(await f.adapter.canExecute(site.id), true);
  let release;
  f.setWorker(() => new Promise((resolve) => { release = resolve; }));
  let generation = 1;
  const execution = f.adapter.execute(site.id, () => generation === 1);
  generation = 2;
  release([{ type: "Defense Post", canBuild: 0,
    canUpgrade: false, cost: 10n }]);
  assert.equal(await execution, false);
  assert.equal(await f.adapter.execute(site.id), false);
  assert.equal(f.sent.length, 0);
  assert.equal(await f.adapter.execute(p.save_gold.id, () => false), false);
});

test("explicit medium-map trial measures bounded geometry and worker cohort", async () => {
  const rows = Array.from({ length: 256 }, () =>
    "A".repeat(160) + "B".repeat(160));
  const f = fixture(rows, { range: 30 });
  f.setIncoming([{ attackerID: 2, retreating: false, troops: 50 }]);
  const start = performance.now();
  const p = await f.adapter.propose({ maxCandidates: 8,
    maxExamined: 512, maxWorkerChecks: 8 });
  const elapsed = performance.now() - start;
  assert(p.candidates.length <= 8 && f.calls.length <= 8);
  assert.equal(p.coverage.total_examined, 512);
  assert(elapsed < 5000, `Explicit proposal took ${elapsed.toFixed(1)}ms`);
  process.stdout.write(`defense 320x256: proposal ${elapsed.toFixed(1)}ms; ` +
    `worker ${p.coverage.worker_checked}; omitted ${p.coverage.omitted_count}\n`);
});

test("proposal tolerates bounded tick drift, but final worker must remain on permit tick", async () => {
  const f = fixture();
  f.setWorker(async (tile) => {
    f.clock(105);
    return [{ type: "Defense Post", canBuild: tile,
      canUpgrade: false, cost: 10n }];
  });
  const p = await f.adapter.propose(opts);
  assert.equal(p.source_tick, 100);
  assert.equal(p.current_tick, 105);
  const site = p.candidates[0];
  assert.equal(await f.adapter.canExecute(site.id), true);
  f.clock(106);
  assert.equal(await f.adapter.execute(site.id), false);
  const stale = fixture();
  stale.setWorker(async (tile) => {
    stale.clock(121);
    return [{ type: "Defense Post", canBuild: tile,
      canUpgrade: false, cost: 10n }];
  });
  await assert.rejects(stale.adapter.propose(opts), /source_tick=100 current_tick=121/);
});
