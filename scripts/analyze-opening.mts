import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openingPolicies } from "./opening-policies.mjs";

// Execute with the sibling checkout's tsx (see README). Dynamic imports let the
// same experiment run against an explicitly selected OPENFRONT_DIR.
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { AttackExecution } = await load("src/core/execution/AttackExecution.ts");
const { SpawnExecution } = await load("src/core/execution/SpawnExecution.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
} = await load("src/core/game/Game.ts");

const smoke = process.argv.includes("--smoke");
const policies = openingPolicies().filter(
  (p) =>
    !smoke ||
    ["fixed-20-every-1s", "fixed-10-every-2s", "reserve-42"].includes(p.name),
);
const horizon = 600; // 60 seconds; normal simulation rate is 10 ticks/second.
const config = new Config(
  {
    gameMap: GameMapType.Europe,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Medium,
    nations: 0,
    bots: 0,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  },
  null,
  false,
);

type Scenario = {
  name: string;
  x: number;
  y: number;
  map: () => any;
  mini: () => any;
};
const scenarios: Scenario[] = [];
for (const [name, magnitude] of [
  ["plains", 0],
  ["highland", 10],
  ["mountain", 20],
] as const) {
  const side = 512;
  const terrain = 128 | magnitude; // passable land, same encoding as map.bin
  scenarios.push({
    name: `synthetic-${name}`,
    x: side / 2,
    y: side / 2,
    map: () =>
      new GameMapImpl(
        side,
        side,
        new Uint8Array(side * side).fill(terrain),
        side * side,
      ),
    mini: () =>
      new GameMapImpl(
        side / 2,
        side / 2,
        new Uint8Array((side * side) / 4).fill(terrain),
        (side * side) / 4,
      ),
  });
}
if (!smoke) {
  const dir = resolve(root, "resources/maps/europe");
  const manifest = JSON.parse(
    await readFile(resolve(dir, "manifest.json"), "utf8"),
  );
  const main = await readFile(resolve(dir, "map.bin"));
  const mini = await readFile(resolve(dir, "map4x.bin"));
  for (const [name, x, y] of [
    ["france", 1087, 983],
    ["poland", 1751, 772],
    ["switzerland", 1339, 997],
  ] as const) {
    scenarios.push({
      name: `europe-${name}`,
      x,
      y,
      map: () =>
        new GameMapImpl(
          manifest.map.width,
          manifest.map.height,
          new Uint8Array(main),
          manifest.map.num_land_tiles,
        ),
      mini: () =>
        new GameMapImpl(
          manifest.map4x.width,
          manifest.map4x.height,
          new Uint8Array(mini),
          manifest.map4x.num_land_tiles,
        ),
    });
  }
}
if (smoke) scenarios.splice(1);

const results = [];
for (const scenario of scenarios) {
  for (const policy of policies) {
    const playerInfo = new PlayerInfo(
      "Opening analysis",
      PlayerType.Human,
      "analysis",
      "analysis",
    );
    const game = createGame(
      [playerInfo],
      [],
      scenario.map(),
      scenario.mini(),
      config,
    );
    const player = game.player(playerInfo.id);
    if (
      !game.isLand(game.ref(scenario.x, scenario.y)) ||
      game.isImpassable(game.ref(scenario.x, scenario.y))
    )
      throw new Error(`Invalid spawn: ${scenario.name}`);
    game.addExecution(
      new SpawnExecution(
        "opening1",
        playerInfo,
        game.ref(scenario.x, scenario.y),
      ),
    );
    // Real spawn registers the real PlayerExecution (including troop growth).
    game.executeNextTick();
    game.executeNextTick();
    if (!player.hasSpawned() || game.inSpawnPhase())
      throw new Error("Spawn did not finish");
    const takeSnapshot = (seconds: number) => {
      const troops = player.troops();
      const committed = player
        .outgoingAttacks()
        .reduce((sum: number, a: any) => sum + a.troops(), 0);
      const capacity = config.maxTroops(player);
      return {
        seconds,
        tiles: player.numTilesOwned(),
        reserve: Math.round(troops / 10),
        committed: Math.round(committed / 10),
        remaining: Math.round((troops + committed) / 10),
        capacity: Math.round(capacity / 10),
        reserveFraction: troops / capacity,
      };
    };
    const initial = takeSnapshot(0);
    const actions = [];
    const snapshots = [];
    let landTileSeconds = 0;
    let ratioSum = 0;
    for (let tick = 0; tick < horizon; tick++) {
      // Every policy sees a fresh state once per game second. No API latency,
      // no models, and no changes to combat, growth, capacity, or attack merging.
      if (tick % 10 === 0) {
        const troops = player.troops();
        const capacity = config.maxTroops(player);
        const fraction = policy.choose({ troops, capacity, tick });
        if (![0, 0.1, 0.2].includes(fraction))
          throw new Error("Out-of-scope action");
        if (fraction > 0) {
          const amount = Math.floor(troops * fraction);
          game.addExecution(
            new AttackExecution(amount, player, game.terraNullius().id()),
          );
          actions.push({
            second: tick / 10,
            fraction,
            reserveBefore: troops / 10,
            capacity: capacity / 10,
            amount: amount / 10,
          });
        }
      }
      game.executeNextTick();
      // Mirror consumption by GameRunner so packed deltas do not accumulate.
      game.drainPackedTileUpdates();
      game.drainPackedPlayerUpdates();
      game.drainPackedAttackUpdates();
      landTileSeconds += player.numTilesOwned() / 10;
      ratioSum += player.troops() / config.maxTroops(player);
      if ([100, 300, 600].includes(tick + 1))
        snapshots.push(takeSnapshot((tick + 1) / 10));
    }
    const gaps = actions.slice(1).map((a, i) => a.second - actions[i].second);
    const row = {
      scenario: scenario.name,
      policy: policy.name,
      initial,
      snapshots,
      actions,
      firstSendSeconds: actions[0]?.second ?? null,
      meanSendIntervalSeconds: gaps.length
        ? gaps.reduce((a, b) => a + b, 0) / gaps.length
        : null,
      landTileSeconds: Math.round(landTileSeconds),
      meanReserveFraction: ratioSum / horizon,
    };
    results.push(row);
    const end = snapshots.at(-1)!;
    console.log(
      `${row.scenario.padEnd(20)} ${row.policy.padEnd(25)} land=${String(end.tiles).padStart(6)} reserve=${String(end.reserve).padStart(6)} first=${row.firstSendSeconds} sends=${actions.length}`,
    );
  }
}
const report = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  horizonSeconds: horizon / 10,
  observationsEverySeconds: 1,
  assumptions: [
    "One human; no opponents, buildings, boats, victory checks, or API latency.",
    "Actual Config, SpawnExecution, PlayerExecution and AttackExecution; standard starting troops.",
    "Fixed player/game IDs and spawn per scenario; fresh map/game for every policy.",
    "All reported troop counts are display units (internal / 10).",
    "Synthetic maps and three unopposed Europe locations are economic tests, not multiplayer win-rate evidence.",
  ],
  results,
};
await mkdir("logs", { recursive: true });
const output = smoke ? "logs/opening-smoke.json" : "logs/opening-analysis.json";
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${results.length} runs to ${output}`);
