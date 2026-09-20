import { LandController } from "./controller.js";
import { createGameAdapter } from "./game-adapter.js";

export function mount(connection) {
  const adapter = createGameAdapter(connection);
  const panel = document.createElement("aside");
  panel.id = "jev-land-agent";
  panel.setAttribute("aria-label", "Jev land agent");
  // Shadow DOM keeps the experimental panel independent of upstream styling/i18n.
  const root = panel.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { position:fixed; z-index:10000; right:12px; top:55px; width:min(330px, calc(100vw - 24px)); color:#eee; font:13px/1.4 system-ui; }
      section { background:#182330f2; border:1px solid #607387; border-radius:8px; padding:12px; box-shadow:0 3px 12px #0005; }
      h2 { font-size:15px; margin:0 0 5px; } p { margin:5px 0; } small { color:#bcc9d5; }
      label { display:inline-flex; align-items:center; gap:4px; margin:8px 8px 8px 0; }
      input { width:48px; color:#eee; background:#26384b; border:1px solid #607387; padding:3px; }
      button { padding:5px 12px; border:1px solid #789; border-radius:4px; cursor:pointer; background:#29435b; color:white; }
      button:disabled { opacity:.5; cursor:default; } pre { white-space:pre-wrap; margin:5px 0; font-size:12px; }
      ol { max-height:190px; overflow:auto; padding-left:22px; font-size:12px; } li { padding:4px 0; border-bottom:1px solid #ffffff18; white-space:pre-wrap; overflow-wrap:anywhere; }
    </style>
    <section>
      <h2>Jev · land actions</h2>
      <small>Borders, neighbors, incoming attacks.<br>Wait or attack a legal target with 10% / 20%.<br>No prescribed strategy. Local solo only.</small>
      <div>
        <label>Interval (s) <input id="interval" aria-label="Decision interval seconds" type="number" min="1" max="30" value="1"></label>
        <label>Calls <input id="limit" aria-label="Request limit" type="number" min="1" max="300" value="30"></label>
      </div>
      <button id="start">Start Jev</button> <button id="stop" disabled>Stop Jev</button>
      <p id="status" role="status">Stopped — no API calls until Start.</p>
      <pre id="state">Awaiting first observation</pre>
      <details><summary>Input and available actions</summary><pre id="payload" style="max-height:240px;overflow:auto;overflow-wrap:anywhere"></pre></details>
      <p id="count">Requests: 0</p>
      <details><summary>Decisions and probabilities</summary><ol id="history"></ol></details>
    </section>`;
  const $ = (id) => root.getElementById(id);
  let disposed = false;
  const controller = new LandController(adapter, {
    async decide(state, signal) {
      const response = await fetch(new URL("/decision", import.meta.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
        signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || `Local server HTTP ${response.status}`);
      return data;
    },
    onUpdate(event) {
      if (disposed) return;
      if (event.status) $("status").textContent = event.status;
      if (event.running !== undefined) {
        $("start").disabled = event.running;
        $("stop").disabled = !event.running;
        $("interval").disabled = event.running;
        $("limit").disabled = event.running;
      }
      if (event.state) {
        const { self, border, neighbors } = event.state;
        $("state").textContent =
          `Troops ${self.troops}/${self.troop_capacity} (${self.reserve_percent}%)\nBorder: ${Math.round(border.wilderness_share * 100)}% wilderness, ${Math.round(border.player_share * 100)}% players\nNeighbors: ${neighbors.length} · incoming troops: ${self.active_incoming_troops}`;
        $("payload").textContent = JSON.stringify(
          { state: event.state, actions: event.actions },
          null,
          2,
        );
      }
      if (event.count !== undefined)
        $("count").textContent = `Requests: ${event.count}`;
      if (event.decision) {
        const d = event.decision;
        const item = document.createElement("li");
        const self = d.observation.self;
        item.textContent = `${d.action} · troops ${self.troops}/${self.troop_capacity} (${self.reserve_percent}%) · ${d.latencyMs}ms · confidence ${d.confidence}\n${d.outcome}\n${JSON.stringify(d.probabilities)}`;
        $("history").prepend(item);
        while ($("history").children.length > 30)
          $("history").lastChild.remove();
      }
    },
  });
  $("start").onclick = () => {
    try {
      controller.start({
        intervalMs: Number($("interval").value) * 1000,
        limit: Number($("limit").value),
      });
    } catch (error) {
      $("status").textContent = error.message;
    }
  };
  $("stop").onclick = () => controller.stop();
  document.body.append(panel);
  const onHide = () => {
    if (document.hidden) controller.stop("Stopped: tab hidden");
  };
  document.addEventListener("visibilitychange", onHide);
  const onUnload = () => controller.stop();
  window.addEventListener("pagehide", onUnload);
  return () => {
    controller.stop("Game closed");
    disposed = true;
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onUnload);
    panel.remove();
  };
}
