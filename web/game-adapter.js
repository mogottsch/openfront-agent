// GameView adapter: observations only read state; execution emits a normal
// attack intent through the small TypeScript bridge. No strategy lives here.
import { ATTACK_FRACTIONS, fractionsForTarget } from "./observation.js";

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
  return {
    read,
    async observe() {
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
      const observation = {
        self: stats(game, me),
        border,
        neighbors: [...contacts]
          .sort((a, b) => a[0] - b[0])
          .map(([id, contact]) => {
            const other = targetPlayer(id);
            if (!other)
              throw new Error("Neighbor disappeared during observation");
            return {
              ...stats(game, other),
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
      return { tick, observation };
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
