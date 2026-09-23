// Shared facts, arithmetic and explicit action limits. No helper chooses Jev's action.
export const MAX_NEIGHBORS = 126;
export const MAX_ACTIONS = 255;
export const MAX_ATTACK_RECORDS = 256;
export const ATTACK_FRACTIONS = Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5]);
export const TRIBE_ATTACK_FRACTIONS = Object.freeze([0.1, 0.2]);
export const fractionsForTarget = (type) =>
  type === "tribe" ? TRIBE_ATTACK_FRACTIONS : ATTACK_FRACTIONS;
export const OBSERVATION_ERROR =
  "Invalid land observation (self, border, neighbors, incoming_attacks, outgoing_attacks)";
const TYPES = ["human", "nation", "tribe"];
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
const integer = (value, min = 0, max = 1e9) => {
  if (!Number.isInteger(value) || value < min || value > max) fail();
};
const playerStats = (p) => {
  integer(p.id, 1, 4095);
  integer(p.troops);
  integer(p.troop_capacity, 1);
  integer(p.territory_tiles);
};

export function validateObservation(value) {
  exact(value, [
    "self",
    "border",
    "neighbors",
    "incoming_attacks",
    "outgoing_attacks",
  ]);
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
  if (!Array.isArray(value.neighbors) || value.neighbors.length > MAX_NEIGHBORS)
    fail();
  let attackRecords = 0;
  const attackerMetadata = new Map();
  const attackList = (list, targetId, outgoing = false) => {
    if (!Array.isArray(list)) fail();
    attackRecords += list.length;
    if (attackRecords > MAX_ATTACK_RECORDS) fail();
    const ids = new Set();
    return list.map((a) => {
      exact(
        a,
        outgoing
          ? ["id", "target_id", "troops", "retreating"]
          : [
              "id",
              "attacker_id",
              "attacker_type",
              "attacker_reserve_troops",
              "troops",
              "retreating",
            ],
      );
      if (
        typeof a.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id) ||
        ids.has(a.id) ||
        typeof a.retreating !== "boolean"
      )
        fail();
      ids.add(a.id);
      integer(a.troops);
      if (outgoing) {
        if (a.target_id !== null) integer(a.target_id, 1, 4095);
        if (a.target_id === value.self.id) fail();
      } else {
        integer(a.attacker_id, 1, 4095);
        integer(a.attacker_reserve_troops);
        if (a.attacker_id === targetId || !TYPES.includes(a.attacker_type))
          fail();
        const previous = attackerMetadata.get(a.attacker_id);
        if (
          previous &&
          (previous.type !== a.attacker_type ||
            previous.troops !== a.attacker_reserve_troops)
        )
          fail();
        attackerMetadata.set(a.attacker_id, {
          type: a.attacker_type,
          troops: a.attacker_reserve_troops,
        });
      }
      return { ...a };
    });
  };
  const incoming = attackList(value.incoming_attacks, value.self.id);
  const outgoing = attackList(value.outgoing_attacks, null, true);
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
      "incoming_attacks",
    ]);
    playerStats(n);
    integer(n.shared_border_edges, 1);
    if (
      ids.has(n.id) ||
      !TYPES.includes(n.type) ||
      !["unallied", "ally", "teammate"].includes(n.relationship) ||
      typeof n.can_attack !== "boolean" ||
      (n.can_attack &&
        (n.relationship !== "unallied" || n.territory_tiles === 0))
    )
      fail();
    ids.add(n.id);
    sharedEdges += n.shared_border_edges;
    return { ...n, incoming_attacks: attackList(n.incoming_attacks, n.id) };
  });
  if (sharedEdges !== value.border.player_edges) fail();
  // The same player's reserve must not vary between attack records or disagree
  // with its simultaneous player snapshot. Reserve is counted once per attacker.
  for (const p of [{ ...value.self, type: "human" }, ...neighbors]) {
    const metadata = attackerMetadata.get(p.id);
    if (metadata && (metadata.type !== p.type || metadata.troops !== p.troops))
      fail();
  }
  return {
    self: { ...value.self },
    border: { ...value.border },
    neighbors,
    incoming_attacks: incoming,
    outgoing_attacks: outgoing,
  };
}

const round = (n, places = 4) => Number(n.toFixed(places));
const ratio = (a, b) => (b === 0 ? null : round(a / b));
const active = (a) => !a.retreating && a.troops > 0;
const sum = (list) => list.reduce((total, a) => total + a.troops, 0);
const stats = (p) => ({
  ...p,
  reserve_percent: round((100 * p.troops) / p.troop_capacity, 2),
  troops_per_tile: ratio(p.troops, p.territory_tiles),
});

export function groupAttackers(attacks) {
  const groups = new Map();
  for (const a of attacks.filter(active)) {
    const group = groups.get(a.attacker_id) ?? {
      id: a.attacker_id,
      type: a.attacker_type,
      reserve_troops: a.attacker_reserve_troops,
      attacking_troops: 0,
    };
    group.attacking_troops += a.troops;
    groups.set(a.attacker_id, group);
  }
  return [...groups.values()].sort((a, b) => a.id - b.id);
}

export function modelState(observation) {
  const o = validateObservation(observation);
  const share = (n) =>
    o.border.total_edges === 0 ? 0 : round(n / o.border.total_edges);
  const incomingFrom = (id) =>
    sum(
      o.incoming_attacks.filter(
        (a) => active(a) && (id === undefined || a.attacker_id === id),
      ),
    );
  const wildernessTroops = sum(
    o.outgoing_attacks.filter((a) => active(a) && a.target_id === null),
  );
  return {
    self: {
      ...stats(o.self),
      active_incoming_troops: incomingFrom(),
      committed_outgoing_troops: sum(o.outgoing_attacks),
      active_wilderness_attack_troops: wildernessTroops,
      wilderness_attack_active: wildernessTroops > 0,
    },
    border: {
      ...o.border,
      wilderness_share: share(o.border.wilderness_edges),
      player_share: share(o.border.player_edges),
      water_share: share(o.border.water_edges),
      blocked_share: share(o.border.blocked_edges),
    },
    neighbors: o.neighbors.map((n) => {
      const attackers = groupAttackers(n.incoming_attacks);
      return {
        ...stats(n),
        border_share: share(n.shared_border_edges),
        troops_attacking_us: incomingFrom(n.id),
        attackers,
        attacked_by_other_humans_or_nations: attackers.some(
          (a) =>
            a.id !== o.self.id && (a.type === "human" || a.type === "nation"),
        ),
        our_active_attack_troops: sum(
          o.outgoing_attacks.filter((a) => active(a) && a.target_id === n.id),
        ),
      };
    }),
    attackers: groupAttackers(o.incoming_attacks).map((a) => {
      const total = a.reserve_troops + a.attacking_troops;
      return {
        ...a,
        total_force: total,
        our_reserve_to_total_force_ratio: ratio(o.self.troops, total),
        our_reserve_is_stronger: o.self.troops > total,
      };
    }),
    incoming_attacks: o.incoming_attacks,
    outgoing_attacks: o.outgoing_attacks,
  };
}

export function buildActions(observation) {
  const o = validateObservation(observation);
  const actions = {
    wait: {
      kind: "wait",
      troops_remaining_estimate: o.self.troops,
      reserve_percent_after_estimate: round(
        (100 * o.self.troops) / o.self.troop_capacity,
        2,
      ),
    },
  };
  const addTarget = (targetId, targetName, defenderTroops, type = null) => {
    for (const fraction of fractionsForTarget(type)) {
      const committed = Math.floor(o.self.troops * 10 * fraction) / 10;
      if (committed < 0.1) continue;
      const id = `attack_${targetName}_${fraction * 100}`;
      actions[id] = {
        kind: "attack",
        target_id: targetId,
        target_type: type ?? "wilderness",
        fraction,
        troops_committed_estimate: committed,
        troops_remaining_estimate: round(o.self.troops - committed, 1),
        reserve_percent_after_estimate: round(
          (100 * (o.self.troops - committed)) / o.self.troop_capacity,
          2,
        ),
        committed_to_defender_ratio:
          defenderTroops === null ? null : ratio(committed, defenderTroops),
      };
    }
  };
  if (o.border.wilderness_edges > 0) addTarget(null, "wilderness", null);
  for (const n of [...o.neighbors].sort((a, b) => a.id - b.id))
    if (n.can_attack && n.relationship === "unallied")
      addTarget(n.id, `player_${n.id}`, n.troops, n.type);
  if (Object.keys(actions).length > MAX_ACTIONS)
    throw new Error(
      `Too many legal land actions (maximum ${MAX_ACTIONS}); no targets were silently dropped`,
    );
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
            troops_remaining_estimate: a.troops_remaining_estimate,
            reserve_percent_after_estimate: a.reserve_percent_after_estimate,
          }
        : {
            action: "Commit troops to a normal land attack.",
            target:
              a.target_id === null
                ? "unclaimed wilderness"
                : `neighbor player ${a.target_id}`,
            target_type: a.target_type,
            percent_of_available_troops: a.fraction * 100,
            troops_committed_estimate: a.troops_committed_estimate,
            troops_remaining_estimate: a.troops_remaining_estimate,
            reserve_percent_after_estimate: a.reserve_percent_after_estimate,
            committed_to_defender_ratio: a.committed_to_defender_ratio,
          },
    ]),
  );
}
