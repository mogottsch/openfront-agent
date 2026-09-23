// Controlled passive-defender experiment, not Jev gameplay or a win-rate test.
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACK_FRACTIONS } from "../web/observation.js";
const root = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { Config } = await load("src/core/configuration/Config.ts");
const { GameMapImpl } = await load("src/core/game/GameMap.ts");
const { createGame } = await load("src/core/game/GameImpl.ts");
const { AttackExecution } = await load("src/core/execution/AttackExecution.ts");
const { PlayerExecution } = await load("src/core/execution/PlayerExecution.ts");
const {
  PlayerInfo,
  PlayerType,
  GameMapType,
  GameMapSize,
  GameMode,
  GameType,
  Difficulty,
} = await load("src/core/game/Game.ts");
const results = [];
for (const defenderTiles of [500, 10000])
  for (const fraction of ATTACK_FRACTIONS) {
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
    let combatLoss = 0;
    const attackLogic = config.attackLogic.bind(config);
    config.attackLogic = (input: any) => {
      const result = attackLogic(input);
      combatLoss += Math.min(input.attackTroops, result.attackerTroopLoss) / 10;
      return result; // observation only; do not change the engine's result
    };
    const attackerInfo = new PlayerInfo(
      "Attacker",
      PlayerType.Human,
      "attacker",
      "attacker",
    );
    const defenderInfo = new PlayerInfo(
      "Passive tribe",
      PlayerType.Bot,
      null,
      "defender",
    );
    const map = new GameMapImpl(
      256,
      256,
      new Uint8Array(256 * 256).fill(128),
      256 * 256,
    );
    const mini = new GameMapImpl(
      128,
      128,
      new Uint8Array(128 * 128).fill(128),
      128 * 128,
    );
    const game = createGame(
      [attackerInfo, defenderInfo],
      [],
      map,
      mini,
      config,
    );
    game.endSpawnPhase();
    const attacker = game.player("attacker"),
      defender = game.player("defender");
    for (let y = 75; y < 125; y++)
      for (let x = 50; x < 100; x++) attacker.conquer(game.ref(x, y));
    const rect =
      defenderTiles === 500
        ? { x: 100, y: 75, w: 10, h: 50 }
        : { x: 100, y: 50, w: 100, h: 100 };
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++)
        defender.conquer(game.ref(x, y));
    attacker.setSpawnTile(game.ref(75, 100));
    defender.setSpawnTile(game.ref(105, 100));
    attacker.setTroops(200000);
    defender.setTroops(50000); // display: 20k vs 5k
    game.addExecution(
      new PlayerExecution(attacker),
      new PlayerExecution(defender),
    );
    game.addExecution(
      new AttackExecution(
        Math.floor(200000 * fraction),
        attacker,
        defender.id(),
      ),
    );
    let ticks = 0,
      conqueredAt: number | null = null;
    for (; ticks < 600; ) {
      game.executeNextTick();
      ticks++;
      game.drainPackedTileUpdates();
      game.drainPackedPlayerUpdates();
      game.drainPackedAttackUpdates();
      if (!defender.isAlive() && conqueredAt === null) conqueredAt = ticks / 10;
      if (ticks >= 2 && attacker.outgoingAttacks().length === 0) break;
    }
    const committed =
      attacker
        .outgoingAttacks()
        .reduce((sum: number, a: any) => sum + a.troops(), 0) / 10;
    const row = {
      defenderStartTiles: defenderTiles,
      fraction,
      sentTroops: 20000 * fraction,
      computedCombatLoss: Math.round(combatLoss),
      conquered: !defender.isAlive(),
      conqueredAtSeconds: conqueredAt,
      elapsedSeconds: ticks / 10,
      tilesTaken: attacker.numTilesOwned() - 2500,
      defenderTilesLeft: defender.numTilesOwned(),
      attackerReserve: attacker.troops() / 10,
      attackerCommitted: committed,
      defenderReserve: defender.troops() / 10,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
await mkdir("logs", { recursive: true });
await writeFile(
  "logs/combat-analysis.json",
  JSON.stringify(
    {
      engineCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      assumptions: [
        "All plains, no posts/fallout/other players.",
        "Standard real growth for both sides. Passive tribe has no AI/counters.",
        "Attacker: 2500 tiles, 20000 display troops. Defender: 5000 display troops.",
        "One send, no reinforcement, maximum 60 seconds.",
        "Remaining reserves include regeneration; they are not casualty estimates.",
        "computedCombatLoss sums unmodified attackLogic losses, capped at the current attacking stack; small return-rounding losses are excluded.",
        "Prepared game state, not a natural opening or a live Jev run.",
      ],
      results,
    },
    null,
    2,
  ) + "\n",
);
