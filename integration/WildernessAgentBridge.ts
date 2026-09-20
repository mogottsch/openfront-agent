// Local experimental bridge owned by ../openfront-agent; not upstream game logic.
// Filename retained so existing installs can be upgraded in place.
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
  const sendAttack = (targetID: string | null, troops: number) => {
    if (!read().ready || !Number.isFinite(troops) || troops < 1) return false;
    events.emit(new SendAttackIntentEvent(targetID, troops));
    return true;
  };
  const url = "http://127.0.0.1:8788/agent.js";
  void import(/* @vite-ignore */ url)
    .then((module) => {
      if (!disposed) cleanup = module.mount({ game, read, sendAttack });
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
