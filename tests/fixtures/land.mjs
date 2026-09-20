export function observation(troops = 2500, troop_capacity = 12000) {
  return {
    self: { id: 1, troops, troop_capacity, territory_tiles: 52 },
    border: {
      total_edges: 20,
      wilderness_edges: 8,
      player_edges: 8,
      water_edges: 2,
      blocked_edges: 2,
    },
    neighbors: [
      {
        id: 2,
        type: "tribe",
        relationship: "unallied",
        shared_border_edges: 5,
        troops: 1000,
        troop_capacity: 5000,
        territory_tiles: 100,
        can_attack: true,
      },
      {
        id: 3,
        type: "human",
        relationship: "ally",
        shared_border_edges: 3,
        troops: 3000,
        troop_capacity: 12000,
        territory_tiles: 300,
        can_attack: false,
      },
    ],
    incoming_attacks: [
      { id: "incoming1", attacker_id: 2, troops: 100, retreating: false },
    ],
  };
}
