import test from "node:test";
import assert from "node:assert/strict";
import { createGameAdapter, summarizeBorders } from "../web/game-adapter.js";
import { buildActions, validateObservation } from "../web/observation.js";

function fixture() {
  const owners = [3, 2, 0, 0, 1, 0, 0, 0, 0];
  const water = new Set([3]),
    blocked = new Set([7]),
    immune = new Set(),
    allies = new Set();
  const status = { tick: 100, ready: true, ended: false };
  const players = new Map();
  const sent = [],
    checks = [];
  const game = {
    width: () => 3,
    height: () => 3,
    ref: (x, y) => y * 3 + x,
    ownerID: (t) => owners[t],
    isLand: (t) => !water.has(t),
    isImpassable: (t) => blocked.has(t),
    ticks: () => status.tick,
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
      isAlive: () => owners.includes(id),
      type: () => (id === 1 ? "HUMAN" : "BOT"),
      troops() {
        return this.army;
      },
      numTilesOwned: () => owners.filter((o) => o === id).length,
      isOnSameTeam: () => false,
      isAlliedWith: (other) => allies.has(other.smallID()),
      borderTiles: async () => ({
        borderTiles: new Set(
          owners.flatMap((o, i) =>
            o === id && game.neighbors(i).some((t) => owners[t] !== id)
              ? [i]
              : [],
          ),
        ),
      }),
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
    status,
    players,
    sent,
    checks,
  };
}

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
  });
  assert.equal(snap.observation.neighbors[0].can_attack, true);
  assert.equal(snap.observation.incoming_attacks[0].troops, 123);
  assert.deepEqual(f.checks, [[1, null]]);
  assert.doesNotThrow(() => validateObservation(snap.observation));
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
