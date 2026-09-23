// Local, opt-in HTTP client for a server-owned strategic plan. It never holds
// GitHub credentials, invents a plan, or emits game intents. Only the user's
// Start Hybrid path may call plan(); heartbeats are ordinary state reports,
// not model requests. The Node service owns auth, plan validation and SDK use.
export function createPlanClient({
  baseUrl,
  read,
  getGameId,
  getGold,
  getToken,
  fetchImpl = fetch,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (
    !baseUrl ||
    typeof read !== "function" ||
    typeof getGameId !== "function" ||
    typeof getGold !== "function" ||
    typeof getToken !== "function" ||
    typeof fetchImpl !== "function"
  )
    throw new Error("Invalid plan client dependencies");
  const endpoint = (path) => new URL(path, baseUrl);
  let pending = false;
  let heartbeating = false;
  let timer = null;
  let sessionActive = false;
  let plannedGame = null;
  let abort = null;
  const headers = () => {
    const token = getToken();
    if (typeof token !== "string" || !token)
      throw new Error("No explicit local Start session for Copilot plan");
    return { "Content-Type": "application/json", "X-Agent-Session": token };
  };
  const getJson = async (path, { method = "GET", body, signal } = {}) => {
    const reply = await fetchImpl(endpoint(path), {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const data = await reply.json();
    if (!reply.ok) throw new Error(data.error || `Plan HTTP ${reply.status}`);
    return data;
  };
  const heartbeat = async (signal) => {
    if (!sessionActive || heartbeating) return false;
    const state = read();
    if (
      !state?.ready ||
      state.ended ||
      !Number.isInteger(state.tick) ||
      getGameId() !== plannedGame
    )
      return false;
    heartbeating = true;
    try {
      await getJson("/plan/heartbeat", {
        method: "POST",
        body: { game_id: plannedGame, tick: state.tick, region_ids: [] },
        signal,
      });
      return true;
    } finally {
      heartbeating = false;
    }
  };
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  return {
    async plan({ tick, land }, signal) {
      if (pending) throw new Error("Copilot plan already pending");
      const state = read();
      if (
        !state?.ready ||
        state.ended ||
        (getGameId() !== plannedGame && plannedGame !== null) ||
        !Number.isInteger(tick) ||
        tick > state.tick ||
        state.tick - tick > 20
      ) {
        throw new Error("Game changed before Copilot plan request");
      }
      const gold = getGold();
      if (typeof gold !== "string" || !/^(0|[1-9]\d{0,39})$/.test(gold))
        throw new Error("Invalid game gold for plan");
      const game_id = getGameId();
      const snapshot = {
        game_id,
        tick,
        region_ids: [],
        summary: {
          troops: land.self.troops,
          troop_capacity: land.self.troop_capacity,
          territory_tiles: land.self.territory_tiles,
          available_gold: gold,
          incoming_attack_troops: land.incoming_attacks
            .filter((a) => !a.retreating)
            .reduce((n, a) => n + a.troops, 0),
          wilderness_border_edges: land.border.wilderness_edges,
          player_border_edges: land.border.player_edges,
          regions: [],
        },
      };
      pending = true;
      sessionActive = true;
      plannedGame = game_id;
      const controller = new AbortController();
      abort = controller;
      const onAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const promise = getJson("/plan", {
        method: "POST",
        body: snapshot,
        signal: controller.signal,
      });
      // Start regular heartbeats WHILE the paid Copilot request is in flight;
      // the server rejects plans with an expired heartbeat even if SDK replies.
      timer = setTimer(() => {
        void heartbeat(controller.signal).catch(() => {});
      }, 1000);
      try {
        const result = await promise;
        const current = read();
        if (
          controller.signal.aborted ||
          !current?.ready ||
          current.ended ||
          getGameId() !== game_id ||
          !result?.plan
        )
          throw new Error("Copilot plan is stale or unavailable");
        return result.plan;
      } finally {
        stopTimer();
        pending = false;
        signal?.removeEventListener("abort", onAbort);
        if (abort === controller) abort = null;
      }
    },
    async heartbeat(signal) {
      return heartbeat(signal);
    },
    async getPlan(signal) {
      if (!sessionActive || getGameId() !== plannedGame) return null;
      const result = await getJson("/plan", { signal });
      return result?.plan ?? null;
    },
    stop() {
      stopTimer();
      abort?.abort();
      abort = null;
      sessionActive = false;
      plannedGame = null;
    },
  };
}
