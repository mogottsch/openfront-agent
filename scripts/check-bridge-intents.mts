// Explicit local, engine-event smoke. Imports the installed TypeScript bridge
// from the sibling checkout; no model request or game-core mutation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { GameView } from "../../OpenFrontIO/src/client/view/GameView.ts";
import type { EventBus } from "../../OpenFrontIO/src/core/EventBus.ts";
// Upstream client Transport imports DOM-using modules at initialization. Use
// its already-installed jsdom as a test-only DOM; no game/app/browser starts.
const requireGame = createRequire(
  new URL("../../OpenFrontIO/package.json", import.meta.url),
);
const { JSDOM } = requireGame("jsdom");
const dom = new JSDOM("<!doctype html><body></body>", {
  url: "http://localhost:9000/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  self: dom.window,
});
const { createGuardedIntentSenders } =
  await import("../../OpenFrontIO/src/client/WildernessAgentBridge.ts");
const {
  BuildUnitIntentEvent,
  SendAttackIntentEvent,
  SendBoatAttackIntentEvent,
} = await import("../../OpenFrontIO/src/client/Transport.ts");
const { UnitType } = await import("../../OpenFrontIO/src/core/game/Game.ts");

const state = { ready: true, ended: false };
let reserve = 9624.8;
const emitted = [];
const game = {
  myPlayer: () => ({ smallID: () => 1, troops: () => reserve }),
  isValidRef: (ref: number) => Number.isInteger(ref) && ref >= 0 && ref < 4,
  isLand: (ref: number) => ref !== 1,
  isImpassable: (ref: number) => ref === 3,
  ownerID: (ref: number) => [1, 0, 2, 0][ref],
} as unknown as GameView;
const events = {
  emit: (event: unknown) => {
    emitted.push(event);
  },
} as unknown as EventBus;
const { sendAttack, sendBuild, sendBoat } = createGuardedIntentSenders(
  game,
  events,
  () => state,
);
assert.equal(sendBoat(2, 962), true);
assert(emitted[0] instanceof SendBoatAttackIntentEvent);
assert.deepEqual(
  { dst: emitted[0].dst, troops: emitted[0].troops },
  { dst: 2, troops: 962 },
);
for (const [tile, troops] of [
  [0, 962],
  [1, 962],
  [3, 962],
  [-1, 962],
  [4, 962],
  [2, 0],
  [2, 962.2],
  [2, 10000],
  [2, NaN],
] as const)
  assert.equal(sendBoat(tile, troops), false);
assert.equal(emitted.length, 1);
assert.equal(sendBuild(UnitType.City, 2), true);
assert(emitted[1] instanceof BuildUnitIntentEvent);
assert.equal(emitted[1].unit, UnitType.City);
assert.equal(emitted[1].tile, 2);
assert.equal(sendBuild(UnitType.DefensePost, 2), false);
assert.equal(sendAttack(null, 250), true);
assert(emitted[2] instanceof SendAttackIntentEvent);
assert.equal(emitted[2].targetID, null);
assert.equal(emitted[2].troops, 250);
state.ended = true;
assert.equal(sendBoat(2, 962), false);
assert.equal(sendBuild(UnitType.City, 2), false);
assert.equal(sendAttack(null, 250), false);
state.ended = false;
state.ready = false;
assert.equal(sendBoat(2, 962), false);
reserve = 0;
state.ready = true;
assert.equal(sendBoat(2, 962), false);
assert.equal(emitted.length, 3);
console.log(
  "Normal attack, City and boat events passed the guarded local intent envelope.",
);
