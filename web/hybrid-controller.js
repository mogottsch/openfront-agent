// Opt-in local hybrid controller. Land-only decisions retain the existing
// single-flight 1 Hz loop; a full-map City scan is explicit and infrequent.
// Build decisions can act only on the currently registered opaque candidate.
import { LandController } from "./controller.js";
import {
  actionCriteria,
  buildActions,
  modelState,
  validateObservation,
} from "./observation.js";
import {
  hybridChoices,
  hybridModelState,
  validateHybridInput,
} from "./hybrid-observation.js";

export class HybridController extends LandController {
  constructor(
    landAdapter,
    buildingAdapter,
    {
      decideLand,
      decideHybrid,
      gameId,
      mapId,
      existingCityTiles,
      cityMechanics,
      cityScanIntervalMs = 15000,
      onUpdate = () => {},
      ...clock
    },
  ) {
    super(landAdapter, { decide: decideLand, onUpdate, ...clock });
    if (
      !buildingAdapter ||
      typeof decideLand !== "function" ||
      typeof decideHybrid !== "function" ||
      typeof gameId !== "function" ||
      typeof mapId !== "function" ||
      typeof existingCityTiles !== "function" ||
      typeof cityMechanics !== "function" ||
      !Number.isInteger(cityScanIntervalMs) ||
      cityScanIntervalMs < 5000
    ) {
      throw new Error("Invalid hybrid controller dependencies");
    }
    this.buildingAdapter = buildingAdapter;
    this.decideHybrid = decideHybrid;
    this.gameId = gameId;
    this.mapId = mapId;
    this.existingCityTiles = existingCityTiles;
    this.cityMechanics = cityMechanics;
    this.cityScanIntervalMs = cityScanIntervalMs;
    this.nextCityScanAt = 0;
    this.cityProposal = null;
    this.cityProposalAt = -Infinity;
  }

  start(settings) {
    this.cityProposal = null;
    this.cityProposalAt = -Infinity;
    this.nextCityScanAt = 0;
    super.start(settings);
  }

  async scanCitySites(isCurrent) {
    if (this.now() < this.nextCityScanAt) return;
    this.nextCityScanAt = this.now() + this.cityScanIntervalMs;
    this.cityProposal = null;
    try {
      const proposal = await this.buildingAdapter.propose({
        mapId: this.mapId(),
        existingSites: this.existingCityTiles(),
        // Full-map scan once per interval, not at 1 Hz. Every omission is
        // reported by the adapter; this is NOT an optimal placement oracle.
        maxCandidates: 4,
        maxExamined: 512,
        maxWorkerChecks: 12,
      });
      if (!isCurrent()) return;
      this.cityProposal = proposal;
      this.cityProposalAt = this.now();
      this.onUpdate({
        status: `City sites checked: ${proposal.candidates.length} offered; ${proposal.coverage.omitted_count} omitted`,
        cityScan: {
          offered: proposal.candidates.length,
          available_gold: proposal.available_gold,
          total_eligible: proposal.coverage.total_eligible,
          worker_checked: proposal.coverage.worker_checked,
          omitted: proposal.coverage.omitted_count,
          reasons: proposal.omissions,
        },
      });
    } catch (error) {
      if (isCurrent())
        this.onUpdate({
          status: `City scan unavailable: ${error.message}; next choice is land-only`,
          cityScan: { error: error.message },
        });
    }
  }

  async step() {
    if (!this.running || this.busy) return;
    if (this.now() < this.nextAllowedStart) {
      this.scheduleAt(this.nextAllowedStart);
      return;
    }
    const generation = this.generation;
    const isCurrent = () => this.running && generation === this.generation;
    this.busy = true;
    let wakeAt = this.now() + this.intervalMs;
    try {
      const current = this.adapter.read();
      if (current.ended) {
        this.stop("Game ended");
        return;
      }
      if (!current.ready || current.tick === this.lastTick) {
        this.onUpdate({ status: "Waiting for active play / advancing ticks" });
        return;
      }
      await this.scanCitySites(isCurrent);
      if (!isCurrent()) return;
      const observedAt = this.now();
      const snapshot = await this.adapter.observe();
      if (!isCurrent()) return;
      if (!this.fresh(snapshot.tick, observedAt)) {
        this.onUpdate({ status: "Discarded stale land observation" });
        return;
      }
      const land = validateObservation(snapshot.observation);
      const landActions = buildActions(land);
      let input = null;
      // The City proposal is valid only within its own 2s / 20-tick window.
      // If none exists, the panel explicitly reports land-only rather than
      // silently presenting a stale City as a viable option.
      if (
        this.cityProposal &&
        this.now() - this.cityProposalAt <= 1500 &&
        snapshot.tick - this.cityProposal.source_tick <= 20 &&
        snapshot.tick >= this.cityProposal.current_tick
      ) {
        try {
          input = validateHybridInput({
            game_id: this.gameId(),
            snapshot_tick: snapshot.tick,
            land,
            building: this.cityProposal,
            city_mechanics: this.cityMechanics(),
            plan: null,
          });
        } catch (error) {
          this.onUpdate({
            status: `Discarded invalid City proposal: ${error.message}; land-only`,
          });
        }
      }
      const hybrid = input && input.building.candidates.length > 0;
      const offered = hybrid ? hybridChoices(input) : null;
      const state = hybrid ? hybridModelState(input) : modelState(land);
      const criteria = hybrid
        ? {
            branch: offered.branch,
            land_action: actionCriteria(offered.land),
            city_site: offered.city,
          }
        : actionCriteria(landActions);
      this.onUpdate({
        state,
        actions: criteria,
        mode: hybrid
          ? "city opportunity + land"
          : "land only (no fresh legal City sites)",
      });
      if (Object.keys(landActions).length === 1 && !hybrid) {
        this.onUpdate({
          status: "Waiting for legal land actions and next City scan",
        });
        return;
      }
      this.lastTick = snapshot.tick;
      this.abort = new AbortController();
      this.count++;
      this.onUpdate({
        status: hybrid
          ? "Asking Jev: land / City / wait"
          : "Asking Jev: land only",
        count: this.count,
      });
      const requestedAt = this.now();
      this.nextAllowedStart = requestedAt + this.intervalMs;
      wakeAt = this.nextAllowedStart;
      const decision = hybrid
        ? await this.decideHybrid(input, this.abort.signal)
        : await this.decide(land, this.abort.signal);
      if (!isCurrent()) return;
      let outcome = "no-op";
      let chosen = null;
      if (!this.fresh(snapshot.tick, observedAt)) {
        outcome =
          "discarded: state unavailable or observation older than 2 seconds";
      } else if (hybrid) {
        const expectedContext = {
          game_id: input.game_id,
          snapshot_tick: snapshot.tick,
          building_snapshot_id: input.building.snapshot_id,
          plan_version: null,
        };
        if (
          !decision.context ||
          Object.keys(expectedContext).some(
            (k) => decision.context[k] !== expectedContext[k],
          )
        ) {
          outcome = "discarded: game, snapshot or plan changed";
        } else if (decision.kind === "city") {
          const site = offered.city[decision.selected];
          if (
            !site ||
            !site.candidate_id ||
            site.candidate_id !== decision.candidate_id
          )
            throw new Error("Model City choice was not an offered site");
          chosen = site;
          const legal = await this.buildingAdapter.canExecute(
            site.candidate_id,
          );
          if (!isCurrent()) return;
          if (!this.fresh(snapshot.tick, observedAt))
            outcome = "discarded: City snapshot changed";
          else if (!legal) outcome = "discarded: City no longer buildable";
          else
            outcome = (await this.buildingAdapter.execute(
              site.candidate_id,
              isCurrent,
            ))
              ? "City build intent sent"
              : "City intent not sent";
        } else if (decision.kind === "land") {
          chosen = offered.land[decision.selected];
          if (!chosen || chosen.kind !== "attack")
            throw new Error("Model land choice was not an offered attack");
          const legal = await this.adapter.canExecute(chosen);
          if (!isCurrent()) return;
          if (!this.fresh(snapshot.tick, observedAt))
            outcome = "discarded: land snapshot changed";
          else if (!legal) outcome = "discarded: target no longer legal";
          else
            outcome = this.adapter.execute(chosen)
              ? "land attack intent sent"
              : "not sent";
        } else if (
          decision.kind !== "wait" ||
          !["wait", "save_gold"].includes(decision.selected)
        ) {
          throw new Error("Model hybrid decision was not an offered wait");
        }
      } else {
        chosen = landActions[decision.action];
        if (!chosen)
          throw new Error("Model selected an action outside this observation");
        if (chosen.kind === "attack") {
          const legal = await this.adapter.canExecute(chosen);
          if (!isCurrent()) return;
          if (!this.fresh(snapshot.tick, observedAt))
            outcome = "discarded: land snapshot changed";
          else if (!legal) outcome = "discarded: target no longer legal";
          else
            outcome = this.adapter.execute(chosen)
              ? "land attack intent sent"
              : "not sent";
        }
      }
      if (!isCurrent()) return;
      this.onUpdate({
        status: outcome,
        count: this.count,
        decision: {
          ...decision,
          action: decision.selected ?? decision.action,
          observation: state,
          selected: chosen,
          tick: snapshot.tick,
          mode: hybrid ? "hybrid" : "land",
          outcome,
        },
      });
      if (this.count >= this.limit)
        this.stop(`Request limit reached (${this.limit})`);
    } catch (error) {
      if (isCurrent()) this.stop(`Stopped: ${error.message}`);
    } finally {
      this.busy = false;
      if (this.running)
        this.scheduleAt(isCurrent() ? wakeAt : this.nextAllowedStart);
    }
  }
}
