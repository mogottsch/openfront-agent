// GameView adapter: observations only read state; execution emits a normal
// attack intent through the small TypeScript bridge. No strategy lives here.
import { ATTACK_FRACTIONS, fractionsForTarget } from "./observation.js";
import { observeNeighborStructures } from "./neighbor-defenses.js";
import { observeWinContext } from "./win-context.js";

export function summarizeBorders(game, playerId, borderTiles) {
  const border = {
    total_edges: 0,
    wilderness_edges: 0,
    player_edges: 0,
    water_edges: 0,
    blocked_edges: 0,
  };
  const contacts = new Map();
  let wildernessTile = null;
  for (const owned of borderTiles) {
    if (game.ownerID(owned) !== playerId) continue; // worker result may be older
    for (const tile of game.neighbors(owned)) {
      const owner = game.ownerID(tile);
      if (owner === playerId) continue;
      if (!game.isLand(tile)) border.water_edges++;
      else if (game.isImpassable(tile)) border.blocked_edges++;
      else if (owner === 0) {
        border.wilderness_edges++;
        wildernessTile ??= tile;
      } else {
        border.player_edges++;
        const contact = contacts.get(owner) ?? { edges: 0, tile };
        contact.edges++;
        contacts.set(owner, contact);
      }
    }
  }
  // Core borderTiles only includes in-map ownership changes. Map-edge tiles
  // can be absent from it, so count their outward edges separately (corners 2).
  for (let x = 0; x < game.width(); x++) {
    if (game.ownerID(game.ref(x, 0)) === playerId) border.blocked_edges++;
    if (game.ownerID(game.ref(x, game.height() - 1)) === playerId)
      border.blocked_edges++;
  }
  for (let y = 0; y < game.height(); y++) {
    if (game.ownerID(game.ref(0, y)) === playerId) border.blocked_edges++;
    if (game.ownerID(game.ref(game.width() - 1, y)) === playerId)
      border.blocked_edges++;
  }
  border.total_edges =
    border.wilderness_edges +
    border.player_edges +
    border.water_edges +
    border.blocked_edges;
  return { border, contacts, wildernessTile };
}

const typeName = { HUMAN: "human", NATION: "nation", BOT: "tribe" };
const relation = (me, other) =>
  me.isOnSameTeam(other)
    ? "teammate"
    : me.isAlliedWith(other)
      ? "ally"
      : "unallied";
const stats = (game, player) => ({
  id: player.smallID(),
  troops: Math.max(0, Math.floor(player.troops() / 10)),
  troop_capacity: Math.floor(game.config().maxTroops(player) / 10),
  territory_tiles: player.numTilesOwned(),
});
const validAction = (a) =>
  a?.kind === "attack" &&
  ATTACK_FRACTIONS.includes(a.fraction) &&
  (a.target_id === null ||
    (Number.isInteger(a.target_id) && a.target_id > 0 && a.target_id <= 4095));

export function createGameAdapter({ game, read, sendAttack }) {
  let permit = null;
  const matchingTile = (tile, targetId) =>
    game.isLand(tile) &&
    !game.isImpassable(tile) &&
    game.ownerID(tile) === (targetId ?? 0);
  const targetPlayer = (id) => {
    try {
      const p = game.playerBySmallID(id);
      return p.isPlayer() ? p : null;
    } catch {
      return null;
    }
  };
  const eligiblePlayer = (me, id, fraction) => {
    const other = targetPlayer(id);
    return other &&
      other.isAlive() &&
      other.smallID() !== me.smallID() &&
      relation(me, other) === "unallied" &&
      (fraction === undefined ||
        fractionsForTarget(typeName[other.type()]).includes(fraction))
      ? other
      : null;
  };
  // Focus is only a read-only lookup of an already chosen smallID. Missing
  // neighbor contact is not evidence of player death: query GameView's
  // authoritative PlayerView identity and alive flag directly instead.
  const focusUnavailable = (id, tick, reason) => ({
    status: "unavailable", id, tick, reason,
  });
  const focusChange = (tick, me, other, id, myPlayerId, targetPlayerId, type, gameId) => {
    const state = read();
    if (state?.ready !== true || state.ended === true ||
        state.tick !== tick || game.ticks() !== tick ||
        (gameId !== null && game.gameID?.() !== gameId)) return "stale_snapshot";
    if (game.myPlayer() !== me || me.id() !== myPlayerId ||
        targetPlayer(id) !== other || other.smallID() !== id ||
        other.id() !== targetPlayerId) return "identity_changed";
    if (other.type() !== type) return "type_changed";
    return null;
  };
  const incoming = (player) =>
    player.incomingAttacks().map((a) => {
      const attacker = targetPlayer(a.attackerID);
      if (!attacker) throw new Error("Attacker snapshot is unavailable");
      return {
        id: a.id,
        attacker_id: a.attackerID,
        attacker_type: typeName[attacker.type()],
        attacker_reserve_troops: Math.max(
          0,
          Math.floor(attacker.troops() / 10),
        ),
        troops: Math.max(0, Math.floor(a.troops / 10)),
        retreating: a.retreating,
      };
    });
  async function readFocusStatus(id, {
    expectedTick = null, borderTiles = null, prechecked = null,
  } = {}) {
    const actualTick = game.ticks();
    // When called by observe({focusId}), tick labels the requested snapshot;
    // a later actual tick means unavailable rather than relabeling old facts.
    const tick = expectedTick ?? actualTick;
    if (!Number.isInteger(id) || id < 1 || id > 4095)
      return focusUnavailable(id, tick, "invalid_id");
    const state = read();
    if (state?.ready !== true || state.ended === true ||
        state.tick !== actualTick || actualTick !== tick) {
      return focusUnavailable(id, tick, "stale_snapshot");
    }
    const me = game.myPlayer();
    const other = targetPlayer(id);
    if (!me || !other || other.smallID() !== id || other === me)
      return focusUnavailable(id, tick, "player_unresolved");
    const type = other.type();
    const name = typeName[type];
    if (!name) return focusUnavailable(id, tick, "type_unavailable");
    const playerId = other.id();
    const myPlayerId = me.id();
    const gameId = game.gameID?.() ?? null;
    const changed = () => focusChange(tick, me, other, id,
      myPlayerId, playerId, type, gameId);
    const unavailableIfChanged = () => {
      const reason = changed();
      return reason ? focusUnavailable(id, tick, reason) : null;
    };
    const initialChange = unavailableIfChanged();
    if (initialChange) return initialChange;
    const deadStatus = () => ({ status: "dead", id, tick,
      game_id: gameId, player_id: playerId, alive: false, type: name,
      territory_tiles: other.numTilesOwned() });
    // Only the authoritative resolved PlayerView alive bit proves death.
    // A player may be alive with no current border or zero owned tiles.
    if (other.isAlive() === false) return deadStatus();
    if (other.isAlive() !== true)
      return focusUnavailable(id, tick, "alive_unavailable");
    let borders = borderTiles;
    if (borders === null) {
      try { ({ borderTiles: borders } = await me.borderTiles()); }
      catch { return focusUnavailable(id, tick, "border_worker_error"); }
    }
    const staleBorder = unavailableIfChanged();
    if (staleBorder) return staleBorder;
    if (other.isAlive() === false) return deadStatus();
    if (other.isAlive() !== true)
      return focusUnavailable(id, tick, "alive_unavailable");
    if (!borders || typeof borders[Symbol.iterator] !== "function")
      return focusUnavailable(id, tick, "border_unavailable");
    let contact = null;
    outer: for (const owned of borders) {
      if (!Number.isInteger(owned) || owned < 0 ||
          owned >= game.width() * game.height()) {
        return focusUnavailable(id, tick, "border_unavailable");
      }
      if (game.ownerID(owned) !== me.smallID()) continue;
      for (const tile of game.neighbors(owned)) {
        if (matchingTile(tile, id)) {
          contact = tile;
          break outer;
        }
      }
    }
    let workerChecked = false;
    let workerCanAttack = false;
    if (contact !== null) {
      if (prechecked !== null) {
        // Only observe() can pass this internal result from its own real
        // worker query. The public focusStatus(id) always queries directly.
        if (prechecked.id !== id || prechecked.tick !== tick ||
            prechecked.tile !== contact ||
            typeof prechecked.worker_checked !== "boolean" ||
            typeof prechecked.can_attack !== "boolean") {
          return focusUnavailable(id, tick, "prechecked_mismatch");
        }
        workerChecked = prechecked.worker_checked;
        workerCanAttack = workerChecked && prechecked.can_attack;
      } else {
        try {
          const actions = await me.actions(contact, null);
          workerChecked = true;
          workerCanAttack = actions?.canAttack === true;
        } catch { return focusUnavailable(id, tick, "action_worker_error"); }
      }
    }
    const staleAction = unavailableIfChanged();
    if (staleAction) return staleAction;
    if (other.isAlive() === false) return deadStatus();
    if (other.isAlive() !== true)
      return focusUnavailable(id, tick, "alive_unavailable");
    if (contact !== null && (!matchingTile(contact, id) ||
        !game.neighbors(contact).some((tile) => game.ownerID(tile) === me.smallID()))) {
      return focusUnavailable(id, tick, "border_changed");
    }
    const owned = other.numTilesOwned();
    const ourInternal = me.troops();
    const theirInternal = other.troops();
    if (!Number.isInteger(owned) || owned < 0 ||
        !Number.isFinite(ourInternal) || ourInternal < 0 ||
        !Number.isFinite(theirInternal) || theirInternal < 0) {
      return focusUnavailable(id, tick, "strength_unavailable");
    }
    const ours = Math.floor(ourInternal / 10);
    const theirs = Math.floor(theirInternal / 10);
    let activeInternal = 0;
    let activeCount = 0;
    for (const attack of me.outgoingAttacks()) {
      if (attack.targetID !== id || attack.retreating ||
          !Number.isFinite(attack.troops) || attack.troops <= 0) continue;
      activeInternal += attack.troops;
      activeCount++;
    }
    const relationship = relation(me, other);
    return { status: "available", id, tick, game_id: gameId,
      player_id: playerId, alive: true, type: name,
      territory_tiles: owned, relationship, adjacent: contact !== null,
      worker_checked: workerChecked,
      can_attack: owned > 0 && contact !== null && workerCanAttack &&
        relationship === "unallied" && matchingTile(contact, id),
      own_reserve_troops: ours, target_reserve_troops: theirs,
      reserve_ratio: theirs > 0 ? Math.round(ours / theirs * 1000) / 1000 : null,
      active_outgoing_count: activeCount,
      active_outgoing_troops: Math.floor(activeInternal / 10) };
  }
  return {
    read,
    focusStatus: (id) => readFocusStatus(id),
    async observe({ focusId } = {}) {
      const me = game.myPlayer();
      if (!read().ready || !me)
        throw new Error("Game is not ready for observation");
      const { borderTiles } = await me.borderTiles();
      if (!read().ready) throw new Error("Game changed during observation");
      const tick = game.ticks();
      const { border, contacts } = summarizeBorders(
        game,
        me.smallID(),
        borderTiles,
      );
      const gold = me.gold?.();
      if (typeof gold !== "bigint" || gold < 0n)
        throw new Error("Own gold snapshot is unavailable");
      const observation = {
        self: { ...stats(game, me), gold: gold.toString() },
        border,
        neighbors: [...contacts]
          .sort((a, b) => a[0] - b[0])
          .map(([id, contact]) => {
            const other = targetPlayer(id);
            if (!other)
              throw new Error("Neighbor disappeared during observation");
            let structures;
            if (["BOT", "NATION"].includes(other.type()) && other.isAlive() === true &&
                typeof other.units === "function" && typeof game.gameID === "function") {
              structures = observeNeighborStructures(game, id);
              if (structures.source_tick !== tick)
                throw new Error("Neighbor structure facts changed observation tick");
            }
            return {
              ...stats(game, other),
              ...(structures ? {structures} : {}),
              type: typeName[other.type()],
              relationship: relation(me, other),
              shared_border_edges: contact.edges,
              can_attack: false,
              incoming_attacks: incoming(other),
            };
          }),
        incoming_attacks: incoming(me),
        outgoing_attacks: me.outgoingAttacks().map((a) => ({
          id: a.id,
          target_id: a.targetID === 0 ? null : a.targetID,
          troops: Math.max(0, Math.floor(a.troops / 10)),
          retreating: a.retreating,
        })),
      };
      const winContext = observeWinContext(game, me.smallID(), { expectedTick: tick });
      if (winContext && game.ticks() === tick &&
          me.numTilesOwned() === observation.self.territory_tiles)
        observation.win_context = winContext;
      // Ask the real worker about immunity/friendliness/adjacency. null skips
      // expensive buildable-unit calculations. No approximation of game rules.
      await Promise.all(
        observation.neighbors.map(async (n) => {
          if (n.relationship !== "unallied") return;
          const tile = contacts.get(n.id).tile;
          const actions = await me.actions(tile, null);
          n.can_attack =
            !!actions.canAttack &&
            !!eligiblePlayer(me, n.id) &&
            matchingTile(tile, n.id);
        }),
      );
      if (focusId === undefined) return { tick, observation };
      if (focusId === null) return { tick, observation, focus_status: null };
      // Do not put focus metadata into the strict raw observation yet. Reuse
      // the same border worker result and bind the focus lookup to this tick.
      const focusedNeighbor = observation.neighbors.find((n) => n.id === focusId);
      const focusContact = contacts.get(focusId);
      const prechecked = focusedNeighbor && focusContact ? {
        id: focusId, tick, tile: focusContact.tile,
        worker_checked: focusedNeighbor.relationship === "unallied",
        can_attack: focusedNeighbor.can_attack,
      } : null;
      const focus_status = await readFocusStatus(focusId, {
        expectedTick: tick, borderTiles, prechecked,
      });
      return { tick, observation, focus_status };
    },
    async canExecute(action) {
      permit = null;
      if (!validAction(action) || !read().ready) return false;
      const me = game.myPlayer();
      if (
        !me ||
        (action.target_id !== null &&
          !eligiblePlayer(me, action.target_id, action.fraction))
      )
        return false;
      const { borderTiles } = await me.borderTiles();
      if (!read().ready) return false;
      let candidate = null;
      outer: for (const owned of borderTiles) {
        if (game.ownerID(owned) !== me.smallID()) continue;
        for (const tile of game.neighbors(owned)) {
          if (matchingTile(tile, action.target_id)) {
            candidate = tile;
            break outer;
          }
        }
      }
      if (candidate === null) return false;
      const result = await me.actions(candidate, null);
      if (
        !result.canAttack ||
        !read().ready ||
        !matchingTile(candidate, action.target_id) ||
        (action.target_id !== null &&
          !eligiblePlayer(me, action.target_id, action.fraction))
      )
        return false;
      permit = {
        targetId: action.target_id,
        fraction: action.fraction,
        tile: candidate,
        tick: game.ticks(),
      };
      return true;
    },
    execute(action) {
      const checked = permit;
      permit = null; // single use; never execute without a fresh worker check
      if (
        !validAction(action) ||
        !checked ||
        !read().ready ||
        checked.tick !== game.ticks() ||
        checked.targetId !== action.target_id ||
        checked.fraction !== action.fraction ||
        !matchingTile(checked.tile, action.target_id)
      )
        return false;
      const me = game.myPlayer();
      if (!me) return false;
      const other =
        action.target_id === null
          ? null
          : eligiblePlayer(me, action.target_id, action.fraction);
      if (action.target_id !== null && !other) return false;
      const troops = Math.floor(me.troops() * action.fraction);
      if (troops < 1) return false;
      return sendAttack(other?.id() ?? null, troops);
    },
  };
}
