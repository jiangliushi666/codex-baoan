const byId = (id) => document.getElementById(id);

const nodes = {
  tabs: Array.from(document.querySelectorAll(".tab-button")),
  views: { app: byId("view-app"), ccswitch: byId("view-ccswitch"), plus: byId("view-plus"), logs: byId("view-logs") },
  subtitleText: byId("subtitleText"), guardState: byId("guardState"), guardDetail: byId("guardDetail"), sourcePills: byId("sourcePills"),
  providerSummary: byId("providerSummary"), providerList: byId("providerList"), ccswitchList: byId("ccswitchList"), plusList: byId("plusList"),
  refreshButton: byId("refreshButton"), settingsButton: byId("settingsButton"), closeSettingsButton: byId("closeSettingsButton"), settingsPanel: byId("settingsPanel"), quickToggleButton: byId("quickToggleButton"),
  inspectButton: byId("inspectButton"), commandInput: byId("commandInput"), inspectBadge: byId("inspectBadge"), decisionText: byId("decisionText"),
  sessionList: byId("sessionList"), logView: byId("logView"), configPath: byId("configPath"), upstreamInput: byId("upstreamInput"), apiKeyInput: byId("apiKeyInput"),
  portInput: byId("portInput"), modeSelect: byId("modeSelect"), allowInput: byId("allowInput"), processNamesInput: byId("processNamesInput"), killOnBlockInput: byId("killOnBlockInput"), saveSettingsButton: byId("saveSettingsButton"), toast: byId("toast")
};

let latestState = null;
let hydrated = false;
let selectedSessionId = null;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed: " + response.status);
  return data;
}

async function loadState() {
  latestState = await api("/api/state");
  if (!hydrated) { hydrate(latestState); hydrated = true; }
  render(latestState);
}

function hydrate(state) {
  const config = state.config;
  nodes.configPath.textContent = state.configPath;
  nodes.upstreamInput.value = "";
  nodes.apiKeyInput.value = "";
  nodes.portInput.value = String(config.modelProxy.port || 8787);
  nodes.modeSelect.value = config.mode || "audit";
  nodes.allowInput.value = (config.scope.extraAllow || []).join("\n");
  nodes.processNamesInput.value = (config.appWatcher.processNames || []).join(", ");
  nodes.killOnBlockInput.checked = Boolean(config.appWatcher.killOnBlock);
}

function render(state) {
  const proxy = state.runtime.proxy || { running: false };
  const watcher = state.runtime.watcher || { running: false };
  const discovery = state.discovery || { providers: [], sources: [] };
  const running = Boolean(proxy.running || watcher.running);
  nodes.configPath.textContent = state.configPath;
  nodes.quickToggleButton.textContent = running ? "x" : "+";
  nodes.quickToggleButton.title = running ? "Stop protection" : "Start recommended protection";
  nodes.guardState.textContent = proxy.running ? "Attached" : watcher.running ? "Watching process" : "Not attached";
  nodes.guardDetail.textContent = proxy.running ? (proxy.providerName || proxy.upstream || "Local proxy is running") : discovery.manualFallback.reason;
  nodes.subtitleText.textContent = discovery.providers.length ? "Found " + discovery.providers.length + " config sources" : "Waiting for a usable source";
  nodes.providerSummary.textContent = discovery.providers.length ? "Pick a row to route Codex traffic through the local guard. Keys stay server-side." : "No source was found. Use fallback settings once.";
  renderSourcePills(discovery.sources || []);
  renderProviderList(nodes.providerList, discovery.providers || []);
  renderProviderList(nodes.ccswitchList, (discovery.providers || []).filter((provider) => provider.source === "ccswitch"));
  renderProviderList(nodes.plusList, (discovery.providers || []).filter((provider) => provider.source !== "ccswitch"));
  renderSessions(state.sessions || []);
}

function renderSourcePills(sources) {
  nodes.sourcePills.replaceChildren();
  for (const source of sources) {
    const pill = document.createElement("span");
    pill.className = "source-pill " + source.status;
    pill.textContent = source.label + " - " + (source.status === "ok" ? source.providerCount : source.status === "missing" ? "missing" : "error");
    nodes.sourcePills.append(pill);
  }
}

function renderProviderList(container, providers) {
  container.replaceChildren();
  if (!providers.length) {
    const empty = document.createElement("article");
    empty.className = "switch-row empty-row";
    empty.innerHTML = "<div class='row-icon muted-icon'>-</div><div class='row-main'><div class='row-titleline'><h3>No source here</h3></div><p>Use fallback settings when discovery cannot read a default path.</p></div>";
    container.append(empty);
    return;
  }
  for (const provider of providers) container.append(providerRow(provider));
}

function providerRow(provider) {
  const proxy = latestState.runtime.proxy || {};
  const isRunning = proxy.running && proxy.providerId === provider.id;
  const selectable = provider.status !== "unconfigured";
  const row = document.createElement("article");
  row.className = "switch-row provider-row" + (isRunning ? " active" : "") + (provider.isRecommended ? " recommended" : "");
  row.innerHTML = "<div class='drag-handle' aria-hidden='true'>&#8942;&#8942;</div><div class='row-icon " + iconClass(provider.source) + "'>" + iconText(provider.source) + "</div><div class='row-main'><div class='row-titleline'><h3></h3><span class='current-badge'></span></div><p></p><div class='badge-line'></div></div><div class='row-stats'><span></span><span></span></div><button class='row-action' type='button'></button>";
  row.querySelector("h3").textContent = provider.name;
  row.querySelector(".current-badge").textContent = isRunning ? "Running" : provider.statusText;
  row.querySelector(".current-badge").classList.toggle("off", !selectable);
  row.querySelector("p").textContent = provider.baseUrl || "No upstream URL configured";
  const labels = [];
  if (provider.isRecommended) labels.push("Recommended");
  if (provider.isCurrent) labels.push("Current");
  labels.push(provider.hasApiKey ? "Key read" : "Use existing auth");
  const badgeLine = row.querySelector(".badge-line");
  for (const label of labels) {
    const badge = document.createElement("span");
    badge.className = "soft-badge";
    badge.textContent = label;
    badgeLine.append(badge);
  }
  const stats = row.querySelectorAll(".row-stats span");
  stats[0].textContent = provider.sourceLabel;
  stats[1].textContent = provider.model || provider.protocol || provider.category || "Codex";
  const button = row.querySelector("button");
  button.textContent = isRunning ? "Enabled" : selectable ? "Enable Guard" : "Unavailable";
  button.disabled = isRunning || !selectable;
  button.addEventListener("click", () => startWithProvider(provider.id).catch(showError));
  return row;
}

function iconClass(source) { return source === "ccswitch" ? "cc-icon" : source === "codexplusplus" ? "plus-icon" : "config-icon"; }
function iconText(source) { return source === "ccswitch" ? "C" : source === "codexplusplus" ? "++" : "~"; }

async function toggleProtection() {
  const running = latestState && (latestState.runtime.proxy.running || latestState.runtime.watcher.running);
  if (running) return stopProtection();
  const discovery = latestState.discovery || { providers: [] };
  const id = discovery.recommendedProviderId || (discovery.providers.find((provider) => provider.status !== "unconfigured") || {}).id;
  await startWithProvider(id);
}

async function startWithProvider(providerId) {
  const values = currentControlValues();
  if (providerId) values.providerId = providerId;
  await api("/api/quick/start", { method: "POST", body: JSON.stringify(values) });
  showToast("Protection started");
  await loadState();
}

async function stopProtection() {
  await api("/api/quick/stop", { method: "POST", body: "{}" });
  showToast("Protection stopped");
  await loadState();
}

function currentControlValues() {
  const values = { port: Number(nodes.portInput.value || 8787), mode: nodes.modeSelect.value, allow: nodes.allowInput.value, processNames: nodes.processNamesInput.value, killOnBlock: nodes.killOnBlockInput.checked };
  if (nodes.upstreamInput.value.trim()) values.upstream = nodes.upstreamInput.value.trim();
  if (nodes.apiKeyInput.value.trim()) values.apiKey = nodes.apiKeyInput.value.trim();
  return values;
}

async function inspectCommand() {
  const command = nodes.commandInput.value.trim();
  if (!command) { showToast("Enter a command first"); return; }
  const decision = await api("/api/inspect", { method: "POST", body: JSON.stringify({ command, mode: nodes.modeSelect.value, allow: nodes.allowInput.value }) });
  nodes.inspectBadge.textContent = riskLabel(decision.severity);
  nodes.inspectBadge.className = "soft-badge risk-" + decision.severity;
  const paths = decision.matchedPaths && decision.matchedPaths.length ? " Paths: " + decision.matchedPaths.join(", ") : "";
  nodes.decisionText.textContent = (decision.action === "block" ? "Would block. " : "Would allow. ") + decision.message + paths;
}

async function saveSettings() {
  const config = structuredClone(latestState.config);
  config.mode = nodes.modeSelect.value;
  config.scope.extraAllow = splitLines(nodes.allowInput.value);
  if (nodes.upstreamInput.value.trim()) config.modelProxy.upstreamBaseUrl = nodes.upstreamInput.value.trim();
  config.modelProxy.port = Number(nodes.portInput.value || config.modelProxy.port);
  config.appWatcher.processNames = splitLines(nodes.processNamesInput.value).length ? splitLines(nodes.processNamesInput.value) : config.appWatcher.processNames;
  config.appWatcher.killOnBlock = nodes.killOnBlockInput.checked;
  await api("/api/config", { method: "POST", body: JSON.stringify({ config }) });
  showToast("Settings saved");
  await loadState();
}

function renderSessions(sessions) {
  nodes.sessionList.replaceChildren();
  if (!sessions.length) { nodes.sessionList.innerHTML = "<div class='empty-note'>No session logs.</div>"; nodes.logView.textContent = "No logs yet. Start protection to see recent sessions."; return; }
  if (!selectedSessionId || !sessions.some((session) => session.id === selectedSessionId)) selectedSessionId = sessions[0].id;
  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-button" + (session.id === selectedSessionId ? " active" : "");
    button.innerHTML = "<strong></strong><span></span><span></span>";
    button.querySelector("strong").textContent = session.id;
    button.querySelectorAll("span")[0].textContent = new Date(session.updatedAt).toLocaleString();
    button.querySelectorAll("span")[1].textContent = session.sessionDir;
    button.addEventListener("click", () => { selectedSessionId = session.id; renderSessions(sessions); });
    nodes.sessionList.append(button);
  }
  const selected = sessions.find((session) => session.id === selectedSessionId) || sessions[0];
  const alerts = String(selected.alerts || "").trim();
  const summary = String(selected.summary || "").trim();
  nodes.logView.textContent = (alerts && !alerts.includes("No alerts recorded yet") ? alerts : "# Alerts\n\nNo high-risk alerts.") + "\n\n" + summary;
}

function switchView(name) {
  for (const tab of nodes.tabs) tab.classList.toggle("active", tab.dataset.view === name);
  for (const entry of Object.entries(nodes.views)) entry[1].classList.toggle("active", entry[0] === name);
}

function riskLabel(severity) { return ({ info: "No risk", low: "Low", medium: "Medium", high: "High", critical: "Critical" })[severity] || severity; }
function splitLines(value) { return String(value || "").split(/[\n,;]/).map((item) => item.trim()).filter(Boolean); }
function showToast(message) { nodes.toast.textContent = message; nodes.toast.classList.add("show"); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => nodes.toast.classList.remove("show"), 2300); }
function showError(error) { console.error(error); showToast(error instanceof Error ? error.message : String(error)); }

function bindEvents() {
  nodes.tabs.forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
  nodes.settingsButton.addEventListener("click", () => nodes.settingsPanel.classList.add("open"));
  nodes.closeSettingsButton.addEventListener("click", () => nodes.settingsPanel.classList.remove("open"));
  nodes.quickToggleButton.addEventListener("click", () => toggleProtection().catch(showError));
  nodes.refreshButton.addEventListener("click", () => loadState().then(() => showToast("Rescanned")).catch(showError));
  nodes.inspectButton.addEventListener("click", () => inspectCommand().catch(showError));
  nodes.saveSettingsButton.addEventListener("click", () => saveSettings().catch(showError));
}

bindEvents();
loadState().catch(showError);
window.setInterval(() => loadState().catch(() => {}), 6000);
