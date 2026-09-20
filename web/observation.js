// Shared by browser and sidecar. Derived values and legal candidates are code,
// not a strategy: none of these helpers chooses an action.
export const MAX_NEIGHBORS = 126; // wait + 2 wilderness + 2 per neighbor <= 255
export const OBSERVATION_ERROR =
  "Invalid land observation (self, border, neighbors, incoming_attacks)";
const fail = () => {
  throw new Error(OBSERVATION_ERROR);
};
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(value, k))
  )
    fail();
};
const number = (value, min = 0, max = 1e9) => {
  if (!Number.isFinite(value) || value < min || value > max) fail();
};
const integer = (value, min = 0, max = 1e9) => {
  number(value, min, max);
  if (!Number.isInteger(value)) fail();
};
const playerStats = (value) => {
  integer(value.id, 1, 4095);
  integer(value.troops);
  integer(value.troop_capacity, 1);
  integer(value.territory_tiles);
};

export function validateObservation(value) {
  exact(value, ["self", "border", "neighbors", "incoming_attacks"]);
  exact(value.self, ["id", "troops", "troop_capacity", "territory_tiles"]);
  playerStats(value.self);
  const edgeKeys = [
    "total_edges",
    "wilderness_edges",
    "player_edges",
    "water_edges",
    "blocked_edges",
  ];
  exact(value.border, edgeKeys);
  for (const key of edgeKeys) integer(value.border[key]);
  if (
    value.border.total_edges !==
    edgeKeys.slice(1).reduce((sum, key) => sum + value.border[key], 0)
  )
    fail();
  if (
    !Array.isArray(value.neighbors) ||
    value.neighbors.length > MAX_NEIGHBORS ||
    !Array.isArray(value.incoming_attacks) ||
    value.incoming_attacks.length > 256
  )
    fail();
  const ids = new Set([value.self.id]);
  let sharedEdges = 0;
  const neighbors = value.neighbors.map((n) => {
    exact(n, [
      "id",
      "type",
      "relationship",
      "shared_border_edges",
      "troops",
      "troop_capacity",
      "territory_tiles",
      "can_attack",
    ]);
    playerStats(n);
    integer(n.shared_border_edges, 1);
    if (
      ids.has(n.id) ||
      !["human", "nation", "tribe"].includes(n.type) ||
      !["unallied", "ally", "teammate"].includes(n.relationship) ||
      typeof n.can_attack !== "boolean" ||
      (n.can_attack &&
        (n.relationship !== "unallied" || n.territory_tiles === 0))
    )
      fail();
    ids.add(n.id);
    sharedEdges += n.shared_border_edges;
    return { ...n };
  });
  if (sharedEdges !== value.border.player_edges) fail();
  const attackIds = new Set();
  const attacks = value.incoming_attacks.map((a) => {
    exact(a, ["id", "attacker_id", "troops", "retreating"]);
    if (
      typeof a.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id) ||
      attackIds.has(a.id)
    )
      fail();
    integer(a.attacker_id, 1, 4095);
    integer(a.troops);
    if (a.attacker_id === value.self.id || typeof a.retreating !== "boolean")
      fail();
    attackIds.add(a.id);
    return { ...a };
  });
  return {
    self: { ...value.self },
    border: { ...value.border },
    neighbors,
    incoming_attacks: attacks,
  };
}

const round = (n, places = 4) => Number(n.toFixed(places));
const ratio = (a, b) => (b === 0 ? null : round(a / b));
const incomingFrom = (o, id) =>
  o.incoming_attacks
    .filter((a) => !a.retreating && (id === undefined || a.attacker_id === id))
    .reduce((sum, a) => sum + a.troops, 0);
const stats = (p) => ({
  ...p,
  reserve_percent: round((100 * p.troops) / p.troop_capacity, 2),
  troops_per_tile: ratio(p.troops, p.territory_tiles),
});

export function modelState(observation) {
  const o = validateObservation(observation);
  const share = (n) =>
    o.border.total_edges === 0 ? 0 : round(n / o.border.total_edges);
  return {
    self: { ...stats(o.self), active_incoming_troops: incomingFrom(o) },
    border: {
      ...o.border,
      wilderness_share: share(o.border.wilderness_edges),
      player_share: share(o.border.player_edges),
      water_share: share(o.border.water_edges),
      blocked_share: share(o.border.blocked_edges),
    },
    neighbors: o.neighbors.map((n) => ({
      ...stats(n),
      border_share: share(n.shared_border_edges),
      troops_attacking_us: incomingFrom(o, n.id),
    })),
    incoming_attacks: o.incoming_attacks,
  };
}

export function buildActions(observation) {
  const o = validateObservation(observation);
  const actions = { wait: { kind: "wait" } };
  const addTarget = (targetId, targetName, defenderTroops) => {
    for (const fraction of [0.1, 0.2]) {
      const committed = Math.floor(o.self.troops * 10 * fraction) / 10;
      if (committed < 0.1) continue;
      const id = `attack_${targetName}_${fraction * 100}`;
      actions[id] = {
        kind: "attack",
        target_id: targetId,
        fraction,
        troops_committed_estimate: committed,
        troops_remaining_estimate: round(o.self.troops - committed, 1),
        committed_to_defender_ratio:
          defenderTroops === null ? null : ratio(committed, defenderTroops),
      };
    }
  };
  if (o.border.wilderness_edges > 0) addTarget(null, "wilderness", null);
  for (const n of [...o.neighbors].sort((a, b) => a.id - b.id)) {
    if (n.can_attack && n.relationship === "unallied")
      addTarget(n.id, `player_${n.id}`, n.troops);
  }
  return actions;
}

export function actionCriteria(actions) {
  return Object.fromEntries(
    Object.entries(actions).map(([id, a]) => [
      id,
      a.kind === "wait"
        ? {
            action:
              "Send no new attack. Existing attacks and troop regeneration continue.",
          }
        : {
            action: "Commit troops to a normal land attack.",
            target:
              a.target_id === null
                ? "unclaimed wilderness"
                : `neighbor player ${a.target_id}`,
            percent_of_available_troops: a.fraction * 100,
            troops_committed_estimate: a.troops_committed_estimate,
            troops_remaining_estimate: a.troops_remaining_estimate,
            committed_to_defender_ratio: a.committed_to_defender_ratio,
          },
    ]),
  );
}
