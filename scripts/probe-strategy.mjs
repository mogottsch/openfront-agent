// Explicit paid probes; importing this module never makes requests.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { observation } from "../tests/fixtures/land.mjs";
import { modelState } from "../web/observation.js";

export function strategyProbeCases() {
  const pressure = observation(20000, 60000, "nation");
  pressure.self.territory_tiles = 3000;
  pressure.border = {
    total_edges: 220,
    wilderness_edges: 120,
    player_edges: 60,
    water_edges: 40,
    blocked_edges: 0,
  };
  Object.assign(pressure.neighbors[0], {
    troops: 12000,
    troop_capacity: 30000,
    territory_tiles: 1000,
    shared_border_edges: 40,
  });
  pressure.neighbors[1].shared_border_edges = 20;
  pressure.incoming_attacks = [
    {
      id: "pressure",
      attacker_id: 2,
      attacker_type: "nation",
      attacker_reserve_troops: 12000,
      troops: 15000,
      retreating: false,
    },
  ];
  const gold = observation(6000, 20000, "tribe");
  gold.incoming_attacks = [];
  gold.self.territory_tiles = 500;
  gold.border = {
    total_edges: 100,
    wilderness_edges: 40,
    player_edges: 40,
    water_edges: 20,
    blocked_edges: 0,
  };
  Object.assign(gold.neighbors[0], {
    troops: 500,
    territory_tiles: 70,
    shared_border_edges: 10,
  });
  gold.neighbors[1].shared_border_edges = 30;
  gold.neighbors[0].incoming_attacks = [
    {
      id: "race",
      attacker_id: 99,
      attacker_type: "nation",
      attacker_reserve_troops: 12000,
      troops: 2000,
      retreating: false,
    },
  ];
  const tribeOnly = structuredClone(gold);
  tribeOnly.neighbors[0].incoming_attacks[0].attacker_type = "tribe";
  const ownOnly = structuredClone(gold);
  Object.assign(ownOnly.neighbors[0].incoming_attacks[0], {
    attacker_id: 1,
    attacker_type: "human",
    attacker_reserve_troops: 6000,
  });
  ownOnly.outgoing_attacks = [
    { id: "race", target_id: 2, troops: 2000, retreating: false },
  ];
  const healthyWild = observation(6000, 12141);
  healthyWild.neighbors = [];
  healthyWild.incoming_attacks = [];
  healthyWild.border = {
    total_edges: 32,
    wilderness_edges: 32,
    player_edges: 0,
    water_edges: 0,
    blocked_edges: 0,
  };
  const depleted = structuredClone(healthyWild);
  Object.assign(depleted.self, {
    troops: 565,
    troop_capacity: 25646,
    territory_tiles: 1431,
  });
  depleted.border.total_edges = 200;
  depleted.border.wilderness_edges = 200;
  depleted.outgoing_attacks = [
    { id: "expansion", target_id: null, troops: 1200, retreating: false },
  ];
  const farm = structuredClone(gold);
  Object.assign(farm.self, {
    troops: 17000,
    troop_capacity: 34395,
    territory_tiles: 3000,
  });
  farm.border.total_edges -= farm.border.wilderness_edges;
  farm.border.wilderness_edges = 0;
  farm.neighbors[0].incoming_attacks = [];
  const wilderness = ["10", "20", "30", "40", "50"].map(
    (p) => `attack_wilderness_${p}`,
  );
  return [
    {
      name: "20k reserve versus 12k reserve plus 15k incoming",
      state: pressure,
      expected: ["wait"],
    },
    {
      name: "tribe already attacked by another nation",
      state: gold,
      expected: ["attack_player_2_10", "attack_player_2_20"],
    },
    {
      name: "control: only another tribe attacks it",
      state: tribeOnly,
      expected: ["wait", ...wilderness],
    },
    {
      name: "control: only our own attack is running",
      state: ownOnly,
      expected: ["wait", ...wilderness],
    },
    {
      name: "depleted reserve with wilderness push already running",
      state: depleted,
      expected: ["wait"],
    },
    {
      name: "healthy reserve and no active wilderness push",
      state: healthyWild,
      expected: wilderness,
    },
    {
      name: "healthy reserve, weak tribe, no wilderness",
      state: farm,
      expected: ["attack_player_2_10", "attack_player_2_20"],
    },
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = [];
  for (const example of strategyProbeCases()) {
    const response = await fetch("http://127.0.0.1:8788/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(example.state),
      signal: AbortSignal.timeout(10000),
    });
    const answer = await response.json();
    if (!response.ok)
      throw new Error(answer.error || `Sidecar HTTP ${response.status}`);
    const record = {
      ...example,
      modelState: modelState(example.state),
      answer,
      matched: example.expected.includes(answer.action),
    };
    results.push(record);
    console.log(
      JSON.stringify({
        case: example.name,
        action: answer.action,
        confidence: answer.confidence,
        matched: record.matched,
      }),
    );
  }
  await mkdir("logs", { recursive: true });
  await writeFile(
    "logs/strategy-probes-latest.json",
    JSON.stringify(
      {
        kind: "Real API calls on fixed observations; not live gameplay",
        results,
      },
      null,
      2,
    ) + "\n",
  );
  if (results.some((r) => !r.matched)) process.exitCode = 1;
}
