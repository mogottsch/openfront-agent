// Native WinCheckExecution unranked FFA: all ALIVE types compete by tiles,
// strict share OR configured timer OR 170-minute hard limit. No intent/model,
// map scan or future-winner prediction. Unknown/unsupported producer data is
// ABSENT, never an invented zero clock, unlimited deadline or first rank.
export const WIN_RULE = "ffa_largest_alive_territory_at_timer_or_strict_share";
export const HARD_DEADLINE_SECONDS = 170 * 60;
const MAX_PLAYERS = 4095;
const TYPES = ["human", "nation", "tribe"];
const typeName = { HUMAN: "human", NATION: "nation", BOT: "tribe" };
const keys = ["game_id", "source_tick", "rule", "elapsed_seconds", "timer_seconds",
  "share_threshold_percent", "non_fallout_land_tiles", "eligible_alive_count",
  "self_rank_by_tiles", "leading_territory_tiles", "tied_leader_count", "leader"];
const fail = () => { throw new Error("Invalid win context"); };
const integer = (n, min, max = 1e9) => {
  if (!Number.isSafeInteger(n) || n < min || n > max) fail();
  return n;
};
const exact = (v, fields) => {
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).length !== fields.length || !fields.every(k => Object.hasOwn(v, k))) fail();
};

/** Strict cloned facts; self is the owning raw observation's {id,territory_tiles}. */
export function validateWinContext(v, self) {
  exact(v, keys);
  integer(self?.id, 1, MAX_PLAYERS);
  integer(self?.territory_tiles, 1);
  if (typeof v.game_id !== "string" || !v.game_id || v.game_id.length > 160 ||
      v.rule !== WIN_RULE || !Number.isFinite(v.elapsed_seconds) ||
      v.elapsed_seconds < 0 || v.elapsed_seconds > 1e9 ||
      !Number.isFinite(v.share_threshold_percent) ||
      v.share_threshold_percent < 0 || v.share_threshold_percent > 100) fail();
  integer(v.source_tick, 0, Number.MAX_SAFE_INTEGER);
  if (v.timer_seconds !== null) {
    integer(v.timer_seconds, 60, 7200);
    if (v.timer_seconds % 60 !== 0) fail();
  }
  integer(v.non_fallout_land_tiles, 0);
  integer(v.eligible_alive_count, 1, MAX_PLAYERS);
  integer(v.self_rank_by_tiles, 1, v.eligible_alive_count);
  integer(v.leading_territory_tiles, self.territory_tiles);
  integer(v.tied_leader_count, 1, v.eligible_alive_count);
  if ((v.self_rank_by_tiles === 1) !== (self.territory_tiles === v.leading_territory_tiles) ||
      (v.self_rank_by_tiles > 1 && v.self_rank_by_tiles <= v.tied_leader_count)) fail();
  let leader = null;
  if (v.tied_leader_count === 1) {
    exact(v.leader, ["id", "type"]);
    integer(v.leader.id, 1, MAX_PLAYERS);
    if (!TYPES.includes(v.leader.type) ||
        ((v.leader.id === self.id) !== (v.self_rank_by_tiles === 1)) ||
        (v.leader.id === self.id && v.leader.type !== "human")) fail();
    leader = { id: v.leader.id, type: v.leader.type };
  } else if (v.leader !== null) fail();
  return { game_id: v.game_id, source_tick: v.source_tick, rule: v.rule,
    elapsed_seconds: v.elapsed_seconds, timer_seconds: v.timer_seconds,
    share_threshold_percent: v.share_threshold_percent,
    non_fallout_land_tiles: v.non_fallout_land_tiles,
    eligible_alive_count: v.eligible_alive_count, self_rank_by_tiles: v.self_rank_by_tiles,
    leading_territory_tiles: v.leading_territory_tiles,
    tied_leader_count: v.tied_leader_count, leader };
}

/** Code arithmetic, not a model objective/Copilot plan or winner oracle. */
export function deriveWinContext(value, self) {
  const v = validateWinContext(value, self);
  const effective = Math.min(v.timer_seconds ?? HARD_DEADLINE_SECONDS, HARD_DEADLINE_SECONDS);
  const denominator = v.non_fallout_land_tiles;
  return { ...v, eligible_types: [...TYPES],
    rank_semantics: "competition_one_plus_strictly_more_tiles_not_tie_winner",
    configured_timer_remaining_seconds: v.timer_seconds === null ? null :
      Math.max(0, v.timer_seconds - v.elapsed_seconds),
    hard_deadline_seconds: HARD_DEADLINE_SECONDS,
    effective_deadline_seconds: effective,
    effective_deadline_remaining_seconds: Math.max(0, effective - v.elapsed_seconds),
    territory_tiles_behind_leader: v.leading_territory_tiles - self.territory_tiles,
    our_territory_share_percent: denominator === 0 ? null :
      Math.round(100 * self.territory_tiles / denominator * 1e4) / 1e4,
    // Strict predicate only. Largest alive/tie order and future changes still
    // matter; this is NOT an actual Win event or safe-win guarantee.
    our_share_exceeds_threshold:
      self.territory_tiles * 100 > denominator * v.share_threshold_percent };
}

/** Two complete player passes with bounded ID sorting (P<=4095); no map/worker. */
export function observeWinContext(game, selfId, { expectedTick = null } = {}) {
  try {
    integer(selfId, 1, MAX_PLAYERS);
    const tick = integer(game.ticks(), 0, Number.MAX_SAFE_INTEGER);
    if (expectedTick !== null && tick !== expectedTick) return undefined;
    const gameId = game.gameID();
    const config = game.config();
    const setting = config.gameConfig();
    // This project's approved execution scope, not a multiplayer/team/ranked
    // rules approximation. Missing config/APIs fall through to unknown.
    if (!setting || setting.gameType !== "Singleplayer" ||
        setting.gameMode !== "Free For All" || setting.rankedType != null ||
        config.isReplay() !== false) return undefined;
    const timerMinutes = setting.maxTimerValue;
    const timer = timerMinutes == null ? null : integer(timerMinutes, 1, 120) * 60;
    const elapsed = game.elapsedGameSeconds();
    const threshold = config.percentageTilesOwnedToWin(elapsed);
    const land = integer(game.numLandTiles(), 0);
    const fallout = integer(game.numTilesWithFallout(), 0, land);
    const self = game.playerBySmallID(selfId);
    if (self?.isPlayer() !== true || self.isAlive() !== true ||
        self.smallID() !== selfId || self.type() !== "HUMAN") return undefined;
    const ownIdentity = self.id();
    if (typeof ownIdentity !== "string" || !ownIdentity) return undefined;
    const own = { id: selfId, territory_tiles: integer(self.numTilesOwned(), 1) };
    const collect = () => {
      const players = game.players();
      if (!Array.isArray(players) || players.length > MAX_PLAYERS) fail();
      const ids = new Set(), identities = new Set(), records = [];
      for (const p of players) {
        if (p?.isPlayer() !== true) fail();
        const alive = p.isAlive();
        if (alive === false) continue; // core alive-only, browser all views
        if (alive !== true) fail();
        const id = integer(p.smallID(), 1, MAX_PLAYERS), identity = p.id();
        const type = typeName[p.type()];
        const tiles = integer(p.numTilesOwned(), 1);
        if (!type || typeof identity !== "string" || !identity ||
            ids.has(id) || identities.has(identity)) fail();
        ids.add(id); identities.add(identity);
        records.push({ id, identity, type, tiles });
      }
      return records.sort((a, b) => a.id - b.id);
    };
    const records = collect();
    const ownRecord = records.find(p => p.id === selfId);
    if (!ownRecord || ownRecord.identity !== ownIdentity || ownRecord.type !== "human" ||
        ownRecord.tiles !== own.territory_tiles) return undefined;
    const leading = Math.max(...records.map(p => p.tiles));
    const leaders = records.filter(p => p.tiles === leading);
    const result = validateWinContext({ game_id: gameId, source_tick: tick, rule: WIN_RULE,
      elapsed_seconds: elapsed, timer_seconds: timer, share_threshold_percent: threshold,
      non_fallout_land_tiles: land - fallout, eligible_alive_count: records.length,
      self_rank_by_tiles: 1 + records.filter(p => p.tiles > own.territory_tiles).length,
      leading_territory_tiles: leading, tied_leader_count: leaders.length,
      leader: leaders.length === 1 ? { id: leaders[0].id, type: leaders[0].type } : null }, own);
    const currentSelf = game.playerBySmallID(selfId);
    const currentSetting = game.config().gameConfig();
    if (game.ticks() !== tick || game.gameID() !== gameId ||
        currentSelf?.id() !== ownIdentity || currentSelf.smallID() !== selfId ||
        currentSelf.type() !== "HUMAN" || currentSelf.isAlive() !== true ||
        currentSelf.numTilesOwned() !== own.territory_tiles ||
        game.elapsedGameSeconds() !== elapsed || game.config().isReplay() !== false ||
        currentSetting?.gameType !== setting.gameType ||
        currentSetting.gameMode !== setting.gameMode || currentSetting.rankedType != null ||
        currentSetting.maxTimerValue !== timerMinutes ||
        JSON.stringify(collect()) !== JSON.stringify(records) || game.ticks() !== tick)
      return undefined;
    return result;
  } catch {
    // Unknown APIs/budget/coverage/identity are not game policy and must not
    // fabricate a clock/rank. Existing ordinary land observation can continue.
    return undefined;
  }
}
