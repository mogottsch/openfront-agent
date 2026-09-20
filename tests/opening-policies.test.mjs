import test from "node:test";
import assert from "node:assert/strict";
import {
  openingPolicies,
  reserveBandAction,
} from "../scripts/opening-policies.mjs";

test("30% target waits below the band, sends 10% near it and 20% above it", () => {
  for (const [troops, fraction] of [
    [2500, 0],
    [3000, 0],
    [3100, 0],
    [3200, 0.1],
    [3500, 0.1],
    [3600, 0.2],
  ]) {
    assert.equal(reserveBandAction(troops, 10000, 0.3), fraction);
  }
});

test("band transition thresholds follow the midpoint of the post-send reserves", () => {
  for (const target of [0.2, 0.3, 0.35, 0.42]) {
    const first = (target / 0.95) * 100000;
    const second = (target / 0.85) * 100000;
    assert.equal(reserveBandAction(first - 1, 100000, target), 0);
    assert.equal(reserveBandAction(first, 100000, target), 0);
    assert.equal(reserveBandAction(first + 1, 100000, target), 0.1);
    assert.equal(reserveBandAction(second - 1, 100000, target), 0.1);
    assert.equal(reserveBandAction(second, 100000, target), 0.1);
    assert.equal(reserveBandAction(second + 1, 100000, target), 0.2);
  }
});

test("reserve policy scales with current capacity, not an absolute troop threshold", () => {
  assert.equal(reserveBandAction(4000, 10000, 0.3), 0.2);
  assert.equal(reserveBandAction(4000, 20000, 0.3), 0);
  assert.equal(reserveBandAction(40000, 100000, 0.3), 0.2);
});

test("analysis policies preserve the bounded action set and initial-push definition", () => {
  const policies = openingPolicies();
  assert.equal(policies.length, 27);
  assert.equal(new Set(policies.map((p) => p.name)).size, 27);
  for (const policy of policies) {
    for (const tick of [0, 10, 20, 30, 100]) {
      for (const ratio of [0, 0.1, 0.3, 0.45, 0.9]) {
        assert.ok(
          [0, 0.1, 0.2].includes(
            policy.choose({ tick, troops: ratio * 100000, capacity: 100000 }),
          ),
        );
      }
    }
  }
  const peak = policies.find((p) => p.name === "reserve-42");
  const opener = policies.find((p) => p.name === "reserve-42-initial20");
  assert.equal(peak.choose({ tick: 0, troops: 25000, capacity: 120000 }), 0);
  assert.equal(
    opener.choose({ tick: 0, troops: 25000, capacity: 120000 }),
    0.2,
  );
  assert.equal(opener.choose({ tick: 10, troops: 25000, capacity: 120000 }), 0);
});

test("reserve policy rejects invalid observations", () => {
  for (const args of [
    [NaN, 10000, 0.3],
    [-1, 10000, 0.3],
    [100, 0, 0.3],
    [100, Infinity, 0.3],
    [100, 10000, 0],
    [100, 10000, 1],
  ]) {
    assert.throws(() => reserveBandAction(...args));
  }
});
