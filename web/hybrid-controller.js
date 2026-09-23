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
      planClient = null,
      navalAdapter = null,
      cityScanIntervalMs = 15000,
      navalScanIntervalMs = 15000,
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
      (navalAdapter !== null &&
        !["propose", "canExecute", "execute"].every(
          (name) => typeof navalAdapter[name] === "function",
        )) ||
      (planClient !== null &&
        !["plan", "heartbeat", "getPlan", "stop"].every(
          (name) => typeof planClient[name] === "function",
        )) ||
      !Number.isInteger(cityScanIntervalMs) ||
      cityScanIntervalMs < 5000 ||
      !Number.isInteger(navalScanIntervalMs) ||
      navalScanIntervalMs < 5000
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
    this.planClient = planClient;
    this.navalAdapter = navalAdapter;
    this.navalScanIntervalMs = navalScanIntervalMs;
    this.nextNavalScanAt = 0;
    this.navalProposal = null;
    this.navalProposalAt = -Infinity;
    this.planAttempted = false;
    this.planFailed = false;
    this.planAbort = null;
    this.nextCityScanAt = 0;
    this.cityProposal = null;
    this.cityProposalAt = -Infinity;
  }

  setNavalAdapter(adapter) {
    if (
      this.running ||
      !adapter ||
      !["propose", "canExecute", "execute"].every(
        (name) => typeof adapter[name] === "function",
      )
    )
      throw new Error("Cannot change naval adapter during an active run");
    this.navalAdapter = adapter;
  }

  setPlanClient(client) {
    if (
      this.running ||
      !client ||
      !["plan", "heartbeat", "getPlan", "stop"].every(
        (name) => typeof client[name] === "function",
      )
    )
      throw new Error("Cannot change the planner during an active run");
    this.planClient = client;
  }

  start(settings) {
    this.cityProposal = null;
    this.cityProposalAt = -Infinity;
    this.nextCityScanAt = 0;
    this.nextNavalScanAt = 0;
    this.navalProposal = null;
    this.navalProposalAt = -Infinity;
    this.planAttempted = false;
    this.planFailed = false;
    super.start(settings);
  }

  stop(status = "Stopped") {
    this.planAbort?.abort();
    this.planClient?.stop();
    super.stop(status);
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

  async scanNavalSites(isCurrent) {
    if (!this.navalAdapter || this.now() < this.nextNavalScanAt) return;
    this.nextNavalScanAt = this.now() + this.navalScanIntervalMs;
    this.navalProposal = null;
    try {
      const proposal = await this.navalAdapter.propose({
        mapId: this.mapId(),
        maxCandidates: 8,
        maxCoastTiles: 128,
        maxPairs: 512,
        maxWorkerChecks: 16,
      });
      if (!isCurrent()) return;
      this.navalProposal = proposal;
      this.navalProposalAt = this.now();
      this.onUpdate({
        navalScan: {
          offered: proposal.candidates.length,
          boats: {
            cap: proposal.boats.cap,
            active_count: proposal.boats.active_count,
          },
          target_coasts_eligible: proposal.coverage.total_eligible,
          worker_checked: proposal.coverage.worker_checked,
          omitted: proposal.coverage.omitted_count,
          reasons: proposal.omissions,
          certainty: proposal.coverage.certainty,
        },
        status: `Naval coasts checked: ${proposal.candidates.length} worker-legal; ${proposal.coverage.omitted_count} omitted`,
      });
    } catch (error) {
      if (isCurrent())
        this.onUpdate({
          navalScan: { error: error.message },
          status: `Naval scan unavailable: ${error.message}; no boat options this turn`,
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
      await this.scanNavalSites(isCurrent);
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
      let activePlan = null;
      if (this.planClient && !this.planAttempted) {
        this.planAttempted = true;
        const controller = new AbortController();
        this.planAbort = controller;
        this.onUpdate({
          status: "Asking Copilot for an objective (Jev paused)",
          planStatus: "Planning once for this Start session",
        });
        try {
          const plan = await this.planClient.plan(
            { tick: snapshot.tick, land },
            controller.signal,
          );
          if (!isCurrent()) return;
          this.onUpdate({
            planStatus: `Copilot plan v${plan.plan_version}: ${plan.objective}`,
          });
        } catch (error) {
          if (!isCurrent()) return;
          this.planClient.stop();
          this.planFailed = true;
          this.onUpdate({
            planStatus: `Copilot unavailable; Jev continues without a plan: ${error.message}`,
          });
        } finally {
          if (this.planAbort === controller) this.planAbort = null;
        }
        if (!this.fresh(snapshot.tick, observedAt)) {
          this.onUpdate({ status: "Reobserving after Copilot plan delay" });
          return;
        }
      }
      if (this.planClient && !this.planFailed) {
        // Heartbeats keep an active server-owned plan fresh on land-only ticks.
        // The plan client also heartbeats during the long planning request.
        try {
          await this.planClient.heartbeat();
          activePlan = await this.planClient.getPlan();
        } catch (error) {
          throw new Error(
            `Could not verify Copilot plan status: ${error.message}`,
          );
        }
        if (!isCurrent() || !this.fresh(snapshot.tick, observedAt)) return;
      }
      // Proposals are independently optional. A failed/expired City scan must
      // not hide a genuinely worker-checked coastal option, and vice versa.
      const compose = (building, naval) => ({
        game_id: this.gameId(),
        snapshot_tick: snapshot.tick,
        land,
        building,
        naval,
        city_mechanics: this.cityMechanics(),
        plan: null,
      });
      let city =
        this.cityProposal &&
        this.now() - this.cityProposalAt <= 1500 &&
        snapshot.tick - this.cityProposal.source_tick <= 20 &&
        snapshot.tick >= this.cityProposal.current_tick
          ? this.cityProposal
          : null;
      let naval =
        this.navalProposal &&
        this.now() - this.navalProposalAt <= 1500 &&
        snapshot.tick - this.navalProposal.source_tick <= 20 &&
        snapshot.tick >= this.navalProposal.current_tick
          ? this.navalProposal
          : null;
      if (city)
        try {
          validateHybridInput(compose(city, null));
        } catch (error) {
          city = null;
          this.onUpdate({
            status: `Discarded invalid City scan: ${error.message}`,
          });
        }
      if (naval)
        try {
          validateHybridInput(compose(null, naval));
        } catch (error) {
          naval = null;
          this.onUpdate({
            status: `Discarded invalid naval scan: ${error.message}`,
          });
        }
      const input =
        city || naval ? validateHybridInput(compose(city, naval)) : null;
      const hybrid = Boolean(
        input && (city?.candidates.length || naval?.candidates.length),
      );
      const offered = hybrid ? hybridChoices(input) : null;
      const state = hybrid ? hybridModelState(input) : modelState(land);
      const criteria = hybrid
        ? {
            branch: offered.branch,
            ...(offered.branch.land_attack
              ? { land_action: actionCriteria(offered.land) }
              : {}),
            ...(offered.branch.city_build ? { city_site: offered.city } : {}),
            ...(offered.branch.boat_attack
              ? { boat_action: offered.boat }
              : {}),
          }
        : actionCriteria(landActions);
      this.onUpdate({
        state,
        actions: criteria,
        mode: hybrid
          ? `land + ${city?.candidates.length ?? 0} City + ${naval?.candidates.length ?? 0} boat opportunities`
          : "land only (no fresh worker-legal City or naval sites)",
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
          ? "Asking Jev: land / City / boat / wait"
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
          building_snapshot_id: input.building?.snapshot_id ?? null,
          ...(input.naval?.candidates.length
            ? { naval_snapshot_id: input.naval.snapshot_id }
            : {}),
          plan_version: activePlan?.plan_version ?? null,
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
        } else if (decision.kind === "boat") {
          const site = offered.boat[decision.selected];
          if (
            !site ||
            site.kind !== "boat" ||
            site.candidate_id !== decision.candidate_id ||
            site.fraction !== decision.fraction ||
            !this.navalAdapter
          )
            throw new Error(
              "Model boat choice was not an offered target and size",
            );
          chosen = site;
          const legal = await this.navalAdapter.canExecute(
            site.candidate_id,
            site.fraction,
          );
          if (!isCurrent()) return;
          if (!this.fresh(snapshot.tick, observedAt))
            outcome = "discarded: naval snapshot changed";
          else if (!legal) outcome = "discarded: transport no longer legal";
          else
            outcome = (await this.navalAdapter.execute(
              site.candidate_id,
              site.fraction,
              isCurrent,
            ))
              ? "transport boat intent sent"
              : "boat intent not sent";
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
