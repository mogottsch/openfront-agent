// Offline headless Europe/Compact native Easy nations + tribes, explicit mock
// focus policy. No browser/controller/TypeSafe/Copilot call or upstream edit.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { Executor } = await load("src/core/execution/ExecutionManager.ts");
const { GameRunner } = await load("src/core/GameRunner.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { createNationsForGame } = await load("src/core/game/NationCreation.ts");
const { GameUpdateType } = await load("src/core/game/GameUpdates.ts");
const { PseudoRandom } = await load("src/core/PseudoRandom.ts");
const { simpleHash } = await load("src/core/Util.ts");
const { PlayerInfo, PlayerType, GameMapType, GameMapSize,
  GameMode, GameType, Difficulty } = await load("src/core/game/Game.ts");
const dir = resolve(root, "resources/maps/europe");
const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
const main = await readFile(resolve(dir, "map4x.bin"));
const mini = await readFile(resolve(dir, "map16x.bin"));
const fresh = (meta: any, data: Uint8Array) => {
  if (data.length !== meta.width * meta.height) throw new Error("Invalid Europe map binary");
  return new GameMapImpl(meta.width, meta.height, new Uint8Array(data), meta.num_land_tiles);
};
// Nearby manifest nations, intentionally fixed rather than cherry-picked
// per seed. Native NationExecution/AI still plays their actual game.
const nationNames = ["England", "Spain", "Switzerland"];
const nationManifest = nationNames.map((name) => {
  const original = manifest.nations.find((n: any) => n.name === name);
  if (!original?.coordinates) throw new Error(`Missing Europe nation: ${name}`);
  return { ...original, coordinates: original.coordinates.map((n: number) => Math.floor(n / 2)) };
});
const humanSpawn = [543, 491] as const; // production Europe Compact, France land
const argv = process.argv.slice(2);
let seed = "europe-focus-001", minutes = 5, maxLiveTicks = 3050,
  smoke = false, nationProbe = false,
  output = "logs/benchmark-europe-tribes.json";
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--smoke") { smoke = true; maxLiveTicks = 600; continue; }
  if (arg === "--nation-probe") { nationProbe = true; continue; }
  const value = argv[++i];
  if (!value) throw new Error(`Missing ${arg}`);
  if (arg === "--seed") {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("Invalid seed");
    seed = value;
  } else if (arg === "--output") {
    if (!value.endsWith(".json")) throw new Error("Output must be JSON");
    output = value;
  } else if (arg === "--minutes") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new Error("Invalid timer minutes");
    minutes = n;
    if (!smoke) maxLiveTicks = minutes * 600 + 50;
  } else throw new Error(`Unknown argument ${arg}`);
}
console.debug = () => {};
const setupConfig = {
  gameMap: GameMapType.Europe, gameMapSize: GameMapSize.Compact,
  gameMode: GameMode.FFA, gameType: GameType.Singleplayer,
  difficulty: Difficulty.Easy, nations: 3, bots: 12,
  donateGold: false, donateTroops: false, infiniteGold: false,
  infiniteTroops: false, instantBuild: false, randomSpawn: false,
  maxTimerValue: minutes,
};

type Mode = "fixed20-wilderness" | "mock-one-tribe-at-a-time" | "mock-tribes-then-one-nation-poke";
async function run(mode: Mode) {
  const config = new Config(setupConfig, null, false);
  const gameStart = { gameID: seed, lobbyCreatedAt: 0,
    config: setupConfig, players: [{ username: "Bench", clientID: "human-client" }] };
  const random = new PseudoRandom(simpleHash(seed));
  const info = new PlayerInfo("Bench", PlayerType.Human, "human-client", random.nextID());
  const nations = createNationsForGame(gameStart, nationManifest, [], 1, random);
  const game = createGame([info], nations, fresh(manifest.map4x, main),
    fresh(manifest.map16x, mini), config);
  if (!game.isValidCoord(...humanSpawn) ||
      !game.isLand(game.ref(...humanSpawn)) ||
      game.isImpassable(game.ref(...humanSpawn))) throw new Error("Invalid Compact human spawn");
  let fatal: string | null = null;
  let wireWinner: any = null;
  let winEvents = 0;
  const conquests: any[] = [];
  const runner = new GameRunner(game, new Executor(game, seed, "human-client"), (u: any) => {
    if ("errMsg" in u) { fatal = u.errMsg; return; }
    for (const e of u.updates[GameUpdateType.ConquestEvent])
      conquests.push({ tick: u.tick, conquerorId: e.conquerorId,
        conqueredId: e.conqueredId, gold: e.gold.toString() });
    for (const e of u.updates[GameUpdateType.Win]) {
      winEvents++; wireWinner = e.winner ?? null;
    }
  });
  runner.init();
  const human = game.player(info.id);
  let turnNumber = 0;
  const step = (intents: any[] = []) => {
    runner.addTurn({ turnNumber: turnNumber++, intents });
    if (!runner.executeNextTick() || fatal) throw new Error(`Engine tick failed: ${fatal}`);
  };
  step([{ type: "spawn", clientID: "human-client", tile: game.ref(...humanSpawn) }]);
  for (let i = 0; i < 10 && game.inSpawnPhase(); i++) step();
  if (game.inSpawnPhase() || !human.hasSpawned()) throw new Error("Human spawn failed");
  for (let i = 0; i < 8 && game.allPlayers().filter((p: any) => p.hasSpawned()).length < 16; i++) step();
  const all = game.allPlayers(), tribes = all.filter((p: any) => p.type() === PlayerType.Bot),
    nativeNations = all.filter((p: any) => p.type() === PlayerType.Nation);
  if (tribes.length !== 12 || nativeNations.length !== 3 ||
      [...tribes, ...nativeNations].some((p: any) => !p.hasSpawned()))
    throw new Error("Native tribe/nation spawn roster incomplete");
  const roster = [...tribes, ...nativeNations].map((p: any) => ({
    id: p.id(), smallID: p.smallID(), type: p.type(), name: p.name(),
    spawn: [game.x(p.spawnTile()), game.y(p.spawnTile())] }));
  const snapshots: any[] = [];
  const actions: any[] = [];
  const focusHistory: any[] = [];
  const focusProgress: any[] = [];
  let focus: any = null, focusStartedSecond: number | null = null;
  let focusStalledSeconds = 0, lastDecisionSecond = -1, liveTicks = 0;
  let probe: any = null;
  const nationProbeSnapshots: any[] = [];
  const nationContacts: any[] = [];
  const seenNationContacts = new Set<string>();
  const legalTribals = () => game.players()
    .filter((p: any) => p.type() === PlayerType.Bot &&
      human.sharesBorderWith(p) && human.canAttackPlayer(p))
    .sort((a: any, b: any) => a.smallID() - b.smallID());
  const legalNations = () => game.players()
    .filter((p: any) => p.type() === PlayerType.Nation &&
      human.sharesBorderWith(p) && human.canAttackPlayer(p))
    .sort((a: any, b: any) => a.smallID() - b.smallID());
  for (let i = 0; i < maxLiveTicks && !winEvents; i++) {
    const second = Math.floor(game.elapsedGameSeconds());
    const intents: any[] = [];
    if (human.isAlive() && second !== lastDecisionSecond) {
      lastDecisionSecond = second;
      const borders = legalTribals();
      const nationBorders = legalNations();
      for (const nation of nationBorders) {
        if (!seenNationContacts.has(nation.id())) {
          seenNationContacts.add(nation.id());
          nationContacts.push({ second, nationID: nation.id(),
            nationName: nation.name(), relation: nation.relation(human),
            borderingTribes: borders.map((p: any) => p.id()) });
        }
      }
      if (focus && !focus.isAlive()) {
        focusHistory.push({ atSecond: second, event: "focus-ended", targetID: focus.id(),
          eliminatedBy: conquests.find((c) => c.conqueredId === focus.id())?.conquerorId ?? null,
          conquestGold: conquests.find((c) => c.conqueredId === focus.id())?.gold ?? null });
        focus = null;
        focusStartedSecond = null;
      }
      if (mode !== "fixed20-wilderness" && !focus && borders.length) {
        focus = borders[0]; // deterministic mock choice, not a model
        focusStartedSecond = second;
        focusHistory.push({ atSecond: second, event: "focus-started", targetID: focus.id(),
          gold: focus.gold().toString(), tiles: focus.numTilesOwned() });
      }
      if (focus && focusStartedSecond !== null &&
          (second - focusStartedSecond) % 5 === 0)
        focusProgress.push({ second, targetID: focus.id(), targetTiles: focus.numTilesOwned(),
          targetGold: focus.gold().toString(), humanGold: human.gold().toString(),
          conquestEventsForTarget: conquests.filter((c) => c.conqueredId === focus.id()).length });
      let target: any = null, fraction = 0.2, intentKind = "wait";
      let nationProbeBefore: any = null;
      if (focus) {
        if (human.sharesBorderWith(focus) && human.canAttackPlayer(focus)) {
          target = focus; intentKind = "attack-tribe";
        } else focusStalledSeconds++;
      } else if (mode === "mock-tribes-then-one-nation-poke" && !probe &&
          !borders.length && nationBorders.length) {
        // Explicit negative-control nation poke AFTER no bordering tribe;
        // unlike normal focus control this takes precedence over wilderness
        // once. It is not a recommended whole-conquest decision.
        target = nationBorders[0]; fraction = 0.1; intentKind = "one-nation-probe";
        nationProbeBefore = { targetID: target.id(), atSecond: second,
          relationBefore: target.relation(human),
          targetTilesBefore: target.numTilesOwned(),
          borderingTribesAtIntent: borders.map((p: any) => p.id()) };
      } else if (human.sharesBorderWith(game.terraNullius())) {
        target = game.terraNullius(); intentKind = "attack-wilderness";
      }
      if (target) {
        const troops = Math.floor(human.troops() * fraction);
        if (troops >= 1) {
          intents.push({ type: "attack", clientID: "human-client",
            targetID: target.id(), troops });
          actions.push({ second, kind: intentKind, targetID: target.id(),
            troops, fraction, reserveBefore: human.troops(),
            targetTilesBefore: target.isPlayer() ? target.numTilesOwned() : null });
          if (nationProbeBefore) probe = nationProbeBefore;
        }
      }
    }
    step(intents); liveTicks++;
    if (probe && probe.relationAfterInit === undefined && actions.at(-1)?.kind === "one-nation-probe") {
      const target = game.player(probe.targetID);
      probe.relationAfterInit = target.relation(human);
      probe.embargoAfterInit = target.hasEmbargoAgainst(human);
    }
    if (probe && [1, 10, 30, 60, 120].includes(second - probe.atSecond) &&
        !nationProbeSnapshots.some((s) => s.secondsAfterProbe === second - probe.atSecond)) {
      const target = game.player(probe.targetID);
      const nativeIncoming = human.incomingAttacks()
        .filter((a: any) => a.attacker() === target && !a.retreating());
      nationProbeSnapshots.push({ secondsAfterProbe: second - probe.atSecond,
        relation: target.relation(human), embargo: target.hasEmbargoAgainst(human),
        targetAlive: target.isAlive(), targetTiles: target.numTilesOwned(),
        nativeIncomingAttacks: nativeIncoming.length,
        nativeIncomingTroops: nativeIncoming.reduce((sum: number, a: any) => sum + a.troops(), 0) });
    }
    if (Math.round(game.elapsedGameSeconds() * 10) % 300 === 0)
      snapshots.push({ seconds: game.elapsedGameSeconds(), tiles: human.numTilesOwned(),
        troops: human.troops(), gold: human.gold().toString(),
        focusID: focus?.id() ?? null,
        liveTribes: game.players().filter((p: any) => p.type() === PlayerType.Bot).length,
        borderingTribes: legalTribals().map((p: any) => p.id()) });
  }
  if (winEvents > 1 || (winEvents === 1 && !game.getWinner()))
    throw new Error("Invalid engine Win event");
  const complete = winEvents === 1;
  return { mode, seed, complete, status: complete ? "engine-win" : "censored-tick-cap",
    win: complete ? game.getWinner() === human : null,
    winner: complete ? { id: game.getWinner().id(),
      name: game.getWinner().name(), wire: wireWinner } : null,
    elapsedSeconds: game.elapsedGameSeconds(), liveTicks, finalHash: game.hash(),
    roster, human: { id: human.id(), alive: human.isAlive(), tiles: human.numTilesOwned(),
      troops: human.troops(), gold: human.gold().toString() },
    focusHistory, focusProgress, focusStalledSeconds, nationContacts, probe,
    nationProbeSnapshots, actions,
    conquests, snapshots,
    capturedTribeGold: conquests.filter((e) => e.conquerorId === human.id() &&
      tribes.some((p: any) => p.id() === e.conqueredId))
      .reduce((sum: bigint, e: any) => sum + BigInt(e.gold), 0n).toString() };
}
const modes: Mode[] = ["fixed20-wilderness", "mock-one-tribe-at-a-time",
  ...(nationProbe ? ["mock-tribes-then-one-nation-poke" as const] : [])];
const rows: any[] = [];
for (const mode of modes) {
  const row = await run(mode);
  rows.push(row);
  console.log(`${mode}: ${row.status}, tiles=${row.human.tiles}, ` +
    `tribeKills=${row.conquests.filter((c: any) => c.conquerorId === row.human.id &&
      row.roster.some((p: any) => p.type === PlayerType.Bot && p.id === c.conqueredId)).length}, ` +
    `capturedGold=${row.capturedTribeGold}, nationProbe=${Boolean(row.probe)}`);
}
const roster = JSON.stringify(rows[0].roster);
if (rows.some((r) => JSON.stringify(r.roster) !== roster))
  throw new Error("Unpaired native nation/tribe IDs or spawns across controls");
const completed = rows.every((r) => r.complete);
const report = {
  engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  noModelCalls: true, map: "Europe", mapSize: "Compact", difficulty: "Easy",
  fixedNations: nationNames, bots: 12, seed, humanSpawn, timerMinutes: minutes,
  maxLiveTicks, smoke, nationProbe, rows,
  assumptions: [
    "Fresh production Europe map4x/map16x per control, 12 random native TribeSpawner bots, three fixed nearby manifest Nation names with native Easy AI; same seed/roster/spawns asserted.",
    "Every control is an explicit deterministic mock, NOT Jev or the deployed bot strategy; focus is lowest smallID legal bordering tribe, held until eliminated even if another tribe borders.",
    "No nation attack in the default arms; optional --nation-probe is an explicitly disclosed one-off 10% partial attack ONLY after no bordering tribes, not a recommended conquest policy.",
    "A captured-gold event credits the killer on elimination below 100 tiles; normal worker gold and partial territorial attrition are separate.",
    "No boats, Cities, diplomacy or attack cancellation from the human controls; native Easy nations and tribes keep their real behavior.",
  ],
  summary: { completed,
    humanWins: Object.fromEntries(rows.map((r) => [r.mode, r.win])),
    humanTribeCaptureGold: Object.fromEntries(rows.map((r) => [r.mode, r.capturedTribeGold])) },
};
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${rows.length} paired controls to ignored ${output}`);
if (!smoke && !completed) process.exitCode = 2;
