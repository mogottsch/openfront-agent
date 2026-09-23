// Local experimental bridge owned by ../openfront-agent; not upstream game logic.
// Filename retained so existing installs can be upgraded in place.
import { EventBus } from "../core/EventBus";
import { GameType, UnitType } from "../core/game/Game";
import { TileRef } from "../core/game/GameMap";
import { GameUpdateType } from "../core/game/GameUpdates";
import {
  BuildUnitIntentEvent,
  SendAttackIntentEvent,
  SendBoatAttackIntentEvent,
} from "./Transport";
import { GameView } from "./view/GameView";

// Pure, testable intent envelope. Only attachWildernessAgent invokes it in
// production, after the strict local-dev/solo guard below. The adapters own
// the stronger worker legality, candidate and snapshot checks.
export function createGuardedIntentSenders(
  game: GameView,
  events: EventBus,
  read: () => { ready: boolean; ended: boolean },
) {
  const sendAttack = (targetID: string | null, troops: number) => {
    const state = read();
    if (!state.ready || state.ended || !Number.isFinite(troops) || troops < 1)
      return false;
    events.emit(new SendAttackIntentEvent(targetID, troops));
    return true;
  };
  const sendBuild = (unit: UnitType, tile: TileRef) => {
    const state = read();
    if (
      !state.ready ||
      state.ended ||
      unit !== UnitType.City ||
      !Number.isInteger(tile) ||
      !game.isValidRef(tile)
    )
      return false;
    events.emit(new BuildUnitIntentEvent(unit, tile));
    return true;
  };
  const sendBoat = (dst: TileRef, troops: number) => {
    const state = read();
    const player = game.myPlayer();
    if (
      !state.ready ||
      state.ended ||
      !player ||
      !Number.isInteger(dst) ||
      !game.isValidRef(dst) ||
      !game.isLand(dst) ||
      game.isImpassable(dst) ||
      game.ownerID(dst) === player.smallID() ||
      !Number.isSafeInteger(troops) ||
      troops < 1 ||
      !Number.isFinite(player.troops()) ||
      troops > player.troops()
    )
      return false;
    events.emit(new SendBoatAttackIntentEvent(dst, troops));
    return true;
  };
  return { sendAttack, sendBuild, sendBoat };
}

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
        !game.gameOver() &&
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
  const { sendAttack, sendBuild, sendBoat } = createGuardedIntentSenders(
    game,
    events,
    read,
  );
  const url = "http://127.0.0.1:8788/agent.js";
  void import(/* @vite-ignore */ url)
    .then((module) => {
      if (!disposed)
        cleanup = module.mount({ game, read, sendAttack, sendBuild, sendBoat });
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
