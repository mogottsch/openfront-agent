// Future-only CITY site adapter. No current controller imports this module.
// The caller alone decides when to pay the O(map) snapshot cost; it must not
// call propose() on the one-second land-decision loop. No direct game intents.
// marginal_coverage_tiles is a geometric disc over own land, NOT City income,
// population, defense, connectivity, or any other engine-validated effect.
import { analyzeSpatialMap, prefilterPlacementSites } from "./spatial-map.js";

function boundedInt(value, name, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`Invalid ${name}`);
  }
  return value;
}

function identity(game, mapId) {
  const gameId = game.gameID?.();
  if ((typeof gameId !== "string" || !gameId) &&
      (typeof mapId !== "string" || !mapId)) {
    throw new Error("Building snapshots require a game ID or explicit map ID");
  }
  return `${gameId || "local"}/${mapId || "map"}`;
}

function validGold(value) {
  return typeof value === "bigint" && value >= 0n;
}

/**
 * cityUnit must be the upstream UnitType.City value ("City"). The injected
 * sendBuild(unit, tile) callback may emit an intent later, but this module
 * never imports OpenFront transport, executes a build by itself, or treats a
 * successful callback as an accepted/finished construction.
 *
 * read() must return {ready:boolean,tick:number}; tick is checked against
 * game.ticks() before/after every worker await. game.gameID() is preferred;
 * absent that, propose({mapId}) must provide a stable game/map identity.
 * execute(id, isCurrent=()=>true) accepts a synchronous, generation-bound
 * predicate from the caller. It is checked again after the final worker wait
 * and immediately before sendBuild so Stop/restart never emits a late intent.
 */
export function createBuildingAdapter({ game, read, sendBuild, cityUnit }) {
  if (!game || typeof read !== "function" || typeof sendBuild !== "function" ||
      cityUnit !== "City") {
    throw new TypeError("Building adapter requires game, read, sendBuild and UnitType.City");
  }
  let proposal = null;
  let permit = null;
  let checking = 0;
  let proposing = false;
  // A true return from sendBuild means an intent was emitted, NOT a game
  // outcome. Do not automatically retry an unobserved build on the next tick.
  const pending = new Map();
  const PENDING_REVIEW_TICKS = 30;

  // Only explicit proposal refreshes reconcile emitted intents. A visible
  // City (including under construction) confirms an outcome; an unobserved
  // intent may be retried no sooner than 30 ticks, and only after a NEW
  // worker check. No timer or automatic resend runs between proposals.
  function reconcilePending(snapshot) {
    if (typeof snapshot.player.units !== "function") return;
    const cities = new Set(snapshot.player.units(cityUnit).map((unit) => unit.tile()));
    for (const [key, entry] of pending) {
      if (entry.map_id !== snapshot.map_id || cities.has(entry.tile) ||
          snapshot.source_tick - entry.tick >= PENDING_REVIEW_TICKS) {
        pending.delete(key);
      }
    }
  }

  function current(snapshot, exactTick = null) {
    if (!snapshot) return false;
    const state = read();
    const player = game.myPlayer();
    const tick = game.ticks();
    return state?.ready === true && state.ended !== true &&
      Number.isInteger(state.tick) &&
      state.tick === tick && tick >= snapshot.source_tick &&
      tick - snapshot.source_tick <= 20 &&
      performance.now() - snapshot.started_at <= 2000 &&
      (exactTick === null || tick === exactTick) &&
      identity(game, snapshot.explicitMapId) === snapshot.map_id &&
      player === snapshot.player && player.smallID() === snapshot.player_id;
  }

  function owns(tile, snapshot) {
    return game.isLand(tile) && !game.isImpassable(tile) &&
      game.ownerID(tile) === snapshot.player_id;
  }

  function cityAt(tile, snapshot) {
    return typeof snapshot.player.units === "function" &&
      snapshot.player.units(cityUnit).some((unit) => unit.tile() === tile);
  }

  async function checkedCity(tile, snapshot, exactTick = null) {
    if (!current(snapshot, exactTick) || !owns(tile, snapshot)) return null;
    if (cityAt(tile, snapshot)) return { reason: "occupied_city" };
    // Important: core can return a DIFFERENT nearby canBuild tile or an
    // upgrade. Neither matches the advertised site or a new CITY build.
    const result = await snapshot.player.buildables(tile, [cityUnit]);
    if (!current(snapshot, exactTick) || !owns(tile, snapshot)) return null;
    if (cityAt(tile, snapshot)) return { reason: "occupied_city" };
    if (!Array.isArray(result) || result.length !== 1 ||
        result[0]?.type !== cityUnit) return { reason: "invalid_worker_result" };
    const unit = result[0];
    if (!validGold(unit.cost)) return { reason: "invalid_worker_result" };
    if (unit.canUpgrade !== false) return { reason: "upgrade_not_city_build" };
    if (unit.canBuild === false) return { reason: "not_buildable" };
    if (unit.canBuild !== tile) return { reason: "relocated" };
    const gold = snapshot.player.gold();
    if (!validGold(gold)) return { reason: "invalid_gold" };
    if (gold < unit.cost) return { reason: "unaffordable" };
    return { cost: unit.cost, gold };
  }

  function requireFreshProposal() {
    return proposal && current(proposal) ? proposal : null;
  }

  return {
    /** Explicit, single-flight whole-map snapshot; never schedule at 1 Hz. */
    async propose({ mapId, existingSites = [], coverageRadius = 6,
      maxCandidates = 24, maxExamined = 4096, maxWorkerChecks = 48 } = {}) {
      if (proposing) throw new Error("Building proposal already in flight");
      boundedInt(maxCandidates, "maxCandidates", 64);
      boundedInt(maxExamined, "maxExamined", 65536);
      boundedInt(maxWorkerChecks, "maxWorkerChecks", 128);
      if (!Array.isArray(existingSites)) throw new TypeError("Invalid existingSites");
      proposing = true;
      proposal = null;
      permit = null;
      checking++;
      try {
        const started_at = performance.now();
        const player = game.myPlayer();
        const source_tick = game.ticks();
        const state = read();
        if (!player || state?.ready !== true || state.ended === true ||
            state.tick !== source_tick) {
          throw new Error("Game is not ready for building snapshot");
        }
        const map_id = identity(game, mapId);
        const snapshot = { source_tick, started_at, map_id,
          explicitMapId: mapId, player, player_id: player.smallID() };
        const spatial = analyzeSpatialMap(game, snapshot.player_id,
          { tick: source_tick, mapId: map_id });
        const assertFresh = () => {
          if (!current(snapshot)) {
            throw new Error(`Building snapshot stale: source_tick=${source_tick} ` +
              `current_tick=${game.ticks()}`);
          }
        };
        assertFresh();
        reconcilePending(snapshot);
        // More prefiltered sites than the final candidate count permit worker
        // rejection without suppressing all options. Worker checks remain
        // explicitly bounded, and all omissions are disclosed below.
        const filtered = prefilterPlacementSites(spatial, {
          existingSites, coverageRadius, maxExamined,
          maxCandidates: Math.min(512, Math.max(maxCandidates, maxWorkerChecks)),
        });
        const limit = Math.min(filtered.candidates.length, maxWorkerChecks);
        const counts = { not_examined: filtered.reasons.not_examined,
          prefilter_limit: filtered.reasons.shortlist_limit,
          worker_unchecked: 0,
          pending_intent: 0, occupied_city: 0, not_buildable: 0, relocated: 0,
          upgrade_not_city_build: 0, unaffordable: 0,
          unaffordable_after_check: 0, invalid_worker_result: 0,
          invalid_gold: 0, shortlist_limit: 0 };
        const internal = new Map();
        const candidates = [];
        let processed = 0;
        let workerChecked = 0;
        for (let i = 0; i < limit && candidates.length < maxCandidates; i++) {
          processed++;
          const site = filtered.candidates[i];
          assertFresh();
          if (pending.has(`${map_id}:${site.tile}`)) {
            counts.pending_intent++;
            continue;
          }
          if (cityAt(site.tile, snapshot)) {
            counts.occupied_city++;
            continue;
          }
          workerChecked++;
          const checked = await checkedCity(site.tile, snapshot);
          assertFresh();
          if (checked === null) {
            counts.not_buildable++;
            continue;
          }
          if (checked.reason) {
            counts[checked.reason]++;
            continue;
          }
          const { tile, id: _spatialId, ...features } = site;
          // Opaque candidate ID; the topology prefilter's ID embeds a tile ref
          // and is deliberately never sent to a later model Choice.
          const id = `${spatial.snapshot_id}:c${candidates.length + 1}`;
          const candidate = { id, ...features, kind: "build_city",
            cost_gold: checked.cost.toString() };
          candidates.push(candidate);
          internal.set(id, { tile, cost: checked.cost });
        }
        // Once the offered cohort is full, avoid wasteful extra worker RPCs.
        // Distinguish that cap from the separate maxWorkerChecks cap.
        const unchecked = filtered.candidates.length - processed;
        if (candidates.length >= maxCandidates) counts.shortlist_limit = unchecked;
        else counts.worker_unchecked = unchecked;
        assertFresh();
        const availableGold = player.gold();
        if (!validGold(availableGold)) throw new Error("Invalid current gold");
        // Use one final BigInt balance for every advertised cost/after pair.
        // A worker-legal site that became unaffordable during the other checks
        // is removed and accounted for, never shown with contradictory gold.
        for (let i = candidates.length - 1; i >= 0; i--) {
          const candidate = candidates[i];
          const cost = internal.get(candidate.id).cost;
          if (availableGold < cost) {
            counts.unaffordable_after_check++;
            internal.delete(candidate.id);
            candidates.splice(i, 1);
          } else {
            candidate.gold_after_estimate = (availableGold - cost).toString();
          }
        }
        const ownedCityCount = typeof player.units === "function" ?
          player.units(cityUnit).length : null;
        const pendingCityCount = [...pending.values()].filter((entry) =>
          entry.map_id === map_id).length;
        const omitted_count = filtered.total_eligible - candidates.length;
        if (Object.values(counts).reduce((n, value) => n + value, 0) !== omitted_count) {
          throw new Error("Building omission accounting mismatch");
        }
        const save_gold = { id: `${spatial.snapshot_id}:save_gold`, kind: "save_gold" };
        proposal = { ...snapshot, snapshot_id: spatial.snapshot_id,
          availableGold, offered: internal, saveId: save_gold.id };
        return { snapshot_id: spatial.snapshot_id, source_tick,
          current_tick: game.ticks(), map_id,
          available_gold: availableGold.toString(),
          city_counts: { owned: ownedCityCount, pending: pendingCityCount },
          candidates, save_gold,
          coverage: { total_eligible: filtered.total_eligible,
            total_examined: filtered.total_examined,
            worker_checked: workerChecked,
            offered_count: candidates.length,
            omitted_count,
            model: filtered.coverage_model },
          omissions: counts };
      } finally {
        proposing = false;
      }
    },

    async canExecute(candidateId) {
      permit = null;
      const serial = ++checking;
      const snapshot = requireFreshProposal();
      if (!snapshot || typeof candidateId !== "string") return false;
      if (candidateId === snapshot.saveId) return true;
      const selected = snapshot.offered.get(candidateId);
      if (!selected || pending.has(`${snapshot.map_id}:${selected.tile}`)) return false;
      const checked = await checkedCity(selected.tile, snapshot);
      if (serial !== checking || !checked || checked.reason ||
          checked.cost !== selected.cost || checked.gold !== snapshot.availableGold ||
          !current(snapshot) ||
          pending.has(`${snapshot.map_id}:${selected.tile}`)) return false;
      permit = { snapshot_id: snapshot.snapshot_id, id: candidateId,
        tick: game.ticks(), tile: selected.tile, gold: checked.gold };
      return true;
    },

    async execute(candidateId, isCurrent = () => true) {
      const checkedPermit = permit;
      permit = null; // consume before ANY await, including failed sends
      checking++;
      // Generation-bound caller guard: a Stop/restart may happen while the
      // final buildables() worker request is outstanding. Fail closed if its
      // predicate throws, is absent, or no longer identifies this run.
      const stillCurrent = () => {
        try { return typeof isCurrent === "function" && isCurrent() === true; }
        catch { return false; }
      };
      if (!stillCurrent()) return false;
      const snapshot = requireFreshProposal();
      if (!snapshot || typeof candidateId !== "string") return false;
      if (candidateId === snapshot.saveId) return true; // no worker, no intent
      if (!checkedPermit || checkedPermit.snapshot_id !== snapshot.snapshot_id ||
          checkedPermit.id !== candidateId || !current(snapshot, checkedPermit.tick)) return false;
      const selected = snapshot.offered.get(candidateId);
      if (!selected || selected.tile !== checkedPermit.tile ||
          pending.has(`${snapshot.map_id}:${selected.tile}`)) return false;
      const result = await checkedCity(selected.tile, snapshot, checkedPermit.tick);
      if (!result || result.reason || result.cost !== selected.cost ||
          result.gold !== checkedPermit.gold || !current(snapshot, checkedPermit.tick) ||
          !owns(selected.tile, snapshot) || !stillCurrent()) return false;
      const key = `${snapshot.map_id}:${selected.tile}`;
      if (pending.has(key)) return false;
      // Reserve synchronously before invoking the callback: reentrant callers
      // cannot emit a duplicate. Only an explicit false proves no intent was
      // emitted. A throw/non-boolean result is ambiguous and stays pending
      // until observed or the conservative review window expires.
      pending.set(key, { tile: selected.tile, tick: game.ticks(), map_id: snapshot.map_id });
      if (!stillCurrent()) {
        pending.delete(key);
        return false;
      }
      let outcome;
      try {
        outcome = sendBuild(cityUnit, selected.tile);
      } catch {
        return false;
      }
      if (outcome === false) pending.delete(key);
      return outcome === true;
    },
  };
}
