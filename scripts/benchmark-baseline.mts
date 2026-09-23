// Paired headless matches against OpenFront's native Impossible nation AI.
// This is an offline deterministic-control benchmark, never a Jev controller.
// Run with the sibling checkout's tsx, as in scripts/analyze-opening.mts.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { GameRunner } = await load("src/core/GameRunner.ts");
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { createNationsForGame } = await load("src/core/game/NationCreation.ts");
const { PseudoRandom } = await load("src/core/PseudoRandom.ts");
const { simpleHash } = await load("src/core/Util.ts");
const { GameMapType, GameMapSize, GameMode, GameType, Difficulty, PlayerType, PlayerInfo } =
  await load("src/core/game/Game.ts");
const { GameUpdateType } = await load("src/core/game/GameUpdates.ts");
// TerrainMapLoader caches *mutable* map instances by map/size. Build fresh
// maps from the production binary on each paired run instead of reusing it.
const mapDir = resolve(root, "resources/maps/onion");
const manifest = JSON.parse(await readFile(resolve(mapDir, "manifest.json"), "utf8"));
const mainBin = await readFile(resolve(mapDir, "map.bin"));
const miniBin = await readFile(resolve(mapDir, "map4x.bin"));
function freshMap(metadata: any, data: Uint8Array) {
  if (data.length !== metadata.width * metadata.height) throw new Error("invalid map binary dimensions");
  return new GameMapImpl(metadata.width, metadata.height, new Uint8Array(data), metadata.num_land_tiles);
}

const policies = ["fixed20-wilderness", "fixed50-land"] as const;
type Policy = (typeof policies)[number];
type Options = {
  smoke: boolean;
  seeds: string[];
  minutes: number;
  maxTicks: number;
  spawn: [number, number];
  output: string;
};

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

function parseArgs(args: string[]): Options {
  let smoke = false;
  let seeds: string[] | undefined;
  let minutes = 5;
  let maxTicks: number | undefined;
  let spawn: [number, number] = [400, 280];
  let output = "logs/benchmark-baseline.json";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = () => {
      if (!args[i + 1]) throw new Error(`missing value for ${flag}`);
      return args[++i];
    };
    switch (flag) {
      case "--smoke":
        smoke = true;
        break;
      case "--seeds":
        seeds = next().split(",");
        if (
          !seeds.length ||
          new Set(seeds).size !== seeds.length ||
          seeds.some((s) => !/^[A-Za-z0-9_-]{1,64}$/.test(s))
        ) {
          throw new Error("--seeds requires distinct alphanumeric/hyphen/underscore IDs");
        }
        break;
      case "--minutes":
        minutes = positiveInt(next(), flag);
        if (minutes > 120) throw new Error("--minutes must be <= 120");
        break;
      case "--max-ticks":
        maxTicks = positiveInt(next(), flag);
        break;
      case "--spawn": {
        const parts = next().split(",");
        if (parts.length !== 2 || parts.some((p) => !/^\d+$/.test(p))) {
          throw new Error("--spawn must be x,y with nonnegative integer coordinates");
        }
        spawn = [Number(parts[0]), Number(parts[1])];
        break;
      }
      case "--output":
        output = next();
        if (!output.endsWith(".json")) throw new Error("--output must end in .json");
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return {
    smoke,
    seeds: seeds ?? (smoke ? ["bench-001"] : ["bench-001", "bench-002", "bench-003"]),
    minutes,
    // Timed WinCheck fires every 10 ticks. Extra ticks give it margin while
    // still bounding a hung run. Smoke intentionally stops *before* a win.
    maxTicks: maxTicks ?? (smoke ? 70 : minutes * 600 + 50),
    spawn,
    output,
  };
}

// Only the deterministic control uses this policy. It reads own troops and
// legal border contacts; no model request, boats, structures, diplomacy, etc.
function chooseTarget(game: any, human: any, policy: Policy): any | null {
  const wilderness = game.terraNullius();
  if (policy === "fixed20-wilderness") {
    return human.sharesBorderWith(wilderness) ? wilderness : null;
  }
  const neighbors = game.players()
    .filter((p: any) => p !== human && human.sharesBorderWith(p) && human.canAttackPlayer(p))
    .sort((a: any, b: any) => a.troops() - b.troops() || a.id().localeCompare(b.id()));
  return neighbors[0] ?? (human.sharesBorderWith(wilderness) ? wilderness : null);
}

async function run(seed: string, policy: Policy, opts: Options) {
  const clientID = "benchmark-human";
  const gameStart = {
    gameID: seed,
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.Onion,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Impossible,
      nations: "default" as const,
      bots: 0,
      donateGold: false,
      donateTroops: false,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
      maxTimerValue: opts.minutes,
    },
    players: [{ username: "Benchmark", clientID }],
  };
  // Mirrors createGameRunner's seeded roster and Executor/GameRunner path,
  // except its shared mutable TerrainMapLoader cache cannot isolate pairs.
  const random = new PseudoRandom(simpleHash(seed));
  const humans = [new PlayerInfo("Benchmark", PlayerType.Human, clientID, random.nextID())];
  const nationsForGame = createNationsForGame(
    gameStart, manifest.nations, manifest.additionalNations ?? [], humans.length, random,
  );
  const game = createGame(
    humans, nationsForGame, freshMap(manifest.map, mainBin),
    freshMap(manifest.map4x, miniBin), new Config(gameStart.config, null, false),
    manifest.teamGameSpawnAreas,
  );
  let winUpdates = 0;
  let lastWinner: any = null;
  let fatal: string | null = null;
  const runner = new GameRunner(game, new Executor(game, seed, clientID), (update: any) => {
    if ("errMsg" in update) {
      fatal = `${update.errMsg}\n${update.stack ?? ""}`;
      return;
    }
    for (const win of update.updates[GameUpdateType.Win]) {
      winUpdates++;
      lastWinner = win.winner ?? null;
    }
  });
  runner.init();
  const [x, y] = opts.spawn;
  if (!game.isValidCoord(x, y)) throw new Error(`invalid spawn (${x},${y}): outside map`);
  const spawnRef = game.ref(x, y);
  if (!game.isLand(spawnRef) || game.isImpassable(spawnRef)) {
    throw new Error(`invalid spawn (${x},${y}): not passable land`);
  }
  const human = game.playerByClientID(clientID);
  if (!human) throw new Error("human missing from game roster");
  const nations = game.allPlayers().filter((p: any) => p.type() === PlayerType.Nation);
  if (!nations.length) throw new Error("no native nations created");
  let turnNumber = 0;
  function step(intents: any[] = []) {
    runner.addTurn({ turnNumber: turnNumber++, intents });
    if (!runner.executeNextTick() || fatal !== null) {
      throw new Error(`engine failed at turn ${turnNumber}: ${fatal ?? "runner rejected turn"}`);
    }
  }
  step([{ type: "spawn", clientID, tile: spawnRef }]);
  for (let i = 0; game.inSpawnPhase() && i < 100; i++) step();
  if (game.inSpawnPhase() || !human.hasSpawned()) {
    throw new Error(`human spawn phase did not end: ${seed}`);
  }
  // NationExecution queues its SpawnExecution during the spawn phase. Check
  // after a few live ticks, rather than silently accepting missing opponents.
  for (let i = 0; i < 4 && nations.some((p: any) => !p.hasSpawned()); i++) step();
  if (nations.some((p: any) => !p.hasSpawned())) {
    throw new Error(`native nation failed to spawn: ${seed}`);
  }
  const actualSpawn = [game.x(human.spawnTile()), game.y(human.spawnTile())];
  if (actualSpawn[0] !== x || actualSpawn[1] !== y) {
    throw new Error(`human spawned at ${actualSpawn}, requested ${opts.spawn}`);
  }
  const opponentSpawns = nations.map((p: any) => ({
    name: p.name(), id: p.id(),
    x: game.x(p.spawnTile()), y: game.y(p.spawnTile()),
  }));
  const actions = { submitted: 0, wilderness: 0, nation: 0, troopsSubmitted: 0 };
  const snapshots: any[] = [];
  let lastDecisionSecond = -1;
  // maxTicks counts live gameplay ticks, excluding setup/spawn turns.
  for (let i = 0; i < opts.maxTicks && winUpdates === 0; i++) {
    const second = Math.floor(game.elapsedGameSeconds());
    const intents: any[] = [];
    if (human.isAlive() && !game.inSpawnPhase() && second !== lastDecisionSecond) {
      lastDecisionSecond = second;
      const target = chooseTarget(game, human, policy);
      if (target && human.troops() > 0) {
        const fraction = policy === "fixed20-wilderness" ? 0.2 : 0.5;
        const troops = Math.floor(human.troops() * fraction);
        if (troops > 0) {
          intents.push({ type: "attack", clientID, targetID: target.id(), troops });
          actions.submitted++;
          actions.troopsSubmitted += troops;
          if (target === game.terraNullius()) actions.wilderness++;
          else actions.nation++;
        }
      }
    }
    step(intents);
    const elapsed = game.elapsedGameSeconds();
    if (Math.round(elapsed * 10) % 300 === 0) {
      snapshots.push({
        seconds: elapsed,
        tiles: human.numTilesOwned(),
        troops: human.troops(),
        alive: human.isAlive(),
      });
    }
  }
  if (winUpdates > 1) throw new Error(`duplicate engine Win updates: ${seed}/${policy}`);
  const winner = game.getWinner();
  if (winUpdates === 1 && winner === null) {
    throw new Error(`engine Win update had no winner: ${seed}/${policy}`);
  }
  const completed = winUpdates === 1;
  const elapsedSeconds = game.elapsedGameSeconds();
  const threshold = game.config().percentageTilesOwnedToWin(elapsedSeconds);
  const winnerShare = completed
    ? winner.numTilesOwned() / (game.numLandTiles() - game.numTilesWithFallout())
    : null;
  const winRule = !completed ? null : elapsedSeconds >= opts.minutes * 60
    ? "timer-leader" : "land-share";
  if (completed && winRule === "land-share" && winnerShare * 100 <= threshold) {
    throw new Error(`unexpected early engine Win: ${seed}/${policy}`);
  }
  const top = [...game.allPlayers()].sort(
    (a: any, b: any) => b.numTilesOwned() - a.numTilesOwned() || a.id().localeCompare(b.id()),
  );
  return {
    seed, policy, spawn: { x, y }, opponentSpawns,
    completed,
    status: completed ? "engine-win" : "censored-tick-cap",
    win: completed ? winner === human : null,
    winRule,
    winnerShare,
    winner: completed ? {
      type: winner.type(), name: winner.name(), id: winner.id(),
      wire: lastWinner,
    } : null,
    elapsedSeconds,
    ticks: game.ticks(),
    finalHash: game.hash(),
    human: {
      alive: human.isAlive(), tiles: human.numTilesOwned(),
      share: human.numTilesOwned() / game.numLandTiles(),
      troops: human.troops(),
    },
    standings: top.map((p: any) => ({
      id: p.id(), name: p.name(), type: p.type(),
      tiles: p.numTilesOwned(), alive: p.isAlive(),
    })),
    actions, snapshots,
  };
}

const opts = parseArgs(process.argv.slice(2));
console.debug = () => {}; // upstream emits per-tick debug lines
const engineCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const results: any[] = [];
for (const seed of opts.seeds) {
  for (const policy of policies) {
    const row = await run(seed, policy, opts);
    results.push(row);
    console.log(`${seed} ${policy}: ${row.status} winner=${row.winner?.name ?? "none"} ` +
      `time=${row.elapsedSeconds.toFixed(1)}s humanTiles=${row.human.tiles} ` +
      `intents=${row.actions.submitted} hash=${row.finalHash}`);
  }
}
const pairs = opts.seeds.map((seed) => {
  const baseline = results.find((r) => r.seed === seed && r.policy === policies[0]);
  const challenger = results.find((r) => r.seed === seed && r.policy === policies[1]);
  if (JSON.stringify(baseline.opponentSpawns) !== JSON.stringify(challenger.opponentSpawns)) {
    throw new Error(`unpaired native opponents/spawns for ${seed}`);
  }
  return {
    seed,
    completed: baseline.completed && challenger.completed,
    baselineWin: baseline.win,
    challengerWin: challenger.win,
    humanTileDelta: challenger.human.tiles - baseline.human.tiles,
  };
});
const completedPairs = pairs.filter((p) => p.completed);
const report = {
  schemaVersion: 1,
  engineCommit,
  map: "Onion",
  config: { difficulty: "Impossible", nationCount: results[0].opponentSpawns.length,
    gameType: "Singleplayer", gameMode: "FFA", timerMinutes: opts.minutes,
    spawn: { x: opts.spawn[0], y: opts.spawn[1] }, maxLiveTicks: opts.maxTicks },
  policies: {
    "fixed20-wilderness": "Every game second, 20% of available troops to bordering wilderness; otherwise wait.",
    "fixed50-land": "Every game second, 50% to weakest legal bordering nation by troops (ID tie-break); else bordering wilderness; otherwise wait.",
  },
  results, pairs,
  summary: {
    completedPairs: completedPairs.length,
    totalPairs: pairs.length,
    // Never count censored matches as wins or losses.
    baselineWins: completedPairs.filter((p) => p.baselineWin === true).length,
    challengerWins: completedPairs.filter((p) => p.challengerWin === true).length,
  },
};
await mkdir(dirname(resolve(opts.output)), { recursive: true });
await writeFile(opts.output, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${results.length} runs (${completedPairs.length} completed pairs) to ${opts.output}`);
if (!opts.smoke && completedPairs.length !== pairs.length) {
  console.error("Incomplete matches: no win-rate inference; raise --max-ticks or inspect the engine.");
  process.exitCode = 2;
}
