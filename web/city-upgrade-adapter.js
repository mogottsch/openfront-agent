// Future-only City level upgrade proposals. Explicit enumeration over OWN
// units, not a full map scan or a live 1 Hz decision path. No model input or
// direct core intent; an injected callback may later emit a normal intent.
const REVIEW_TICKS = 30;
let nextSnapshot = 1;

function bounded(value, label, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`Invalid ${label}`);
  }
}

function identity(game, mapId) {
  const gameId = game.gameID?.();
  if ((!gameId || typeof gameId !== "string") &&
      (!mapId || typeof mapId !== "string")) {
    throw new Error("City upgrade snapshot needs a game or explicit map ID");
  }
  return `${gameId || "local"}/${mapId || "map"}`;
}

const validGold = (n) => typeof n === "bigint" && n >= 0n;
const validId = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * `cityUnit` must be UnitType.City ("City"). `sendUpgrade(unit,unitId,1)`
 * must be a synchronous injected callback; this module itself never emits an
 * OpenFront intent. Only amount=1 is supported. read() provides
 * {ready,ended,tick}; proposal is explicitly invoked, not timer-driven.
 */
export function createCityUpgradeAdapter({ game, read, sendUpgrade, cityUnit }) {
  if (!game || typeof read !== "function" || typeof sendUpgrade !== "function" ||
      cityUnit !== "City") {
    throw new TypeError("City upgrade adapter needs game, read, sendUpgrade and UnitType.City");
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

  function allCities(me) {
    const units = me.units?.(cityUnit);
    if (!Array.isArray(units)) throw new Error("Own City unit view unavailable");
    return units;
  }

  function liveCity(unitId, snapshot, tile, level) {
    const units = allCities(snapshot.me);
    const unit = units.find((u) => u.id?.() === unitId);
    if (!unit || unit.tile?.() !== tile || unit.level?.() !== level ||
        unit.type?.() !== cityUnit || unit.isActive?.() !== true ||
        unit.isUnderConstruction?.() !== false ||
        unit.owner?.() !== snapshot.me ||
        !Number.isInteger(level) || level < 1 ||
        game.ownerID(tile) !== snapshot.player_id ||
        !game.isLand(tile) || game.isImpassable(tile)) return null;
    return unit;
  }

  async function checkedUpgrade(selected, snapshot, exactTick = null) {
    const { unitId, tile, level } = selected;
    if (!current(snapshot, exactTick) || !liveCity(unitId, snapshot, tile, level)) {
      return null;
    }
    const response = await snapshot.me.buildables(tile, [cityUnit]);
    if (!current(snapshot, exactTick) || !liveCity(unitId, snapshot, tile, level)) {
      return null;
    }
    if (!Array.isArray(response) || response.length !== 1 ||
        response[0]?.type !== cityUnit) return { reason: "invalid_worker_result" };
    const b = response[0];
    if (!validId(b.canUpgrade) || b.canUpgrade !== unitId) {
      return { reason: "wrong_upgrade_id" };
    }
    // Core BuildableUnit fills upgradeCosts[0] from the same unitInfo.cost
    // used by cost for the first upgrade. Reject inconsistent worker data,
    // never fall back to linear pricing or silently choose a different unit.
    if (!validGold(b.cost) || !Array.isArray(b.upgradeCosts) ||
        !validGold(b.upgradeCosts[0]) || b.cost !== b.upgradeCosts[0]) {
      return { reason: "invalid_worker_cost" };
    }
    const gold = snapshot.me.gold?.();
    if (!validGold(gold)) return { reason: "invalid_gold" };
    if (gold < b.upgradeCosts[0]) return { reason: "unaffordable" };
    return { cost: b.upgradeCosts[0], gold };
  }

  function reconcile(snapshot, units) {
    for (const [key, p] of pending) {
      const city = units.find((u) => u.id?.() === p.unitId);
      if (p.map_id !== snapshot.map_id ||
          (city && city.level?.() > p.level) ||
          snapshot.source_tick - p.tick >= REVIEW_TICKS) pending.delete(key);
    }
  }

  return {
    async propose({ mapId, maxCandidates = 24, maxExamined = 256,
      maxWorkerChecks = 48 } = {}) {
      if (proposing) throw new Error("City upgrade proposal already in flight");
      bounded(maxCandidates, "maxCandidates", 64);
      bounded(maxExamined, "maxExamined", 65536);
      bounded(maxWorkerChecks, "maxWorkerChecks", 128);
      proposing = true;
      proposal = null;
      permit = null;
      serial++;
      try {
        const me = game.myPlayer();
        const source_tick = game.ticks();
        const state = read();
        if (!me || state?.ready !== true || state.ended === true ||
            state.tick !== source_tick) {
          throw new Error("Game is not ready for City upgrade proposal");
        }
        const map_id = identity(game, mapId);
        const snapshot_id = `${map_id}@${source_tick}#${nextSnapshot++}`;
        const snapshot = { me, player_id: me.smallID(), source_tick,
          started_at: performance.now(), map_id, explicitMapId: mapId };
        const assertFresh = () => {
          if (!current(snapshot)) throw new Error(`City upgrade snapshot stale: ` +
            `source_tick=${source_tick} current_tick=${game.ticks()}`);
        };
        const units = allCities(me);
        reconcile(snapshot, units);
        // Stable unit-ID order makes the budget independent of unitsOwnedBy's
        // frame ordering; it is NOT a usefulness ranking or action policy.
        const ordered = units.toSorted((a, b) => (a.id?.() ?? Infinity) -
          (b.id?.() ?? Infinity));
        const scanned = ordered.slice(0, maxExamined);
        const counts = { enumeration_capped: ordered.length - scanned.length,
          worker_unchecked: 0, shortlist_limit: 0,
          pending_intent: 0, incomplete_or_invalid: 0, wrong_upgrade_id: 0,
          invalid_worker_result: 0, invalid_worker_cost: 0,
          invalid_gold: 0, unaffordable: 0, unaffordable_after_check: 0 };
        const offered = new Map();
        const candidates = [];
        let processed = 0;
        let workerChecked = 0;
        const limit = Math.min(scanned.length, maxWorkerChecks);
        for (let i = 0; i < limit && candidates.length < maxCandidates; i++) {
          processed++;
          assertFresh();
          const city = scanned[i];
          const unitId = city.id?.();
          const tile = city.tile?.();
          const level = city.level?.();
          if (!validId(unitId) || !Number.isInteger(tile) ||
              !Number.isInteger(level) || level < 1 ||
              tile < 0 || tile >= game.width() * game.height() ||
              !liveCity(unitId, snapshot, tile, level)) {
            counts.incomplete_or_invalid++;
            continue;
          }
          const key = `${map_id}:${unitId}`;
          if (pending.has(key)) { counts.pending_intent++; continue; }
          const selected = { unitId, tile, level };
          workerChecked++;
          const checked = await checkedUpgrade(selected, snapshot);
          assertFresh();
          if (!checked) { counts.incomplete_or_invalid++; continue; }
          if (checked.reason) { counts[checked.reason]++; continue; }
          const id = `${snapshot_id}:uc${candidates.length + 1}`;
          candidates.push({ id, kind: "upgrade_city", amount: 1,
            current_level: level, cost_gold: checked.cost.toString() });
          offered.set(id, { ...selected, cost: checked.cost });
        }
        const unchecked = scanned.length - processed;
        if (candidates.length >= maxCandidates) counts.shortlist_limit = unchecked;
        else counts.worker_unchecked = unchecked;
        assertFresh();
        const availableGold = me.gold?.();
        if (!validGold(availableGold)) throw new Error("Invalid current gold");
        for (let i = candidates.length - 1; i >= 0; i--) {
          const c = candidates[i];
          const cost = offered.get(c.id).cost;
          if (cost > availableGold) {
            counts.unaffordable_after_check++;
            offered.delete(c.id);
            candidates.splice(i, 1);
          } else c.gold_after_estimate = (availableGold - cost).toString();
        }
        const total = ordered.length;
        const omitted_count = total - candidates.length;
        if (Object.values(counts).reduce((sum, n) => sum + n, 0) !== omitted_count) {
          throw new Error("City upgrade omission accounting mismatch");
        }
        const save_gold = { id: `${snapshot_id}:save_gold`, kind: "save_gold" };
        proposal = { ...snapshot, snapshot_id, availableGold,
          offered, saveId: save_gold.id };
        const complete = units.filter((u) => u.isActive?.() === true &&
          u.isUnderConstruction?.() === false).length;
        const constructing = units.filter((u) =>
          u.isUnderConstruction?.() === true).length;
        return { snapshot_id, source_tick, current_tick: game.ticks(),
          map_id, available_gold: availableGold.toString(),
          counts: { owned: total, completed: complete,
            under_construction: constructing,
            pending_unconfirmed: [...pending.values()].filter((p) =>
              p.map_id === map_id).length },
          candidates, save_gold,
          coverage: { total_owned: total, total_examined: scanned.length,
            worker_checked: workerChecked,
            offered_count: candidates.length, omitted_count },
          omissions: counts };
      } finally {
        proposing = false;
      }
    },

    async canExecute(candidateId) {
      permit = null;
      const check = ++serial;
      const snapshot = proposal && current(proposal) ? proposal : null;
      if (!snapshot || typeof candidateId !== "string") return false;
      if (candidateId === snapshot.saveId) return true;
      const selected = snapshot.offered.get(candidateId);
      if (!selected || pending.has(`${snapshot.map_id}:${selected.unitId}`)) return false;
      const checked = await checkedUpgrade(selected, snapshot);
      if (check !== serial || !checked || checked.reason ||
          checked.cost !== selected.cost || checked.gold !== snapshot.availableGold ||
          !current(snapshot) || pending.has(`${snapshot.map_id}:${selected.unitId}`)) {
        return false;
      }
      permit = { snapshot_id: snapshot.snapshot_id, id: candidateId,
        tick: game.ticks(), gold: checked.gold, unitId: selected.unitId,
        tile: selected.tile, level: selected.level };
      return true;
    },

    async execute(candidateId, isCurrent = () => true) {
      const checkedPermit = permit;
      permit = null; // consume before any await, including failed sends
      serial++;
      const stillCurrent = () => {
        try { return typeof isCurrent === "function" && isCurrent() === true; }
        catch { return false; }
      };
      if (!stillCurrent()) return false;
      const snapshot = proposal && current(proposal) ? proposal : null;
      if (!snapshot || typeof candidateId !== "string") return false;
      if (candidateId === snapshot.saveId) return true; // explicit no-op
      const selected = snapshot.offered.get(candidateId);
      if (!selected || !checkedPermit ||
          checkedPermit.snapshot_id !== snapshot.snapshot_id ||
          checkedPermit.id !== candidateId ||
          checkedPermit.unitId !== selected.unitId ||
          checkedPermit.tile !== selected.tile ||
          checkedPermit.level !== selected.level ||
          !current(snapshot, checkedPermit.tick) ||
          pending.has(`${snapshot.map_id}:${selected.unitId}`)) return false;
      const result = await checkedUpgrade(selected, snapshot, checkedPermit.tick);
      if (!result || result.reason || result.cost !== selected.cost ||
          result.gold !== checkedPermit.gold ||
          !current(snapshot, checkedPermit.tick) || !stillCurrent() ||
          !liveCity(selected.unitId, snapshot, selected.tile, selected.level)) {
        return false;
      }
      const key = `${snapshot.map_id}:${selected.unitId}`;
      if (pending.has(key)) return false;
      pending.set(key, { map_id: snapshot.map_id, unitId: selected.unitId,
        tick: game.ticks(), level: selected.level });
      if (!stillCurrent()) { pending.delete(key); return false; }
      let outcome;
      try { outcome = sendUpgrade(cityUnit, selected.unitId, 1); }
      catch { return false; } // possible emitted intent: retain pending
      if (outcome === false) pending.delete(key);
      return outcome === true;
    },
  };
}
