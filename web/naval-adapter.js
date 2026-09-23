// Future-only, worker-checked TransportShip candidate envelope. No browser
// controller imports this yet; propose() is an explicit O(map) operation, not
// part of the one-second land loop. No game intent is emitted by this module.
import { ATTACK_FRACTIONS, TRIBE_ATTACK_FRACTIONS } from "./observation.js";
import { analyzeSpatialMap } from "./spatial-map.js";
import { analyzeNavalSpatial } from "./naval-spatial.js";

const typeName = { HUMAN: "human", NATION: "nation", BOT: "tribe" };
const REVIEW_TICKS = 30;

function bound(value, name, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`Invalid ${name}`);
  }
}

function identity(game, mapId) {
  const id = game.gameID?.();
  if ((!id || typeof id !== "string") && (!mapId || typeof mapId !== "string")) {
    throw new Error("Naval snapshot needs a game or explicit map ID");
  }
  return `${id || "local"}/${mapId || "map"}`;
}

function validTile(game, tile) {
  return Number.isInteger(tile) && tile >= 0 && tile < game.width() * game.height();
}

function validGold(gold) {
  return typeof gold === "bigint" && gold >= 0n;
}

function allowedFraction(fraction, type) {
  return (type === "tribe" ? TRIBE_ATTACK_FRACTIONS : ATTACK_FRACTIONS)
    .includes(fraction);
}

/**
 * `transportUnit` must be UnitType.TransportShip ("Transport"). `sendBoat`
 * is an injected synchronous `(destinationTile, internalTroops)=>boolean`
 * callback; later bridge wiring alone may emit the normal boat intent.
 * read() supplies `{ready,ended,tick}`. No unsupported target/fraction or
 * stale, allied, immune, unverified, over-cap, or duplicate intent is replaced
 * with a heuristic choice. Geometric reachability never substitutes for the
 * real PlayerView.buildables(dst,[UnitType.TransportShip]) worker result.
 */
export function createNavalAdapter({ game, read, sendBoat, transportUnit }) {
  if (!game || typeof read !== "function" || typeof sendBoat !== "function" ||
      transportUnit !== "Transport" || typeof game.isShore !== "function") {
    throw new TypeError("Naval adapter needs GameView, read, sendBoat and UnitType.TransportShip");
  }
  let proposal = null;
  let permit = null;
  let serial = 0;
  let proposing = false;
  const pending = new Map();

  function current(snapshot, exactTick = null) {
    if (!snapshot) return false;
    const state = read();
    const tick = game.ticks();
    const me = game.myPlayer();
    return state?.ready === true && state.ended !== true &&
      Number.isInteger(state.tick) && state.tick === tick &&
      tick >= snapshot.source_tick && tick - snapshot.source_tick <= 20 &&
      performance.now() - snapshot.started_at <= 2000 &&
      (exactTick === null || tick === exactTick) &&
      identity(game, snapshot.explicitMapId) === snapshot.map_id &&
      me === snapshot.me && me.smallID() === snapshot.player_id;
  }

  function target(snapshot, tile, expectedOwner = null, expectedType = null) {
    if (!validTile(game, tile) || !game.isLand(tile) ||
        game.isImpassable(tile) || !game.isShore(tile)) return null;
    const id = game.ownerID(tile);
    if (!Number.isInteger(id) || id < 0 || id > 4095 ||
        id === snapshot.player_id ||
        (expectedOwner !== null && id !== expectedOwner)) return null;
    if (id === 0) return expectedType !== null && expectedType !== "wilderness" ?
      null : { owner_id: 0, type: "wilderness" };
    let other;
    try { other = game.playerBySmallID(id); }
    catch { return null; }
    if (!other || other.smallID?.() !== id || !other.isPlayer?.() ||
        !other.isAlive?.()) return null;
    const kind = typeName[other.type?.()];
    if (!kind || (expectedType !== null && kind !== expectedType)) return null;
    const me = snapshot.me;
    // PlayerView has isFriendly, but no isImmune/canAttackPlayer. Check the
    // public GameView immunity flags when relevant, then trust the worker as
    // the authoritative answer (including other core-specific prohibitions).
    if (typeof me.isFriendly !== "function" ||
        typeof other.isFriendly !== "function" ||
        me.isFriendly(other) || other.isFriendly(me) ||
        me.isOnSameTeam?.(other) || other.isOnSameTeam?.(me) ||
        other.isImmune?.()) return null;
    if (kind === "human" && (typeof game.isSpawnImmunityActive !== "function" ||
        game.isSpawnImmunityActive())) return null;
    if (kind === "nation" &&
        (typeof game.isNationSpawnImmunityActive !== "function" ||
          game.isNationSpawnImmunityActive())) return null;
    return { owner_id: id, type: kind };
  }

  function fleet(snapshot) {
    const units = typeof snapshot.me.units === "function" ?
      snapshot.me.units(transportUnit) : null;
    const active = units?.filter((unit) => unit.isActive?.() !== false) ?? null;
    const cap = game.config?.()?.boatMaxNumber?.();
    return { cap: Number.isInteger(cap) && cap >= 0 ? cap : null,
      active_count: active?.length ?? null,
      // Code-side facts; a model-facing projection must not dump tile refs.
      active_transports: active?.map((unit) => ({
        destination_tile: typeof unit.targetTile === "function" &&
            validTile(game, unit.targetTile()) ? unit.targetTile() : null,
        troops_internal: typeof unit.troops === "function" &&
            Number.isFinite(unit.troops()) && unit.troops() >= 0 &&
            unit.troops() <= Number.MAX_SAFE_INTEGER ? unit.troops() : null,
      })) ?? [],
    };
  }

  function fleetRoom(snapshot) {
    const { cap, active_count } = fleet(snapshot);
    if (cap === 0) return false; // disabled, even if unit count is unavailable
    return cap === null || active_count === null || active_count < cap;
  }

  function troopsFor(snapshot, fraction, type) {
    if (!allowedFraction(fraction, type)) return null;
    const available = snapshot.me.troops?.(); // internal game units, not /10 display
    // PlayerView forwards a floating internal troop pool (growth/attrition
    // can yield e.g. 9624.8). Only the emitted intent amount is integer.
    if (!Number.isFinite(available) || available < 0 ||
        available > Number.MAX_SAFE_INTEGER) return null;
    const troops = Math.floor(available * fraction);
    return Number.isSafeInteger(troops) && troops >= 1 ?
      { available, troops } : null;
  }

  async function checkedBoat(tile, snapshot, ownerId, expectedType, exactTick = null) {
    if (!current(snapshot, exactTick) || !fleetRoom(snapshot) ||
        !target(snapshot, tile, ownerId, expectedType)) return null;
    const result = await snapshot.me.buildables(tile, [transportUnit]);
    if (!current(snapshot, exactTick) || !fleetRoom(snapshot) ||
        !target(snapshot, tile, ownerId, expectedType)) return null;
    if (!Array.isArray(result) || result.length !== 1 ||
        result[0]?.type !== transportUnit || !validGold(result[0]?.cost) ||
        result[0]?.canUpgrade !== false) return { reason: "invalid_worker_result" };
    const unit = result[0];
    if (unit.canBuild === false) return { reason: "not_buildable" };
    const source = unit.canBuild; // NOTE: source 0 is a valid TileRef
    if (!validTile(game, source) || game.ownerID(source) !== snapshot.player_id ||
        !game.isLand(source) || game.isImpassable(source) || !game.isShore(source)) {
      return { reason: "invalid_source" };
    }
    const gold = snapshot.me.gold?.();
    if (!validGold(gold)) return { reason: "invalid_gold" };
    if (gold < unit.cost) return { reason: "unaffordable" };
    return { source, cost: unit.cost, gold };
  }

  function reconcilePending(snapshot) {
    const boats = snapshot.me.units?.(transportUnit) ?? [];
    for (const [key, entry] of pending) {
      // A pre-existing boat to this target does NOT confirm our new intent.
      // UnitView.id()/targetTile() let us recognize a newly observed unit;
      // otherwise retain the hold until bounded explicit review.
      const observed = boats.some((boat) => {
        const id = boat.id?.();
        return Number.isInteger(id) && !entry.known_ids.has(id) &&
          boat.isActive?.() !== false && boat.targetTile?.() === entry.tile;
      });
      if (entry.map_id !== snapshot.map_id ||
          game.ownerID(entry.tile) === snapshot.player_id || observed ||
          snapshot.source_tick - entry.tick >= REVIEW_TICKS) {
        pending.delete(key);
      }
    }
  }

  return {
    /** Explicit, single-flight map/worker scan. Never invoke per land tick. */
    async propose({ mapId, maxCandidates = 16, maxCoastTiles = 256,
      maxPairs = 1024, maxWorkerChecks = 32 } = {}) {
      if (proposing) throw new Error("Naval proposal already in flight");
      bound(maxCandidates, "maxCandidates", 64);
      bound(maxCoastTiles, "maxCoastTiles", 4096);
      bound(maxPairs, "maxPairs", 4096);
      bound(maxWorkerChecks, "maxWorkerChecks", 128);
      proposing = true;
      proposal = null;
      permit = null;
      serial++;
      try {
        const started_at = performance.now();
        const me = game.myPlayer();
        const source_tick = game.ticks();
        const state = read();
        if (!me || state?.ready !== true || state.ended === true ||
            state.tick !== source_tick) throw new Error("Game is not ready for naval snapshot");
        const map_id = identity(game, mapId);
        const snapshot = { me, player_id: me.smallID(), source_tick,
          started_at, map_id, explicitMapId: mapId };
        const assertFresh = () => {
          if (!current(snapshot)) throw new Error(`Naval snapshot stale: ` +
            `source_tick=${source_tick} current_tick=${game.ticks()}`);
        };
        const spatial = analyzeSpatialMap(game, snapshot.player_id,
          { tick: source_tick, mapId: map_id });
        // The map might advance asynchronously between two explicit passes;
        // never combine topology from different ticks.
        assertFresh();
        if (game.ticks() !== source_tick) throw new Error("Naval geometry changed between passes");
        const naval = analyzeNavalSpatial(game, spatial, {
          maxCandidates: Math.min(128, Math.max(maxCandidates, maxWorkerChecks)),
          maxCoastTiles, maxPairs,
        });
        assertFresh();
        reconcilePending(snapshot);
        const counts = { coast_budget_unexamined: naval.reasons.coast_budget_unexamined,
          pair_budget_unexamined: naval.reasons.pair_budget_unexamined,
          geometry_shortlist_limit: naval.reasons.shortlist_limit,
          worker_unchecked: 0, shortlist_limit: 0,
          pending_intent: 0, cap_blocked: 0, invalid_target: 0,
          not_buildable: 0, invalid_worker_result: 0, invalid_source: 0,
          invalid_gold: 0, unaffordable: 0 };
        const candidates = [];
        const offered = new Map();
        let processed = 0;
        let workerChecked = 0;
        const limit = Math.min(naval.candidates.length, maxWorkerChecks);
        for (let i = 0; i < limit && candidates.length < maxCandidates; i++) {
          processed++;
          assertFresh();
          const site = naval.candidates[i];
          const key = `${map_id}:${site.target_shore_tile}`;
          if (pending.has(key)) { counts.pending_intent++; continue; }
          if (!fleetRoom(snapshot)) { counts.cap_blocked++; continue; }
          const live = target(snapshot, site.target_shore_tile, site.target_owner_id);
          if (!live) { counts.invalid_target++; continue; }
          workerChecked++;
          const checked = await checkedBoat(site.target_shore_tile, snapshot,
            site.target_owner_id, live.type);
          assertFresh();
          if (!checked) { counts.invalid_target++; continue; }
          if (checked.reason) { counts[checked.reason]++; continue; }
          if (!spatial.regionByTile[checked.source]) {
            counts.invalid_source++;
            continue;
          }
          const { source_shore_tile: _roughSource,
            target_shore_tile: _destination, id: _geometryId,
            status: geometry_status, ...features } = site;
          const sourceX = checked.source % game.width();
          const sourceY = Math.floor(checked.source / game.width());
          const targetX = site.target_shore_tile % game.width();
          const targetY = Math.floor(site.target_shore_tile / game.width());
          const id = `${spatial.snapshot_id}:boat${candidates.length + 1}`;
          candidates.push({ ...features, id, kind: "boat", target_type: live.type,
            status: "worker_checked_not_executed", geometry_status,
            source_region_id: spatial.regions[spatial.regionByTile[checked.source] - 1].id,
            water_span_estimate_tiles: Math.abs(sourceX - targetX) +
              Math.abs(sourceY - targetY),
            cost_gold: checked.cost.toString(),
            worker_source_confirmed: true });
          offered.set(id, { tile: site.target_shore_tile, owner: site.target_owner_id,
            type: live.type, source: checked.source, cost: checked.cost });
        }
        const unchecked = naval.candidates.length - processed;
        if (candidates.length >= maxCandidates) counts.shortlist_limit = unchecked;
        else counts.worker_unchecked = unchecked;
        assertFresh();
        const omitted_count = naval.total_eligible - candidates.length;
        if (Object.values(counts).reduce((sum, n) => sum + n, 0) !== omitted_count) {
          throw new Error("Naval omission accounting mismatch");
        }
        const boats = fleet(snapshot);
        const availableTroops = me.troops?.();
        if (!Number.isFinite(availableTroops) || availableTroops < 0 ||
            availableTroops > Number.MAX_SAFE_INTEGER) {
          throw new Error("Invalid available troops");
        }
        proposal = { ...snapshot, snapshot_id: spatial.snapshot_id, offered };
        return { snapshot_id: spatial.snapshot_id, source_tick,
          current_tick: game.ticks(), map_id,
          available_troops_internal: availableTroops,
          boats, candidates,
          coverage: { total_eligible: naval.total_eligible,
            worker_checked: workerChecked,
            offered_count: candidates.length,
            omitted_count,
            coast: naval.coast,
            certainty: naval.certainty },
          omissions: counts };
      } finally {
        proposing = false;
      }
    },

    async canExecute(candidateId, fraction) {
      permit = null;
      const thisCheck = ++serial;
      const snapshot = proposal && current(proposal) ? proposal : null;
      if (!snapshot || typeof candidateId !== "string") return false;
      const selected = snapshot.offered.get(candidateId);
      if (!selected || !allowedFraction(fraction, selected.type) ||
          pending.has(`${snapshot.map_id}:${selected.tile}`) || !fleetRoom(snapshot) ||
          !target(snapshot, selected.tile, selected.owner, selected.type)) return false;
      const troopState = troopsFor(snapshot, fraction, selected.type);
      if (!troopState) return false;
      const checked = await checkedBoat(selected.tile, snapshot, selected.owner, selected.type);
      if (thisCheck !== serial || !checked || checked.reason ||
          checked.source !== selected.source || checked.cost !== selected.cost ||
          !current(snapshot) || !fleetRoom(snapshot) ||
          !target(snapshot, selected.tile, selected.owner, selected.type) ||
          pending.has(`${snapshot.map_id}:${selected.tile}`) ||
          troopsFor(snapshot, fraction, selected.type)?.available !== troopState.available) return false;
      permit = { snapshot_id: snapshot.snapshot_id, id: candidateId,
        tick: game.ticks(), fraction, source: checked.source,
        cost: checked.cost, gold: checked.gold, troops: troopState.troops,
        available: troopState.available };
      return true;
    },

    async execute(candidateId, fraction, isCurrent = () => true) {
      const checkedPermit = permit;
      permit = null; // single use before any await, even on failed sends
      serial++;
      const stillCurrent = () => {
        try { return typeof isCurrent === "function" && isCurrent() === true; }
        catch { return false; }
      };
      if (!stillCurrent()) return false;
      const snapshot = proposal && current(proposal) ? proposal : null;
      const selected = snapshot?.offered.get(candidateId);
      if (!snapshot || !selected || !checkedPermit ||
          checkedPermit.snapshot_id !== snapshot.snapshot_id ||
          checkedPermit.id !== candidateId || checkedPermit.fraction !== fraction ||
          !current(snapshot, checkedPermit.tick) ||
          !allowedFraction(fraction, selected.type) || !fleetRoom(snapshot) ||
          pending.has(`${snapshot.map_id}:${selected.tile}`) ||
          !target(snapshot, selected.tile, selected.owner, selected.type)) return false;
      const freshTroops = troopsFor(snapshot, fraction, selected.type);
      if (!freshTroops || freshTroops.available !== checkedPermit.available ||
          freshTroops.troops !== checkedPermit.troops) return false;
      const checked = await checkedBoat(selected.tile, snapshot, selected.owner,
        selected.type, checkedPermit.tick);
      if (!checked || checked.reason || checked.source !== checkedPermit.source ||
          checked.cost !== checkedPermit.cost || checked.gold !== checkedPermit.gold ||
          !current(snapshot, checkedPermit.tick) || !stillCurrent() ||
          !fleetRoom(snapshot) ||
          !target(snapshot, selected.tile, selected.owner, selected.type) ||
          troopsFor(snapshot, fraction, selected.type)?.available !== checkedPermit.available) {
        return false;
      }
      const key = `${snapshot.map_id}:${selected.tile}`;
      if (pending.has(key)) return false;
      const known_ids = new Set((snapshot.me.units?.(transportUnit) ?? [])
        .map((boat) => boat.id?.()).filter((id) => Number.isInteger(id)));
      pending.set(key, { tile: selected.tile, tick: game.ticks(),
        map_id: snapshot.map_id, known_ids });
      if (!stillCurrent()) { pending.delete(key); return false; }
      // Callback accepts exact internal troop count and destination tile ref;
      // it must recheck live game readiness before emitting its normal intent.
      let outcome;
      try { outcome = sendBoat(selected.tile, checkedPermit.troops); }
      catch { return false; } // uncertain emission; retain pending
      if (outcome === false) pending.delete(key);
      return outcome === true;
    },
  };
}
