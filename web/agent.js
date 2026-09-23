import { LandController } from "./controller.js";
import { HybridController } from "./hybrid-controller.js";
import { createGameAdapter } from "./game-adapter.js";
import { createBuildingAdapter } from "./building-adapter.js";

export function mount(connection) {
  const adapter = createGameAdapter(connection);
  const panel = document.createElement("aside");
  panel.id = "jev-land-agent";
  panel.setAttribute("aria-label", "Jev land agent");
  // Shadow DOM keeps the experimental panel independent of upstream styling/i18n.
  const root = panel.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { position:fixed; z-index:10000; right:12px; top:55px; width:min(345px, calc(100vw - 24px)); color:#eee; font:13px/1.4 system-ui; }
      section { background:#182330f2; border:1px solid #607387; border-radius:8px; padding:12px; box-shadow:0 3px 12px #0005; }
      h2 { font-size:15px; margin:0 0 5px; } p { margin:5px 0; } small { color:#bcc9d5; }
      label { display:inline-flex; align-items:center; gap:4px; margin:8px 8px 8px 0; }
      input { width:48px; color:#eee; background:#26384b; border:1px solid #607387; padding:3px; }
      button { padding:5px 12px; border:1px solid #789; border-radius:4px; cursor:pointer; background:#29435b; color:white; }
      button:disabled { opacity:.5; cursor:default; } pre { white-space:pre-wrap; margin:5px 0; font-size:12px; }
      ol { max-height:190px; overflow:auto; padding-left:22px; font-size:12px; } li { padding:4px 0; border-bottom:1px solid #ffffff18; white-space:pre-wrap; overflow-wrap:anywhere; }
    </style>
    <section>
      <h2>Jev · local land agent</h2>
      <small>Wilderness first · tribe gold-steal exception.<br>Tribes: 10% / 20%. Other targets: up to 50%.<br>Preserve growth; incoming force counts. Local solo only.</small>
      <div>
        <label>Interval (s) <input id="interval" aria-label="Decision interval seconds" type="number" min="1" max="30" value="1"></label>
        <label>Calls <input id="limit" aria-label="Request limit" type="number" min="1" max="300" value="30"></label>
      </div>
      <button id="start">Start Jev</button> <button id="hybrid" disabled>Start Hybrid</button> <button id="stop" disabled>Stop Jev</button>
      <p id="hybrid-status"><small>Hybrid City experiment: checking server opt-in (City scans at most once per 15s; no Copilot calls yet).</small></p>
      <p id="status" role="status">Stopped — no API calls until Start.</p>
      <p id="mode"></p>
      <details><summary>Latest City scan (geometry / legality / omissions)</summary><pre id="scan">Not scanned yet.</pre></details>
      <pre id="state">Awaiting first observation</pre>
      <details><summary>Input and available actions</summary><pre id="payload" style="max-height:240px;overflow:auto;overflow-wrap:anywhere"></pre></details>
      <p id="count">Requests: 0</p>
      <details><summary>Decisions and probabilities</summary><ol id="history"></ol></details>
    </section>`;
  const $ = (id) => root.getElementById(id);
  let disposed = false;
  let activeController = null;
  let hybridEnabled = false;
  let sessionToken = null;
  let launchGeneration = 0;
  const revokeToken = (token) => {
    if (token)
      void fetch(new URL("/session", import.meta.url), {
        method: "DELETE",
        headers: { "X-Agent-Session": token },
        keepalive: true,
      }).catch(() => {});
  };
  const closeSession = () => {
    const token = sessionToken;
    sessionToken = null;
    revokeToken(token);
  };
  const decide = async (path, state, signal) => {
    if (!sessionToken) throw new Error("No active local Start session");
    const response = await fetch(new URL(path, import.meta.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Session": sessionToken,
      },
      body: JSON.stringify(state),
      signal,
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || `Local server HTTP ${response.status}`);
    return data;
  };
  const onUpdate = (event) => {
    if (disposed) return;
    if (event.status) $("status").textContent = event.status;
    if (event.mode) $("mode").textContent = `Decision scope: ${event.mode}`;
    if (event.cityScan)
      $("scan").textContent = JSON.stringify(event.cityScan, null, 2);
    if (event.running !== undefined) {
      if (
        !event.running &&
        !activeController?.running &&
        !["Restarting", "Switching controller"].includes(event.status)
      )
        closeSession();
      $("start").disabled = event.running;
      $("hybrid").disabled = event.running || !hybridEnabled;
      $("stop").disabled = !event.running;
      $("interval").disabled = event.running;
      $("limit").disabled = event.running;
    }
    if (event.state) {
      const { self, border, neighbors, economy, city_mechanics } = event.state;
      $("state").textContent =
        `Troops ${self.troops}/${self.troop_capacity} (${self.reserve_percent}%)\nBorder: ${Math.round(border.wilderness_share * 100)}% wilderness, ${Math.round(border.player_share * 100)}% players\nNeighbors: ${neighbors.length} · incoming: ${self.active_incoming_troops}\nAlready committed: ${self.committed_outgoing_troops}` +
        (economy
          ? `\nGold: ${economy.available_gold} · Cities: ${economy.cities.owned ?? "?"} · City sites: ${economy.city_sites_offered} offered / ${economy.city_sites_omitted} omitted · City cap gain: ${city_mechanics.troop_capacity_gain_display}`
          : "");
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
      const details = d.decisions
        ? Object.fromEntries(
            Object.entries(d.decisions).map(([name, a]) => [
              name,
              {
                action: a.action,
                confidence: a.confidence,
                probabilities: a.probabilities,
              },
            ]),
          )
        : d.probabilities;
      const confidence = d.confidence ?? d.decisions?.branch?.confidence ?? "?";
      item.textContent = `${d.action} · troops ${self.troops}/${self.troop_capacity} (${self.reserve_percent}%) · ${d.latencyMs}ms · confidence ${confidence}\n${d.outcome}\n${JSON.stringify(details)}`;
      $("history").prepend(item);
      while ($("history").children.length > 30) $("history").lastChild.remove();
    }
  };
  const landController = new LandController(adapter, {
    decide: (state, signal) => decide("/decision", state, signal),
    onUpdate,
  });
  const hybridController =
    typeof connection.sendBuild === "function"
      ? new HybridController(
          adapter,
          createBuildingAdapter({ ...connection, cityUnit: "City" }),
          {
            decideLand: (state, signal) => decide("/decision", state, signal),
            decideHybrid: (state, signal) =>
              decide("/hybrid-decision", state, signal),
            gameId: () => connection.game.gameID(),
            mapId: () => String(connection.game.config().gameConfig().gameMap),
            existingCityTiles: () =>
              connection.game
                .myPlayer()
                .units("City")
                .map((unit) => unit.tile()),
            cityMechanics: () => ({
              troop_capacity_gain_display: Math.floor(
                connection.game.config().cityTroopIncrease() / 10,
              ),
              construction_ticks:
                connection.game.config().unitInfo("City")
                  .constructionDuration ?? 0,
            }),
            onUpdate,
          },
        )
      : null;
  // Health is read-only; neither controller starts itself or makes a model call.
  void fetch(new URL("/health", import.meta.url))
    .then((response) => (response.ok ? response.json() : null))
    .then((health) => {
      if (disposed) return;
      hybridEnabled = Boolean(hybridController && health?.hybridEnabled);
      $("hybrid").disabled =
        !hybridEnabled || Boolean(activeController?.running);
      $("hybrid-status").textContent = hybridEnabled
        ? "Hybrid City experiment enabled; no Copilot plan yet. Click Start Hybrid to opt in."
        : "Hybrid City experiment disabled in local sidecar (land mode remains available).";
    })
    .catch(() => {
      if (!disposed)
        $("hybrid-status").textContent =
          "Hybrid unavailable: local sidecar health check failed.";
    });
  const start = async (controller, mode) => {
    const ticket = ++launchGeneration;
    try {
      activeController?.stop("Switching controller");
      activeController = null;
      closeSession();
      const intervalMs = Number($("interval").value) * 1000;
      const limit = Number($("limit").value);
      if (
        !Number.isInteger(intervalMs) ||
        intervalMs < 1000 ||
        intervalMs > 30000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 300
      )
        throw new Error("Invalid interval or request limit");
      $("start").disabled = true;
      $("hybrid").disabled = true;
      $("status").textContent = "Authorizing local Start (no model call yet)";
      const response = await fetch(new URL("/session", import.meta.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, limit }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || `Local Start HTTP ${response.status}`);
      if (ticket !== launchGeneration || disposed) {
        revokeToken(data.token); // never overwrite a newer Start's token
        return;
      }
      sessionToken = data.token;
      activeController = controller;
      controller.start({ intervalMs, limit });
    } catch (error) {
      if (ticket === launchGeneration && !disposed) {
        closeSession();
        $("status").textContent = `Start failed: ${error.message}`;
        $("start").disabled = false;
        $("hybrid").disabled = !hybridEnabled;
      }
    }
  };
  $("start").onclick = () => void start(landController, "land");
  $("hybrid").onclick = () => {
    if (hybridEnabled && hybridController)
      void start(hybridController, "hybrid");
  };
  $("stop").onclick = () => {
    ++launchGeneration;
    activeController?.stop();
    closeSession();
  };
  document.body.append(panel);
  const stopAll = (reason) => {
    ++launchGeneration;
    landController.stop(reason);
    hybridController?.stop(reason);
    closeSession();
  };
  const onHide = () => {
    if (document.hidden) stopAll("Stopped: tab hidden");
  };
  document.addEventListener("visibilitychange", onHide);
  const onUnload = () => stopAll("Game closed");
  window.addEventListener("pagehide", onUnload);
  return () => {
    stopAll("Game closed");
    disposed = true;
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onUnload);
    panel.remove();
  };
}
