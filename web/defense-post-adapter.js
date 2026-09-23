// Future-only Defense Post placement study. No live controller imports this;
// whole-map geometry runs only on an explicit propose() call, never at 1 Hz.
// An attacker's observed ID is NOT an observed AttackExecution path. Geometry
// estimates potential land-border/territory coverage, not tactical protection.
import { analyzeSpatialMap, prefilterPlacementSites } from "./spatial-map.js";

function bounded(value, name, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`Invalid ${name}`);
  }
}

function identity(game, mapId) {
  const id = game.gameID?.();
  if ((!id || typeof id !== "string") && (!mapId || typeof mapId !== "string")) {
    throw new Error("Defense Post snapshot needs game or explicit map ID");
  }
  return `${id || "local"}/${mapId || "map"}`;
}

function validGold(gold) {
  return typeof gold === "bigint" && gold >= 0n;
}

function positions(game, player, defenseUnit) {
  const units = player.units?.(defenseUnit) ?? [];
  const active = [];
  const constructing = [];
  const unknown = [];
  for (const unit of units) {
    const status = unit.isActive?.();
    if (status === false) continue;
    const tile = unit.tile?.();
    if (!Number.isInteger(tile) || tile < 0 ||
        tile >= game.width() * game.height()) continue;
    if (status !== true) unknown.push(tile);
    else if (unit.isUnderConstruction?.() === false) active.push(tile);
    else if (unit.isUnderConstruction?.() === true) constructing.push(tile);
    else unknown.push(tile); // never claim it already provides coverage
  }
  return { active, constructing, unknown };
}

function sourceMechanics(game, defenseUnit) {
  const config = game.config?.();
  const range = config?.defensePostRange?.();
  if (!Number.isInteger(range) || range < 0 || range > 2048) {
    throw new Error("Defense Post range unavailable or invalid");
  }
  const duration = config.unitInfo?.(defenseUnit)?.constructionDuration;
  return { range, construction_ticks: Number.isInteger(duration) && duration >= 0 ?
    duration : null };
}

function squaredDistance(width, a, b) {
  const dx = a % width - b % width;
  const dy = Math.floor(a / width) - Math.floor(b / width);
  return dx * dx + dy * dy;
}

function hostileFrontContacts(game, spatial, me, incomingIDs) {
  const contacts = [];
  const touchingIDs = new Set();
  for (const front of spatial.fronts) {
    if (front.kind !== "player") continue;
    let other;
    try { other = game.playerBySmallID(front.target_id); }
    catch { continue; }
    if (!other?.isPlayer?.() || !other.isAlive?.() ||
        typeof me.isFriendly !== "function" ||
        typeof other.isFriendly !== "function" ||
        me.isFriendly(other) || other.isFriendly(me) ||
        me.isOnSameTeam?.(other) || other.isOnSameTeam?.(me)) continue;
    touchingIDs.add(front.target_id);
    for (const tile of front.tiles) {
      contacts.push({ tile, owner_id: front.target_id,
        incoming_contact: incomingIDs.has(front.target_id) });
    }
  }
  return { contacts, touchingIDs };
}

/**
 * `defenseUnit` is upstream UnitType.DefensePost ("Defense Post"). `sendBuild`
 * is an injected synchronous `(unit,tile)=>boolean`; this module never emits
 * a core intent itself. read() supplies `{ready,ended,tick}`. Returned site
 * IDs are opaque; the tile remains private until a later fresh worker check.
 */
export function createDefensePostAdapter({ game, read, sendBuild, defenseUnit }) {
  if (!game || typeof read !== "function" || typeof sendBuild !== "function" ||
      defenseUnit !== "Defense Post") {
    throw new TypeError("Defense Post adapter needs GameView, read, sendBuild and UnitType.DefensePost");
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

  function owns(tile, snapshot) {
    return game.isLand(tile) && !game.isImpassable(tile) &&
      game.ownerID(tile) === snapshot.player_id;
  }

  function occupied(tile, snapshot) {
    const sites = positions(game, snapshot.me, defenseUnit);
    return [...sites.active, ...sites.constructing, ...sites.unknown].includes(tile);
  }

  async function checkedPost(tile, snapshot, exactTick = null) {
    if (!current(snapshot, exactTick) || !owns(tile, snapshot)) return null;
    if (occupied(tile, snapshot)) return { reason: "occupied_post" };
    const result = await snapshot.me.buildables(tile, [defenseUnit]);
    if (!current(snapshot, exactTick) || !owns(tile, snapshot)) return null;
    if (occupied(tile, snapshot)) return { reason: "occupied_post" };
    if (!Array.isArray(result) || result.length !== 1 ||
        result[0]?.type !== defenseUnit || !validGold(result[0]?.cost)) {
      return { reason: "invalid_worker_result" };
    }
    const unit = result[0];
    if (unit.canUpgrade !== false) return { reason: "upgrade_not_build" };
    if (unit.canBuild === false) return { reason: "not_buildable" };
    if (unit.canBuild !== tile) return { reason: "relocated" };
    const gold = snapshot.me.gold?.();
    if (!validGold(gold)) return { reason: "invalid_gold" };
    if (gold < unit.cost) return { reason: "unaffordable" };
    return { cost: unit.cost, gold };
  }

  function reconcilePending(snapshot) {
    const sites = positions(game, snapshot.me, defenseUnit);
    const visible = new Set([...sites.active, ...sites.constructing, ...sites.unknown]);
    const reviewTicks = Math.max(30, (snapshot.construction_ticks ?? 50) + 10);
    for (const [key, entry] of pending) {
      if (entry.map_id !== snapshot.map_id || visible.has(entry.tile) ||
          snapshot.source_tick - entry.tick >= reviewTicks) {
        pending.delete(key);
      }
    }
  }

  return {
    async propose({ mapId, maxCandidates = 24, maxExamined = 4096,
      maxWorkerChecks = 48 } = {}) {
      if (proposing) throw new Error("Defense Post proposal already in flight");
      bounded(maxCandidates, "maxCandidates", 64);
      bounded(maxExamined, "maxExamined", 65536);
      bounded(maxWorkerChecks, "maxWorkerChecks", 128);
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
            state.tick !== source_tick) throw new Error("Game is not ready for Defense Post snapshot");
        const map_id = identity(game, mapId);
        const { range, construction_ticks } = sourceMechanics(game, defenseUnit);
        const snapshot = { me, player_id: me.smallID(), source_tick,
          started_at, map_id, explicitMapId: mapId, construction_ticks };
        const assertFresh = () => {
          if (!current(snapshot)) throw new Error(`Defense Post snapshot stale: ` +
            `source_tick=${source_tick} current_tick=${game.ticks()}`);
        };
        const spatial = analyzeSpatialMap(game, snapshot.player_id,
          { tick: source_tick, mapId: map_id });
        assertFresh();
        reconcilePending(snapshot);
        const sites = positions(game, me, defenseUnit);
        const incoming = me.incomingAttacks?.() ?? [];
        const observedIDs = new Set(incoming.filter((attack) =>
          Number.isInteger(attack.attackerID) && attack.attackerID > 0)
          .map((attack) => attack.attackerID));
        // Keep retreating IDs visible as facts, but exclude their contacts
        // from the non-retreating potential-pressure coverage estimate.
        const incomingIDs = new Set(incoming.filter((attack) =>
          !attack.retreating && Number.isInteger(attack.attackerID) &&
          attack.attackerID > 0).map((attack) => attack.attackerID));
        const { contacts, touchingIDs } = hostileFrontContacts(game, spatial, me, incomingIDs);
        const radius2 = range * range;
        const activeCoverage = (tile) => sites.active.some((post) =>
          squaredDistance(game.width(), tile, post) <= radius2);
        const uncovered = contacts.filter((contact) => !activeCoverage(contact.tile));
        const prefilterRadius = Math.min(range, Math.max(game.width(), game.height()));
        const filtered = prefilterPlacementSites(spatial, {
          existingSites: sites.active, coverageRadius: prefilterRadius,
          maxExamined,
          maxCandidates: Math.min(512, Math.max(maxCandidates, maxWorkerChecks)),
        });
        // The shared prefilter caps radius at max(width,height). On a tiny
        // synthetic map with a larger configured range, recompute marginal
        // own-land coverage at the actual radius rather than understating it.
        const uncoveredOwned = range > prefilterRadius ?
          spatial.ownedTiles.filter((tile) => !activeCoverage(tile)) : null;
        const geometry = filtered.candidates.map((site) => {
          let hostile = 0;
          let incomingContacts = 0;
          const matched = new Set();
          for (const contact of uncovered) {
            if (squaredDistance(game.width(), site.tile, contact.tile) > radius2) continue;
            hostile++;
            if (contact.incoming_contact) {
              incomingContacts++;
              matched.add(contact.owner_id);
            }
          }
          const ownedCoverage = uncoveredOwned ? uncoveredOwned.filter((tile) =>
            squaredDistance(game.width(), site.tile, tile) <= radius2).length :
            site.marginal_coverage_tiles;
          return { ...site, marginal_owned_territory_tiles: ownedCoverage,
            marginal_hostile_front_contacts: hostile,
            marginal_potential_incoming_front_contacts: incomingContacts,
            potential_incoming_contact_ids: [...matched].sort((a, b) => a - b) };
        });
        // Diversity prefilter only, not an automatic build decision: keep one
        // per region, observed-incoming-contact cohort and nearest front, then
        // the remaining worker-check budget in the spatial prefilter order.
        const ordered = [];
        const seen = new Set();
        const add = (site) => {
          if (site && !seen.has(site.id)) { seen.add(site.id); ordered.push(site); }
        };
        const group = (keyOf) => {
          const first = new Map();
          for (const site of geometry) {
            for (const key of keyOf(site)) if (!first.has(key)) first.set(key, site);
          }
          for (const site of first.values()) add(site);
        };
        group((site) => [site.region_id]);
        group((site) => site.potential_incoming_contact_ids);
        group((site) => site.front_id ? [site.front_id] : []);
        for (const site of geometry) add(site);
        const counts = { not_examined: filtered.reasons.not_examined,
          geometry_shortlist_limit: filtered.reasons.shortlist_limit,
          worker_unchecked: 0, shortlist_limit: 0,
          pending_intent: 0, occupied_post: 0, not_buildable: 0,
          relocated: 0, upgrade_not_build: 0, unaffordable: 0,
          unaffordable_after_check: 0, invalid_worker_result: 0,
          invalid_gold: 0 };
        const candidates = [];
        const offered = new Map();
        let processed = 0;
        let workerChecked = 0;
        const limit = Math.min(ordered.length, maxWorkerChecks);
        for (let i = 0; i < limit && candidates.length < maxCandidates; i++) {
          processed++;
          const site = ordered[i];
          assertFresh();
          if (pending.has(`${map_id}:${site.tile}`)) { counts.pending_intent++; continue; }
          if (occupied(site.tile, snapshot)) { counts.occupied_post++; continue; }
          workerChecked++;
          const checked = await checkedPost(site.tile, snapshot);
          assertFresh();
          if (!checked) { counts.not_buildable++; continue; }
          if (checked.reason) { counts[checked.reason]++; continue; }
          const { tile, id: _rawId, marginal_coverage_tiles: _genericCoverage,
            ...features } = site;
          const id = `${spatial.snapshot_id}:dp${candidates.length + 1}`;
          candidates.push({ ...features, id, kind: "build_defense_post",
            cost_gold: checked.cost.toString() });
          offered.set(id, { tile, cost: checked.cost });
        }
        const unvisited = ordered.length - processed;
        if (candidates.length >= maxCandidates) counts.shortlist_limit = unvisited;
        else counts.worker_unchecked = unvisited;
        assertFresh();
        const availableGold = me.gold?.();
        if (!validGold(availableGold)) throw new Error("Invalid current gold");
        for (let i = candidates.length - 1; i >= 0; i--) {
          const candidate = candidates[i];
          const cost = offered.get(candidate.id).cost;
          if (cost > availableGold) {
            counts.unaffordable_after_check++;
            offered.delete(candidate.id);
            candidates.splice(i, 1);
          } else candidate.gold_after_estimate = (availableGold - cost).toString();
        }
        const omitted_count = filtered.total_eligible - candidates.length;
        if (Object.values(counts).reduce((sum, n) => sum + n, 0) !== omitted_count) {
          throw new Error("Defense Post omission accounting mismatch");
        }
        const save_gold = { id: `${spatial.snapshot_id}:save_gold`, kind: "save_gold" };
        proposal = { ...snapshot, snapshot_id: spatial.snapshot_id,
          offered, availableGold, saveId: save_gold.id };
        return { snapshot_id: spatial.snapshot_id, source_tick,
          current_tick: game.ticks(), map_id,
          available_gold: availableGold.toString(),
          mechanics: { range_tiles: range, construction_ticks,
            coverage_model: "Euclidean radius on own land/front contacts; active completed posts only, not promised combat protection" },
          posts: { active_completed: sites.active.length,
            under_construction: sites.constructing.length,
            status_unknown: sites.unknown.length,
            pending_unconfirmed: [...pending.values()].filter((p) => p.map_id === map_id).length },
          incoming: { observed_attacker_ids: [...observedIDs].sort((a, b) => a - b),
            non_retreating_attacker_ids: [...incomingIDs].sort((a, b) => a - b),
            ids_without_land_contact: [...observedIDs].filter((id) => !touchingIDs.has(id)).sort((a, b) => a - b),
            contact_is_only_potential: true },
          candidates, save_gold,
          coverage: { total_eligible: filtered.total_eligible,
            total_examined: filtered.total_examined,
            worker_checked: workerChecked,
            offered_count: candidates.length,
            omitted_count,
            uncovered_hostile_front_contacts: uncovered.length,
            uncovered_potential_incoming_front_contacts:
              uncovered.filter((contact) => contact.incoming_contact).length },
          omissions: counts };
      } finally {
        proposing = false;
      }
    },

    async canExecute(candidateId) {
      permit = null;
      const checking = ++serial;
      const snapshot = proposal && current(proposal) ? proposal : null;
      if (!snapshot || typeof candidateId !== "string") return false;
      if (candidateId === snapshot.saveId) return true;
      const selected = snapshot.offered.get(candidateId);
      if (!selected || pending.has(`${snapshot.map_id}:${selected.tile}`)) return false;
      const checked = await checkedPost(selected.tile, snapshot);
      if (checking !== serial || !checked || checked.reason ||
          checked.cost !== selected.cost || checked.gold !== snapshot.availableGold ||
          !current(snapshot) || pending.has(`${snapshot.map_id}:${selected.tile}`)) return false;
      permit = { snapshot_id: snapshot.snapshot_id, id: candidateId,
        tick: game.ticks(), cost: checked.cost, gold: checked.gold, tile: selected.tile };
      return true;
    },

    async execute(candidateId, isCurrent = () => true) {
      const checkedPermit = permit;
      permit = null;
      serial++;
      const stillCurrent = () => {
        try { return typeof isCurrent === "function" && isCurrent() === true; }
        catch { return false; }
      };
      if (!stillCurrent()) return false;
      const snapshot = proposal && current(proposal) ? proposal : null;
      if (!snapshot || typeof candidateId !== "string") return false;
      if (candidateId === snapshot.saveId) return true; // no worker / intent
      const selected = snapshot.offered.get(candidateId);
      if (!selected || !checkedPermit ||
          checkedPermit.snapshot_id !== snapshot.snapshot_id ||
          checkedPermit.id !== candidateId || checkedPermit.tile !== selected.tile ||
          !current(snapshot, checkedPermit.tick) ||
          pending.has(`${snapshot.map_id}:${selected.tile}`)) return false;
      const checked = await checkedPost(selected.tile, snapshot, checkedPermit.tick);
      if (!checked || checked.reason || checked.cost !== selected.cost ||
          checked.gold !== checkedPermit.gold || !current(snapshot, checkedPermit.tick) ||
          !owns(selected.tile, snapshot) || !stillCurrent()) return false;
      const key = `${snapshot.map_id}:${selected.tile}`;
      if (pending.has(key)) return false;
      pending.set(key, { tile: selected.tile, map_id: snapshot.map_id,
        tick: game.ticks() });
      if (!stillCurrent()) { pending.delete(key); return false; }
      let outcome;
      try { outcome = sendBuild(defenseUnit, selected.tile); }
      catch { return false; } // ambiguous emission: keep pending until review
      if (outcome === false) pending.delete(key);
      return outcome === true;
    },
  };
}
