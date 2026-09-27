import test from "node:test";
import assert from "node:assert/strict";
import { observation } from "./fixtures/land.mjs";
import {
  recoverSingleActiveTribe,
  projectTribeFocus,
  selectedTribeForFocus,
} from "../web/tribe-focus.js";
import { buildActions, modelState } from "../web/observation.js";

function tribeSnapshot() {
  const o = observation(2500, 12000, "tribe");
  o.incoming_attacks[0].attacker_type = "tribe";
  return o;
}
const status = (overrides = {}) => ({
  status: "available",
  id: 2,
  tick: 100,
  game_id: "local-game",
  player_id: "tribe-player-2",
  alive: true,
  type: "tribe",
  territory_tiles: 700,
  relationship: "unallied",
  adjacent: true,
  worker_checked: true,
  can_attack: true,
  own_reserve_troops: 2500,
  target_reserve_troops: 900,
  reserve_ratio: 2.778,
  active_outgoing_count: 0,
  active_outgoing_troops: 0,
  ...overrides,
});

test("one existing funded tribe can be recovered without inventing a new target", () => {
  const o = tribeSnapshot();
  o.outgoing_attacks = [
    { id: "attack2", target_id: 2, troops: 1000, retreating: false },
  ];
  assert.equal(recoverSingleActiveTribe(o), 2);
  o.outgoing_attacks[0].retreating = true;
  assert.equal(recoverSingleActiveTribe(o), null);
  o.outgoing_attacks[0].retreating = false;
  o.neighbors.push({
    ...o.neighbors[0],
    id: 4,
    shared_border_edges: 1,
    incoming_attacks: [],
  });
  o.border.player_edges++;
  o.border.total_edges++;
  o.outgoing_attacks.push({
    id: "attack4",
    target_id: 4,
    troops: 900,
    retreating: false,
  });
  assert.equal(recoverSingleActiveTribe(o), null); // Jev, not a covert heuristic, picks focus
});

test("authoritative alive focus remains after army is no longer attacking", () => {
  const o = tribeSnapshot();
  o.outgoing_attacks = [];
  const projected = projectTribeFocus(
    { tick: 100, observation: o, focus_status: status() },
    2,
  );
  assert.equal(projected.kind, "active");
  assert.equal(projected.focusedId, 2);
  assert.equal(projected.observation.tribe_focus.id, 2);
  assert.equal(
    modelState(projected.observation).strategy.mode,
    "finish_focused_tribe",
  );
  assert.deepEqual(Object.keys(buildActions(projected.observation)), [
    "wait",
    "attack_player_2_10",
    "attack_player_2_20",
  ]);
});

test("only real isAlive(false) clears focus; unavailable or vanished neighbor does not", () => {
  const o = tribeSnapshot();
  const dead = projectTribeFocus(
    {
      tick: 100,
      observation: o,
      focus_status: {
        status: "dead",
        id: 2,
        tick: 100,
        game_id: "local-game",
        player_id: "tribe-player-2",
        alive: false,
        type: "tribe",
        territory_tiles: 0,
      },
    },
    2,
  );
  assert.equal(dead.kind, "conquered");
  assert.equal(dead.focusedId, null);
  for (const focus_status of [
    { status: "unavailable", id: 2, tick: 100, reason: "border_worker_error" },
    { status: "unavailable", id: 2, tick: 99, reason: "stale_snapshot" },
    null,
    status({ id: 99 }),
    status({ type: "nation" }),
    { status: "dead", id: 2, tick: 100, alive: false, type: "nation" },
  ]) {
    const projected = projectTribeFocus(
      { tick: 100, observation: o, focus_status },
      2,
    );
    assert.equal(projected.kind, "unavailable");
    assert.equal(projected.focusedId, 2);
    assert.equal(projected.observation, null);
  }
  const away = tribeSnapshot();
  away.neighbors = away.neighbors.filter((n) => n.id !== 2);
  away.border.player_edges -= 5;
  away.border.total_edges -= 5;
  away.incoming_attacks = [];
  const stillAlive = projectTribeFocus(
    {
      tick: 100,
      observation: away,
      focus_status: status({
        adjacent: false,
        worker_checked: false,
        can_attack: false,
        territory_tiles: 0,
      }),
    },
    2,
  );
  assert.equal(stillAlive.kind, "active");
  assert.equal(stillAlive.observation.tribe_focus.alive, true);
  assert.equal(
    buildActions(stillAlive.observation).attack_player_2_10,
    undefined,
  );
  assert.ok(buildActions(stillAlive.observation).attack_wilderness_10); // reconnect only
});

test("only an actually emitted tribe attack establishes persistent focus", () => {
  const o = tribeSnapshot();
  const chosen = { kind: "attack", target_id: 2, fraction: 0.1 };
  assert.equal(selectedTribeForFocus(chosen, o), 2);
  o.neighbors[0].type = "nation";
  o.incoming_attacks[0].attacker_type = "nation";
  assert.equal(selectedTribeForFocus(chosen, o), null);
  assert.equal(selectedTribeForFocus({ kind: "wait" }, o), null);
  assert.equal(
    selectedTribeForFocus({ kind: "attack", target_id: null }, o),
    null,
  );
});
