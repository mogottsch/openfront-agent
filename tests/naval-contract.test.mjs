import test from "node:test";
import assert from "node:assert/strict";
import { createNavalAdapter } from "../web/naval-adapter.js";
import {
  validateNavalProposal,
  navalChoices,
} from "../web/naval-observation.js";
import { observation } from "./fixtures/land.mjs";

test("actual worker-checked naval adapter output matches strict Jev projection without tile refs", async () => {
  const sent = [];
  const other = {
    smallID: () => 2,
    isPlayer: () => true,
    isAlive: () => true,
    type: () => "NATION",
    isFriendly: () => false,
    isOnSameTeam: () => false,
  };
  const me = {
    smallID: () => 1,
    troops: () => 9624.8,
    gold: () => 1000n,
    units: () => [],
    isFriendly: () => false,
    isOnSameTeam: () => false,
    buildables: async (tile, types) => {
      assert.equal(tile, 2);
      assert.deepEqual(types, ["Transport"]);
      return [{ type: "Transport", canBuild: 0, canUpgrade: false, cost: 0n }];
    },
  };
  const owners = [1, 0, 2];
  const game = {
    width: () => 3,
    height: () => 1,
    ref: (x) => x,
    gameID: () => "solo-1",
    ticks: () => 100,
    myPlayer: () => me,
    playerBySmallID: () => other,
    ownerID: (t) => owners[t],
    isLand: (t) => t !== 1,
    isWater: (t) => t === 1,
    isOcean: () => false,
    isImpassable: () => false,
    isShore: (t) => t !== 1,
    neighbors: (t) => [t - 1, t + 1].filter((n) => n >= 0 && n < 3),
    isSpawnImmunityActive: () => false,
    isNationSpawnImmunityActive: () => false,
    config: () => ({ boatMaxNumber: () => 3 }),
  };
  const adapter = createNavalAdapter({
    game,
    read: () => ({ ready: true, ended: false, tick: 100 }),
    transportUnit: "Transport",
    sendBoat: (dst, troops) => {
      sent.push({ dst, troops });
      return true;
    },
  });
  const proposal = await adapter.propose({
    mapId: "map",
    maxCandidates: 4,
    maxCoastTiles: 16,
    maxPairs: 16,
    maxWorkerChecks: 4,
  });
  assert.equal(proposal.candidates.length, 1);
  validateNavalProposal(proposal, { gameId: "solo-1", snapshotTick: 100 });
  const actions = navalChoices(proposal, observation(962));
  assert.equal(actions.boat_1_10.candidate_id, proposal.candidates[0].id);
  assert.ok(!JSON.stringify(actions).includes("target_shore_tile"));
  assert.equal(await adapter.canExecute(proposal.candidates[0].id, 0.1), true);
  assert.equal(
    await adapter.execute(proposal.candidates[0].id, 0.1, () => true),
    true,
  );
  assert.deepEqual(sent, [{ dst: 2, troops: 962 }]);
});
