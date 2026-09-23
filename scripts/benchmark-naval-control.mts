// Deterministic offline boat-enabled control vs native Impossible Onion nations.
// No Jev/Copilot/sidecar calls, no edits to the sibling engine checkout.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runBenchmarkMatch, type Options } from "./benchmark-baseline.mts";

const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { createNationsForGame } = await load("src/core/game/NationCreation.ts");
const { GameUpdateType } = await load("src/core/game/GameUpdates.ts");
const { targetTransportTile } = await load("src/core/game/TransportShipUtils.ts");
const { PseudoRandom } = await load("src/core/PseudoRandom.ts");
const { simpleHash } = await load("src/core/Util.ts");
const { PlayerInfo, PlayerType, GameMapType, GameMapSize, GameMode, GameType,
  Difficulty, UnitType } = await load("src/core/game/Game.ts");
const dir = resolve(root, "resources/maps/onion");
const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
const main = await readFile(resolve(dir, "map.bin"));
const mini = await readFile(resolve(dir, "map4x.bin"));
const fresh = (metadata: any, bytes: Uint8Array) => {
  if (bytes.length !== metadata.width * metadata.height) throw new Error("Bad Onion map binary");
  return new GameMapImpl(metadata.width, metadata.height, new Uint8Array(bytes), metadata.num_land_tiles);
};
const boatFractions = [0.1, 0.2, 0.3] as const; // wilderness only; not the tribe action menu
const coast: [number, number][] = [
  [423, 276], [426, 280], [435, 300], [440, 320],
  [443, 340], [443, 360], [439, 380], [432, 400],
]; // small deterministic outer-ring sample; not exhaustive site selection
const cli = (() => {
  let seeds = ["bench-001", "bench-002", "bench-003"];
  let smoke = false;
  let output = "logs/benchmark-naval-control.json";
  for (let i = 0; i < process.argv.slice(2).length; i++) {
    const arg = process.argv.slice(2)[i];
    if (arg === "--smoke") { smoke = true; continue; }
    if (!["--seeds", "--output"].includes(arg)) throw new Error(`Unknown option ${arg}`);
    const value = process.argv.slice(2)[++i];
    if (!value) throw new Error(`Missing ${arg}`);
    if (arg === "--seeds") {
      seeds = value.split(",");
      if (!seeds.length || new Set(seeds).size !== seeds.length ||
          seeds.some((s) => !/^[A-Za-z0-9_-]{1,64}$/.test(s)))
        throw new Error("Invalid or duplicate seeds");
    } else { output = value; if (!output.endsWith(".json")) throw new Error("Output must be .json"); }
  }
  if (smoke && !process.argv.includes("--seeds")) seeds = ["bench-001"];
  return { seeds, smoke, output };
})();
console.debug = () => {};
const opts: Options = { smoke: cli.smoke, seeds: cli.seeds, minutes: 5,
  maxTicks: cli.smoke ? 650 : 3050, spawn: [400, 280], output: cli.output };

async function runNaval(seed: string, boatFraction: number) {
  if (!boatFractions.includes(boatFraction as any)) throw new Error("Invalid boat payload fraction");
  const clientID = "benchmark-human";
  const gameStart = {
    gameID: seed, lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.Onion, gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA, gameType: GameType.Singleplayer,
      difficulty: Difficulty.Impossible, nations: "default" as const, bots: 0,
      donateGold: false, donateTroops: false, infiniteGold: false,
      infiniteTroops: false, instantBuild: false, randomSpawn: false,
      maxTimerValue: opts.minutes,
    },
    players: [{ username: "Benchmark", clientID }],
  };
  const random = new PseudoRandom(simpleHash(seed));
  const humanInfo = new PlayerInfo("Benchmark", PlayerType.Human, clientID, random.nextID());
  const nations = createNationsForGame(gameStart, manifest.nations,
    manifest.additionalNations ?? [], 1, random);
  const game = createGame([humanInfo], nations, fresh(manifest.map, main),
    fresh(manifest.map4x, mini), new Config(gameStart.config, null, false),
    manifest.teamGameSpawnAreas);
  let fatal: string | null = null;
  let winUpdates = 0;
  let wireWinner: any = null;
  const runner = new GameRunner(game, new Executor(game, seed, clientID), (u: any) => {
    if ("errMsg" in u) { fatal = u.errMsg; return; }
    for (const update of u.updates[GameUpdateType.Win]) {
      winUpdates++;
      wireWinner = update.winner ?? null;
    }
  });
  runner.init();
  const human = game.playerByClientID(clientID);
  if (!human) throw new Error("Human missing");
  let turnNumber = 0;
  function step(intents: any[] = []) {
    runner.addTurn({ turnNumber: turnNumber++, intents });
    if (!runner.executeNextTick() || fatal) throw new Error(`Engine failed: ${fatal}`);
  }
  step([{ type: "spawn", clientID, tile: game.ref(400, 280) }]);
  for (let i = 0; game.inSpawnPhase() && i < 100; i++) step();
  if (game.inSpawnPhase() || !human.hasSpawned()) throw new Error("Human spawn failed");
  const opponents = game.allPlayers().filter((p: any) => p.type() === PlayerType.Nation);
  for (let i = 0; i < 4 && opponents.some((p: any) => !p.hasSpawned()); i++) step();
  if (opponents.length !== 3 || opponents.some((p: any) => !p.hasSpawned()))
    throw new Error("Native Impossible opponents did not spawn");
  const opponentSpawns = opponents.map((p: any) => ({ name: p.name(), id: p.id(),
    x: game.x(p.spawnTile()), y: game.y(p.spawnTile()) }));
  const boats: any[] = [];
  const snapshots: any[] = [];
  let landIntents = 0;
  let candidateChecks = 0;
  let lastCoastProbe = -Infinity;
  let lastBoatSecond = -Infinity;
  let islandFullSecond: number | null = null;
  let lastDecisionSecond = -1;
  let liveTicks = 0;
  function selectCoast() {
    const checked = [];
    for (const [x, y] of coast) {
      const tile = game.ref(x, y);
      // Hold target class constant across the sweep. Never offer a tribe or
      // nation here; the tribe <=20% rule is unrelated to wilderness boats.
      if (!game.isLand(tile) || game.isImpassable(tile) || game.ownerID(tile) !== 0)
        continue;
      // Match the worker's actual playerBuildables and core canBuild result.
      const source = human.canBuild(UnitType.TransportShip, tile);
      const worker = runner.playerBuildables(human.id(), x, y, [UnitType.TransportShip])[0];
      if (worker.canBuild !== source) throw new Error(`Worker/core boat legality mismatch at ${x},${y}`);
      candidateChecks++;
      checked.push({ x, y, owner: game.owner(tile).id(), canBuild: source !== false });
      if (source !== false) {
        const landing = targetTransportTile(game, human, tile);
        if (landing === null || game.ownerID(landing) !== 0)
          throw new Error("Legal wilderness candidate resolved to a non-wilderness shore");
        return { tile, source, landing, checked };
      }
    }
    return { tile: null, source: null, landing: null, checked };
  }
  for (let i = 0; i < opts.maxTicks && winUpdates === 0; i++) {
    const second = Math.floor(game.elapsedGameSeconds());
    const intents: any[] = [];
    let launch: any = null;
    if (human.isAlive() && second !== lastDecisionSecond) {
      lastDecisionSecond = second;
      if (human.numTilesOwned() >= 6505 && islandFullSecond === null)
        islandFullSecond = second;
      // Identical fixed-20 wilderness control on available land. No scripted
      // replacement for any model action: both policies here are offline.
      if (human.sharesBorderWith(game.terraNullius())) {
        const troops = Math.floor(human.troops() * 0.2);
        if (troops > 0) {
          intents.push({ type: "attack", clientID, targetID: null, troops });
          landIntents++;
        }
      }
      // One/two fixed-fraction boat sends after land expansion reaches its
      // island edge. Fractions are compared across fresh paired games; each
      // preserves at least 70% of then-available troops before other intents.
      // The second is spaced >=20 simulated seconds.
      if (islandFullSecond !== null && boats.length < 2 &&
          second - lastBoatSecond >= 20 && second - lastCoastProbe >= 5 &&
          human.unitCount(UnitType.TransportShip) < game.config().boatMaxNumber()) {
        lastCoastProbe = second;
        const candidate = selectCoast();
        if (candidate.tile !== null && human.troops() >= 10) {
          const troops = Math.floor(human.troops() * boatFraction);
          if (troops >= 1) {
            intents.push({ type: "boat", clientID, dst: candidate.tile, troops });
            launch = { second, requested: candidate.tile, source: candidate.source,
              landing: candidate.landing, troops, checked: candidate.checked,
              reserveBefore: human.troops(), capacity: game.config().maxTroops(human) };
            lastBoatSecond = second;
          }
        }
      }
    }
    step(intents);
    liveTicks++;
    if (launch !== null) {
      const unit = human.units(UnitType.TransportShip).find((u: any) =>
        u.isActive() && u.tile() === launch.source && u.targetTile() === launch.landing &&
        !boats.some((b) => b.unitID === u.id()));
      boats.push({
        ...launch,
        unitID: unit?.id() ?? null,
        launched: Boolean(unit),
        actualBoatTroops: unit?.troops() ?? null,
        launchedTick: game.ticks(),
        landedTick: null,
        unit,
      });
    }
    for (const b of boats) {
      if (b.landedTick === null && game.ownerID(b.landing) === human.smallID())
        b.landedTick = game.ticks();
    }
    if (Math.round(game.elapsedGameSeconds() * 10) % 300 === 0)
      snapshots.push({ seconds: game.elapsedGameSeconds(), tiles: human.numTilesOwned(),
        troops: human.troops(), boatsActive: human.unitCount(UnitType.TransportShip) });
  }
  if (winUpdates > 1) throw new Error("Duplicate Win updates");
  const winner = game.getWinner();
  if (winUpdates === 1 && winner === null) throw new Error("Winnerless engine Win");
  const completed = winUpdates === 1;
  return {
    seed, policy: `fixed20-plus-two-${boatFraction * 100}pct-wilderness-boats`,
    boatFraction, opponentSpawns,
    completed, status: completed ? "engine-win" : "censored-tick-cap",
    win: completed ? winner === human : null,
    winner: completed ? { id: winner.id(), name: winner.name(), wire: wireWinner } : null,
    winRule: completed ? game.elapsedGameSeconds() >= opts.minutes * 60
      ? "timer-leader" : "land-share" : null,
    elapsedSeconds: game.elapsedGameSeconds(), liveTicks, finalHash: game.hash(),
    human: { alive: human.isAlive(), tiles: human.numTilesOwned(),
      troops: human.troops(), gold: human.gold().toString() },
    islandFullSecond, landIntents, candidateChecks, snapshots,
    boats: boats.map(({ unit, requested, source, landing, ...b }) => ({
      ...b,
      requested: { x: game.x(requested), y: game.y(requested) },
      source: { x: game.x(source), y: game.y(source) },
      landing: { x: game.x(landing), y: game.y(landing) },
      boatActiveAtEnd: unit?.isActive() ?? false,
      landingOwnedAtEnd: game.ownerID(landing) === human.smallID(),
    })),
    standings: game.allPlayers().map((p: any) => ({ id: p.id(), name: p.name(),
      type: p.type(), tiles: p.numTilesOwned(), troops: p.troops(),
      gold: p.gold().toString(), alive: p.isAlive(),
      cities: p.unitCount(UnitType.City), ports: p.unitCount(UnitType.Port) })),
  };
}

const baselines: any[] = [];
const pairs: any[] = [];
for (const seed of opts.seeds) {
  const baseline = await runBenchmarkMatch(seed, "fixed20-wilderness", opts);
  baselines.push(baseline);
  for (const boatFraction of boatFractions) {
    const naval = await runNaval(seed, boatFraction);
    if (JSON.stringify(baseline.opponentSpawns) !== JSON.stringify(naval.opponentSpawns))
      throw new Error(`Unpaired nation IDs/spawns: ${seed}/${boatFraction}`);
    pairs.push({ seed, boatFraction, naval,
      completed: baseline.completed && naval.completed,
      baselineWin: baseline.win, navalWin: naval.win,
      humanTileDelta: naval.human.tiles - baseline.human.tiles });
    console.log(`${seed} boat=${boatFraction * 100}%: ` +
      `baseline=${baseline.status}/${baseline.winner?.name ?? "none"} ` +
      `naval=${naval.status}/${naval.winner?.name ?? "none"} ` +
      `boats=${naval.boats.length} landed=${naval.boats.filter((b: any) => b.landedTick !== null).length} ` +
      `tiles=${baseline.human.tiles}->${naval.human.tiles}`);
  }
}
const completePairs = pairs.filter((p) => p.completed);
const report = {
  schemaVersion: 2,
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  map: "Onion", difficulty: "Impossible", seedCount: opts.seeds.length,
  timerMinutes: opts.minutes, maxLiveTicks: opts.maxTicks,
  candidateCoastSample: coast,
  boatFractions,
  controls: {
    baseline: "Fixed 20% wilderness every game second, as in scripts/benchmark-baseline.mts",
    naval: "Same land control; after full starting island, up to two fixed-fraction transport intents only to worker-legal unowned outer-ring coast, >=20s apart; retries candidate scan every >=5s. Compare 10/20/30% of available troops. Not a model policy.",
  },
  baselines, pairs,
  summary: {
    completedPairs: completePairs.length, totalPairs: pairs.length,
    baselineWins: baselines.filter((b) => b.completed && b.win === true).length,
    byBoatPercent: Object.fromEntries(boatFractions.map((fraction) => {
      const group = pairs.filter((p) => p.boatFraction === fraction);
      const complete = group.filter((p) => p.completed);
      return [String(fraction * 100), {
        completedPairs: complete.length, totalPairs: group.length,
        navalWins: complete.filter((p) => p.navalWin === true).length,
        launches: group.reduce((sum, p) => sum + p.naval.boats.filter((b: any) => b.launched).length, 0),
        landfalls: group.reduce((sum, p) => sum + p.naval.boats.filter((b: any) => b.landedTick !== null).length, 0),
        endOwnedLandingTiles: group.reduce((sum, p) => sum + p.naval.boats.filter((b: any) => b.landingOwnedAtEnd).length, 0),
      }];
    })),
  },
};
await mkdir(dirname(resolve(cli.output)), { recursive: true });
await writeFile(cli.output, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${pairs.length} seed/fraction pairs across ${opts.seeds.length} seeds to ${cli.output}`);
if (!cli.smoke && completePairs.length !== pairs.length) process.exitCode = 2;
