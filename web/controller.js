const fractions = Object.freeze({
  wait: 0,
  attack_0: 0,
  attack_10: 0.1,
  attack_20: 0.2,
});

// The adapter owns game access. Only {troops} crosses the model boundary.
export class WildernessController {
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
  }

  start({ intervalMs = 2000, limit = 30 } = {}) {
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

  async step() {
    if (!this.running) return;
    if (this.busy) {
      this.timer = this.setTimer(() => void this.step(), this.intervalMs);
      return;
    }
    const generation = this.generation;
    const isCurrent = () => this.running && generation === this.generation;
    this.busy = true;
    const started = this.now();
    try {
      let state = this.adapter.read();
      if (state.ended) {
        this.stop("Game ended");
        return;
      }
      if (!state.ready || state.tick === this.lastTick) {
        this.onUpdate({ status: "Waiting for active play / advancing ticks" });
        return;
      }
      if (!(await this.adapter.canExpand())) {
        if (isCurrent())
          this.stop("No adjacent wilderness — opening experiment finished");
        return;
      }
      if (!isCurrent()) return;
      state = this.adapter.read();
      if (!state.ready || state.ended) return;
      this.lastTick = state.tick;
      this.abort = new AbortController();
      this.count++;
      this.onUpdate({
        status: "Asking Jev",
        state: { troops: state.troops },
        count: this.count,
      });
      const requestedAt = this.now();
      const decision = await this.decide(
        { troops: state.troops },
        this.abort.signal,
      );
      if (!isCurrent()) return;
      if (!Object.hasOwn(fractions, decision.action))
        throw new Error("Unknown action");
      const latest = this.adapter.read();
      let outcome = "no-op";
      if (
        !latest.ready ||
        latest.ended ||
        latest.tick < state.tick ||
        latest.tick - state.tick > 20 ||
        this.now() - requestedAt > 2000
      ) {
        outcome =
          "discarded: state unavailable or response older than 2 seconds";
      } else if (fractions[decision.action] > 0) {
        if (await this.adapter.canExpand()) {
          const checked = this.adapter.read();
          if (!isCurrent()) return;
          if (
            checked.ready &&
            !checked.ended &&
            checked.tick >= state.tick &&
            checked.tick - state.tick <= 20 &&
            this.now() - requestedAt <= 2000
          ) {
            outcome = this.adapter.attack(fractions[decision.action])
              ? "wilderness intent sent"
              : "not sent";
          } else outcome = "discarded: state changed";
        } else outcome = "not sent: no adjacent wilderness";
      }
      if (!isCurrent()) return;
      this.onUpdate({
        status: outcome,
        decision: {
          ...decision,
          troops: state.troops,
          tick: state.tick,
          outcome,
        },
        count: this.count,
      });
      if (this.count >= this.limit)
        this.stop(`Request limit reached (${this.limit})`);
    } catch (error) {
      if (isCurrent()) this.stop(`Stopped: ${error.message}`);
    } finally {
      this.busy = false;
      if (isCurrent())
        this.timer = this.setTimer(
          () => void this.step(),
          Math.max(0, this.intervalMs - (this.now() - started)),
        );
    }
  }
}
