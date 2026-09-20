// Analysis policies, not the deployed Jev prompt/controller.
export function reserveBandAction(troops, capacity, targetRatio) {
  if (
    !Number.isFinite(troops) ||
    troops < 0 ||
    !Number.isFinite(capacity) ||
    capacity <= 0 ||
    !Number.isFinite(targetRatio) ||
    targetRatio <= 0 ||
    targetRatio >= 1
  ) {
    throw new Error("Invalid reserve-policy inputs");
  }
  // Choose the allowed action whose post-send reserve is closest to the target.
  // Ties prefer less spending. At target=0.42, wait -> 10% switches near
  // 0.42 / 0.95 = 44.21% of capacity, leaving approximately 39.79%.
  let choice = 0;
  let error = Math.abs(troops / capacity - targetRatio);
  for (const fraction of [0.1, 0.2]) {
    const nextError = Math.abs(
      (troops * (1 - fraction)) / capacity - targetRatio,
    );
    if (nextError < error - 1e-12) {
      choice = fraction;
      error = nextError;
    }
  }
  return choice;
}

export function openingPolicies() {
  const policies = [{ name: "wait", choose: () => 0 }];
  for (const fraction of [0.1, 0.2]) {
    for (const intervalSeconds of [1, 2, 3, 4]) {
      policies.push({
        name: `fixed-${fraction * 100}-every-${intervalSeconds}s`,
        choose: ({ tick }) =>
          tick % (intervalSeconds * 10) === 0 ? fraction : 0,
      });
    }
  }
  for (const targetRatio of [0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.42, 0.5, 0.6]) {
    for (const initialPush of [false, true]) {
      policies.push({
        name: `reserve-${targetRatio * 100}${initialPush ? "-initial20" : ""}`,
        choose: ({ troops, capacity, tick }) =>
          initialPush && tick === 0
            ? 0.2
            : reserveBandAction(troops, capacity, targetRatio),
      });
    }
  }
  return policies;
}
