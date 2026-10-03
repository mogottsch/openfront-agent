import test from "node:test";
import assert from "node:assert/strict";
import { createGameAdapter, summarizeBorders } from "../web/game-adapter.js";
import { buildActions, validateObservation } from "../web/observation.js";

function fixture() {
  const owners = [3, 2, 0, 0, 1, 0, 0, 0, 0];
  const water = new Set([3]),
    blocked = new Set([7]),
    immune = new Set(),
    allies = new Set(),
    dead = new Set();
  const status = { tick: 100, ready: true, ended: false };
  const players = new Map();
  const sent = [],
    checks = [],
    borderChecks = [];
  const game = {
    width: () => 3,
    height: () => 3,
    ref: (x, y) => y * 3 + x,
    ownerID: (t) => owners[t],
    isLand: (t) => !water.has(t),
    isImpassable: (t) => blocked.has(t),
    ticks: () => status.tick,
    gameID: () => "focus-fixture-game",
    neighbors: (t) => {
      const x = t % 3,
        y = Math.floor(t / 3);
      return [
        [x, y - 1],
        [x, y + 1],
        [x - 1, y],
        [x + 1, y],
      ]
        .filter(([x, y]) => x >= 0 && x < 3 && y >= 0 && y < 3)
        .map(([x, y]) => y * 3 + x);
    },
    config: () => ({ maxTroops: (p) => p.capacity }),
    myPlayer: () => players.get(1),
    playerBySmallID: (id) => {
      if (!players.has(id)) throw new Error("unknown player");
      return players.get(id);
    },
  };
  for (const id of [1, 2, 3])
    players.set(id, {
      army: id === 1 ? 25000 : 10000,
      capacity: id === 1 ? 120000 : 50000,
      smallID: () => id,
      id: () => `player-${id}`,
      isPlayer: () => true,
      isAlive: () => !dead.has(id),
      type: () => (id === 1 ? "HUMAN" : "BOT"),
      gold: () => 125000n,
      troops() {
        return this.army;
      },
      numTilesOwned: () => owners.filter((o) => o === id).length,
      isOnSameTeam: () => false,
      isAlliedWith: (other) => allies.has(other.smallID()),
      borderTiles: async () => {
        borderChecks.push(id);
        return { borderTiles: new Set(
          owners.flatMap((o, i) =>
            o === id && game.neighbors(i).some((t) => owners[t] !== id)
              ? [i]
              : [],
          ),
        ) };
      },
      outgoingAttacks: () => [],
      incomingAttacks: () =>
        id === 1
          ? [{ id: "a1", attackerID: 2, troops: 1234, retreating: false }]
          : [],
      actions: async (tile, units) => {
        checks.push([tile, units]);
        return { canAttack: !immune.has(owners[tile]) };
      },
    });
  const adapter = createGameAdapter({
    game,
    read: () => ({ ...status }),
    sendAttack: (target, troops) => {
      sent.push({ target, troops });
      return true;
    },
  });
  return {
    game,
    adapter,
    owners,
    water,
    blocked,
    immune,
    allies,
    dead,
    status,
    players,
    borderChecks,
    sent,
    checks,
  };
}

test("browser Goal context reads actual engine time/all alive registry, not only border contacts",async()=>{
  const f=fixture();const cfg={maxTroops:p=>p.capacity,isReplay:()=>false,
    gameConfig:()=>({gameType:"Singleplayer",gameMode:"Free For All",maxTimerValue:5}),
    percentageTilesOwnedToWin:()=>80};
  f.game.config=()=>cfg;f.game.players=()=>[...f.players.values()];
  f.game.elapsedGameSeconds=()=>3; // ticks100 minus real spawn offset, not10
  f.game.numLandTiles=()=>8;f.game.numTilesWithFallout=()=>0;
  const snap=await f.adapter.observe();
  assert.equal(snap.observation.win_context.source_tick,100);
  assert.equal(snap.observation.win_context.elapsed_seconds,3);
  assert.equal(snap.observation.win_context.eligible_alive_count,3);
  assert.equal(snap.observation.win_context.self_rank_by_tiles,1);
  assert.equal(snap.observation.win_context.tied_leader_count,3);
  assert.equal(snap.observation.win_context.leader,null);
  validateObservation(snap.observation);
  cfg.isReplay=()=>true;
  assert.equal(Object.hasOwn((await f.adapter.observe()).observation,"win_context"),false);
  assert.deepEqual(f.sent,[]); // no goal-driven intent
});

test("observes four cardinal contacts without including diagonal players", async () => {
  const f = fixture();
  const snap = await f.adapter.observe();
  assert.equal(snap.tick, 100);
  assert.deepEqual(snap.observation.border, {
    total_edges: 4,
    wilderness_edges: 1,
    player_edges: 1,
    water_edges: 1,
    blocked_edges: 1,
  });
  assert.deepEqual(
    snap.observation.neighbors.map((n) => n.id),
    [2],
  );
  assert.deepEqual(snap.observation.self, {
    id: 1,
    troops: 2500,
    troop_capacity: 12000,
    territory_tiles: 1,
    gold: "125000",
  });
  assert.equal(snap.observation.neighbors[0].can_attack, true);
  assert.equal(snap.observation.incoming_attacks[0].troops, 123);
  assert.deepEqual(f.checks, [[1, null]]);
  assert.doesNotThrow(() => validateObservation(snap.observation));
});

test("own gold is exact BigInt decimal, not a rounded browser number", async () => {
  const f = fixture();
  const huge = 2n ** 60n + 7n;
  f.players.get(1).gold = () => huge;
  assert.equal((await f.adapter.observe()).observation.self.gold, huge.toString());
  f.players.get(1).gold = () => -1n;
  await assert.rejects(f.adapter.observe(), /gold snapshot is unavailable/);
});

test("focusStatus reports a current neighboring tribe and our active non-retreating commitment", async () => {
  const f = fixture();
  f.players.get(1).outgoingAttacks = () => [
    { id: "mine-active", targetID: 2, troops: 3150.8, retreating: false },
    { id: "mine-retreat", targetID: 2, troops: 7000, retreating: true },
    { id: "mine-other", targetID: 3, troops: 2000, retreating: false },
  ];
  const focus = await f.adapter.focusStatus(2);
  assert.deepEqual(focus, {
    status: "available", id: 2, tick: 100,
    game_id: "focus-fixture-game", player_id: "player-2", alive: true,
    type: "tribe", territory_tiles: 1, relationship: "unallied",
    adjacent: true, worker_checked: true, can_attack: true,
    own_reserve_troops: 2500, target_reserve_troops: 1000,
    reserve_ratio: 2.5, active_outgoing_count: 1,
    active_outgoing_troops: 315,
  });
  assert.deepEqual(f.borderChecks, [1]);
  assert.deepEqual(f.checks, [[1, null]]);
});

test("focusStatus never infers death from absent neighbor contact or zero tiles", async () => {
  const f = fixture();
  f.owners[0] = 0; // player 3 still resolved and alive, but no owned tile
  const focus = await f.adapter.focusStatus(3);
  assert.equal(focus.status, "available");
  assert.equal(focus.alive, true);
  assert.equal(focus.territory_tiles, 0);
  assert.equal(focus.adjacent, false);
  assert.equal(focus.worker_checked, false);
  assert.equal(focus.can_attack, false);
  assert.deepEqual(f.checks, []);
  // Nor does losing the shared border prove that a resolved tribe has died.
  f.owners[1] = 0;
  const distant = await f.adapter.focusStatus(2);
  assert.equal(distant.status, "available");
  assert.equal(distant.adjacent, false);
  const transient = fixture();
  transient.players.get(2).numTilesOwned = () => 0;
  const zero = await transient.adapter.focusStatus(2);
  assert.equal(zero.status, "available");
  assert.equal(zero.territory_tiles, 0);
  assert.equal(zero.can_attack, false); // no contradictory legal zero-tile focus
});

test("resolved isAlive=false is dead; missing ID is unavailable, never fabricated dead", async () => {
  const f = fixture();
  f.owners[1] = 0;
  f.dead.add(2);
  const dead = await f.adapter.focusStatus(2);
  assert.deepEqual(dead, { status: "dead", id: 2, tick: 100,
    game_id: "focus-fixture-game", player_id: "player-2", alive: false,
    type: "tribe", territory_tiles: 0 });
  assert.equal(f.borderChecks.length, 0);
  f.players.delete(2);
  assert.deepEqual(await f.adapter.focusStatus(2),
    { status: "unavailable", id: 2, tick: 100, reason: "player_unresolved" });
  assert.deepEqual(await f.adapter.focusStatus(4096),
    { status: "unavailable", id: 4096, tick: 100, reason: "invalid_id" });
});

test("focusStatus rechecks real worker legality but never filters the action set", async () => {
  for (const change of ["immune", "ally"]) {
    const f = fixture();
    if (change === "immune") f.immune.add(2);
    else f.allies.add(2);
    const focus = await f.adapter.focusStatus(2);
    assert.equal(focus.status, "available");
    assert.equal(focus.adjacent, true);
    assert.equal(focus.worker_checked, true);
    assert.equal(focus.can_attack, false);
    if (change === "ally") assert.equal(focus.relationship, "ally");
    const snap = await f.adapter.observe();
    assert.equal("focus_status" in snap, false);
    assert.equal(snap.observation.neighbors.length, 1);
  }
});

test("resolved death during a border wait is authoritative; worker failure stays unavailable", async () => {
  const f = fixture();
  const original = f.players.get(1).borderTiles;
  f.players.get(1).borderTiles = async () => {
    f.dead.add(2);
    return original();
  };
  assert.equal((await f.adapter.focusStatus(2)).status, "dead");
  assert.equal(f.checks.length, 0);
  const unavailable = fixture();
  unavailable.players.get(1).actions = async () => {
    throw new Error("worker busy");
  };
  assert.deepEqual(await unavailable.adapter.focusStatus(2),
    { status: "unavailable", id: 2, tick: 100, reason: "action_worker_error" });
  const borderRace = fixture();
  borderRace.players.get(1).actions = async () => {
    borderRace.owners[1] = 0;
    return { canAttack: true };
  };
  assert.deepEqual(await borderRace.adapter.focusStatus(2),
    { status: "unavailable", id: 2, tick: 100, reason: "border_changed" });
});

test("focusStatus reports type/identity/tick drift as unavailable after worker awaits", async () => {
  for (const reason of ["type_changed", "identity_changed", "stale_snapshot"]) {
    const f = fixture();
    f.players.get(1).actions = async () => {
      if (reason === "type_changed") f.players.get(2).type = () => "NATION";
      if (reason === "identity_changed") {
        const prior = f.players.get(2);
        f.players.set(2, { ...prior });
      }
      if (reason === "stale_snapshot") f.status.tick++;
      return { canAttack: true };
    };
    const focus = await f.adapter.focusStatus(2);
    assert.deepEqual(focus, { status: "unavailable", id: 2,
      tick: 100, reason });
  }
});

test("observe({focusId}) shares one border snapshot and returns focus outside strict raw schema", async () => {
  const f = fixture();
  const snap = await f.adapter.observe({ focusId: 2 });
  assert.equal(snap.tick, 100);
  assert.equal(snap.focus_status.status, "available");
  assert.equal(snap.focus_status.tick, snap.tick);
  assert.equal("focus_status" in snap.observation, false);
  assert.doesNotThrow(() => validateObservation(snap.observation));
  assert.deepEqual(f.borderChecks, [1]); // focus reused border worker result
  assert.deepEqual(f.checks, [[1, null]]); // focus reused same action worker result
  assert.equal((await f.adapter.observe({ focusId: null })).focus_status, null);
  const stale = fixture();
  stale.players.get(1).actions = async () => {
    stale.status.tick++;
    return { canAttack: true };
  };
  const result = await stale.adapter.observe({ focusId: 2 });
  assert.equal(result.tick, 100);
  assert.deepEqual(result.focus_status,
    { status: "unavailable", id: 2, tick: 100, reason: "stale_snapshot" });
});

test("counts edges rather than unique border tiles and handles map edges missing from core borders", () => {
  const f = fixture();
  f.owners.fill(1);
  f.water.clear();
  f.blocked.clear();
  assert.equal(summarizeBorders(f.game, 1, []).border.blocked_edges, 12);
  f.owners.fill(0);
  f.owners[4] = 1;
  f.owners[1] = 2;
  f.owners[5] = 2;
  const result = summarizeBorders(f.game, 1, [4]);
  assert.equal(result.contacts.get(2).edges, 2);
  assert.equal(result.border.player_edges, 2);
  assert.equal(result.border.wilderness_edges, 2);
});

test("legal player attack translates smallID to current game ID and uses current internal troops", async () => {
  const f = fixture();
  const snapshot = await f.adapter.observe();
  const action = buildActions(snapshot.observation).attack_player_2_20;
  assert.equal(f.adapter.execute(action), false);
  assert.equal(await f.adapter.canExecute(action), true);
  f.players.get(1).army = 30000;
  assert.equal(f.adapter.execute(action), true);
  assert.deepEqual(f.sent, [{ target: "player-2", troops: 6000 }]);
  assert.equal(f.adapter.execute(action), false);
});

for (const fraction of [0.3, 0.4, 0.5]) {
  for (const target_id of [null, 2]) {
    test(`${fraction * 100}% executes against ${target_id ?? "wilderness"} using the current internal pool`, async () => {
      const f = fixture();
      if (target_id !== null) f.players.get(target_id).type = () => "NATION";
      const action = { kind: "attack", target_id, fraction };
      assert.equal(await f.adapter.canExecute(action), true);
      assert.equal(f.adapter.execute(action), true);
      assert.deepEqual(f.sent, [
        {
          target: target_id === null ? null : "player-2",
          troops: Math.floor(25000 * fraction),
        },
      ]);
    });
  }
}

test("tribe amounts above 20% are rejected even if a caller invents a larger action", async () => {
  const f = fixture();
  for (const fraction of [0.3, 0.4, 0.5])
    assert.equal(
      await f.adapter.canExecute({ kind: "attack", target_id: 2, fraction }),
      false,
    );
  assert.equal(f.checks.length, 0);
  assert.equal(f.sent.length, 0);
});

test("execution rechecks the tribe ceiling against the real target type", async () => {
  const f = fixture();
  f.players.get(2).type = () => "NATION";
  const action = { kind: "attack", target_id: 2, fraction: 0.5 };
  assert.equal(await f.adapter.canExecute(action), true);
  f.players.get(2).type = () => "BOT";
  assert.equal(f.adapter.execute(action), false);
  assert.equal(f.sent.length, 0);
});

test("captures other players attacking a neighbor and our existing commitments", async () => {
  const f = fixture();
  f.players.get(3).type = () => "NATION";
  const mine = {
    id: "mine",
    attackerID: 1,
    targetID: 2,
    troops: 3000,
    retreating: false,
  };
  f.players.get(1).outgoingAttacks = () => [mine];
  f.players.get(2).incomingAttacks = () => [
    mine,
    {
      id: "theirs",
      attackerID: 3,
      targetID: 2,
      troops: 5000,
      retreating: false,
    },
  ];
  const snapshot = await f.adapter.observe();
  assert.equal(
    snapshot.observation.neighbors[0].incoming_attacks[1].attacker_type,
    "nation",
  );
  assert.equal(
    snapshot.observation.neighbors[0].incoming_attacks[1]
      .attacker_reserve_troops,
    1000,
  );
  assert.deepEqual(snapshot.observation.outgoing_attacks, [
    { id: "mine", target_id: 2, troops: 300, retreating: false },
  ]);
  assert.doesNotThrow(() => validateObservation(snapshot.observation));
});

test("percentages outside the approved increments are rejected before a worker query", async () => {
  const f = fixture();
  for (const fraction of [-0.1, 0, 0.25, 0.6, 1, NaN]) {
    assert.equal(
      await f.adapter.canExecute({ kind: "attack", target_id: 2, fraction }),
      false,
    );
  }
  assert.equal(f.checks.length, 0);
  assert.equal(f.sent.length, 0);
});

test("wilderness uses a null target and 10% of the current internal pool", async () => {
  const f = fixture();
  const action = { kind: "attack", target_id: null, fraction: 0.1 };
  assert.equal(await f.adapter.canExecute(action), true);
  assert.equal(f.adapter.execute(action), true);
  assert.deepEqual(f.sent, [{ target: null, troops: 2500 }]);
});

test("immunity, allies, and lost borders remove or invalidate player attacks", async () => {
  for (const reason of ["immune", "ally", "lost"]) {
    const f = fixture();
    const action = { kind: "attack", target_id: 2, fraction: 0.2 };
    if (reason === "immune") f.immune.add(2);
    if (reason === "ally") f.allies.add(2);
    if (reason === "lost") f.owners[1] = 0;
    assert.equal(await f.adapter.canExecute(action), false);
    assert.equal(f.adapter.execute(action), false);
    assert.equal(f.sent.length, 0);
    if (reason !== "lost")
      assert.equal(
        (await f.adapter.observe()).observation.neighbors[0].can_attack,
        false,
      );
  }
});

test("a target becoming friendly during the worker query cannot be attacked", async () => {
  const f = fixture();
  f.players.get(1).actions = async () => {
    f.allies.add(2);
    return { canAttack: true };
  };
  assert.equal(
    await f.adapter.canExecute({ kind: "attack", target_id: 2, fraction: 0.2 }),
    false,
  );
  assert.equal(f.sent.length, 0);
});

test("a fresh worker check cannot be reused after a tick, target, or percentage changes", async () => {
  for (const change of ["tick", "target", "fraction", "ownership"]) {
    const f = fixture();
    const action = { kind: "attack", target_id: 2, fraction: 0.2 };
    assert.equal(await f.adapter.canExecute(action), true);
    if (change === "tick") f.status.tick++;
    if (change === "target") action.target_id = null;
    if (change === "fraction") action.fraction = 1;
    if (change === "ownership") f.owners[1] = 0;
    assert.equal(f.adapter.execute(action), false);
    assert.equal(f.sent.length, 0);
  }
});
