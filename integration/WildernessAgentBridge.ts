// Local experimental bridge owned by ../openfront-agent; not upstream game logic.
import { EventBus } from "../core/EventBus";
import { GameType } from "../core/game/Game";
import { GameUpdateType } from "../core/game/GameUpdates";
import { SendAttackIntentEvent } from "./Transport";
import { GameView } from "./view/GameView";

export function attachWildernessAgent(
  game: GameView,
  events: EventBus,
): () => void {
  if (
    process.env.GAME_ENV !== "dev" ||
    process.env.NODE_ENV === "test" ||
    typeof window === "undefined" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ||
    game.config().gameConfig().gameType !== GameType.Singleplayer ||
    game.config().isReplay()
  )
    return () => {};

  let disposed = false;
  let cleanup: (() => void) | undefined;
  const read = () => {
    const player = game.myPlayer();
    const paused =
      game
        .updatesSinceLastTick()
        ?.[GameUpdateType.GamePaused]?.some((u) => u.paused) ?? false;
    return {
      tick: game.ticks(),
      troops: Math.floor((player?.troops() ?? 0) / 10),
      ready:
        !disposed &&
        !paused &&
        !game.isCatchingUp() &&
        !game.inSpawnPhase() &&
        !!player?.isAlive() &&
        !!player?.hasSpawned(),
      ended:
        disposed ||
        game.gameOver() ||
        (!!player?.hasSpawned() && !player.isAlive()),
    };
  };
  const canExpand = async () => {
    const player = game.myPlayer();
    if (!read().ready || !player) return false;
    const { borderTiles } = await player.borderTiles();
    if (disposed || !read().ready) return false;
    for (const border of borderTiles) {
      if (game.ownerID(border) !== player.smallID()) continue;
      for (const tile of game.neighbors(border)) {
        if (
          game.isLand(tile) &&
          !game.isImpassable(tile) &&
          !game.hasOwner(tile)
        )
          return true;
      }
    }
    return false;
  };
  const attack = (fraction: number) => {
    if (![0.1, 0.2].includes(fraction) || !read().ready) return false;
    const troops = Math.floor(game.myPlayer()!.troops() * fraction);
    if (troops < 1) return false;
    // null is the normal wilderness target. Never mutate the simulation directly.
    events.emit(new SendAttackIntentEvent(null, troops));
    return true;
  };

  const url = "http://127.0.0.1:8788/agent.js";
  void import(/* @vite-ignore */ url)
    .then((module) => {
      if (!disposed) cleanup = module.mount({ read, canExpand, attack });
    })
    .catch(() => {
      if (!disposed)
        console.info(
          "Jev panel unavailable. Start ../openfront-agent with npm start, then start a new solo match.",
        );
    });
  return () => {
    disposed = true;
    cleanup?.();
  };
}
