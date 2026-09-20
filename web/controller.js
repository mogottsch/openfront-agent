import {
  actionCriteria,
  buildActions,
  modelState,
  validateObservation,
} from "./observation.js";

export class LandController {
  constructor(
    adapter,
    {
      decide,
      onUpdate = () => {},
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (timer) => clearTimeout(timer),
      now = () => performance.now(),
    },
  ) {
    Object.assign(this, {
      adapter,
      decide,
      onUpdate,
      setTimer,
      clearTimer,
      now,
    });
    this.running = false;
    this.generation = 0;
    this.busy = false;
    this.nextAllowedStart = 0;
  }

  start({ intervalMs = 1000, limit = 30 } = {}) {
    if (
      !Number.isFinite(intervalMs) ||
      intervalMs < 1000 ||
      intervalMs > 30000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 300
    )
      throw new Error("Invalid interval or request limit");
    this.stop("Restarting");
    this.running = true;
    this.intervalMs = intervalMs;
    this.limit = limit;
    this.count = 0;
    this.lastTick = -1;
    this.onUpdate({ status: "Running", running: true, count: 0 });
    void this.step();
  }

  stop(status = "Stopped") {
    this.running = false;
    this.generation++;
    this.clearTimer(this.timer);
    this.abort?.abort();
    this.onUpdate({ status, running: false });
  }

  scheduleAt(time) {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(
      () => void this.step(),
      Math.ceil(Math.max(0, time - this.now())),
    );
  }

  fresh(tick, observedAt) {
    const current = this.adapter.read();
    return (
      current.ready &&
      !current.ended &&
      Number.isInteger(tick) &&
      current.tick >= tick &&
      current.tick - tick <= 20 &&
      this.now() - observedAt <= 2000
    );
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
      const observedAt = this.now();
      const snapshot = await this.adapter.observe();
      if (!isCurrent()) return;
      if (!this.fresh(snapshot.tick, observedAt)) {
        this.onUpdate({ status: "Discarded stale observation" });
        return;
      }
      const observation = validateObservation(snapshot.observation);
      const actions = buildActions(observation);
      const state = modelState(observation);
      this.onUpdate({ state, actions: actionCriteria(actions) });
      if (Object.keys(actions).length === 1) {
        // Keep polling: an immunity period may end or borders may change.
        // No paid request is needed when wait is the only available option.
        this.onUpdate({ status: "Waiting for legal land attacks" });
        return;
      }
      this.lastTick = snapshot.tick;
      this.abort = new AbortController();
      this.count++;
      this.onUpdate({ status: "Asking Jev", count: this.count });
      const requestedAt = this.now();
      this.nextAllowedStart = requestedAt + this.intervalMs;
      wakeAt = this.nextAllowedStart;
      const decision = await this.decide(observation, this.abort.signal);
      if (!isCurrent()) return;
      if (!Object.hasOwn(actions, decision.action))
        throw new Error(
          "Model selected an action outside this observation's candidates",
        );
      const action = actions[decision.action];
      let outcome = "no-op";
      if (!this.fresh(snapshot.tick, observedAt)) {
        outcome =
          "discarded: state unavailable or observation older than 2 seconds";
      } else if (action.kind === "attack") {
        const legal = await this.adapter.canExecute(action);
        if (!isCurrent()) return;
        if (!this.fresh(snapshot.tick, observedAt))
          outcome = "discarded: state changed";
        else if (!legal) outcome = "discarded: target no longer legal";
        else
          outcome = this.adapter.execute(action)
            ? "land attack intent sent"
            : "not sent";
      }
      if (!isCurrent()) return;
      this.onUpdate({
        status: outcome,
        count: this.count,
        decision: {
          ...decision,
          observation: state,
          selected: action,
          tick: snapshot.tick,
          outcome,
        },
      });
      if (this.count >= this.limit)
        this.stop(`Request limit reached (${this.limit})`);
    } catch (error) {
      if (isCurrent()) this.stop(`Stopped: ${error.message}`);
    } finally {
      this.busy = false;
      // Old runs can wake a restarted run, but generation checks forbid acting
      // for it. Fast responses idle until the deadline; slow ones never queue.
      if (this.running)
        this.scheduleAt(isCurrent() ? wakeAt : this.nextAllowedStart);
    }
  }
}
