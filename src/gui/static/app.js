const $ = (id) => document.getElementById(id);

const elements = {
  configPath: $("configPath"),
  proxyStatus: $("proxyStatus"),
  watchStatus: $("watchStatus"),
  upstreamInput: $("upstreamInput"),
  portInput: $("portInput"),
  modeSelect: $("modeSelect"),
  allowInput: $("allowInput"),
  proxyModeLabel: $("proxyModeLabel"),
  startProxyButton: $("startProxyButton"),
  stopProxyButton: $("stopProxyButton"),
  localProxyUrl: $("localProxyUrl"),
  copyProxyButton: $("copyProxyButton"),
  processNamesInput: $("processNamesInput"),
  killOnBlockInput: $("killOnBlockInput"),
  startWatcherButton: $("startWatcherButton"),
  stopWatcherButton: $("stopWatcherButton"),
  commandInput: $("commandInput"),
  inspectButton: $("inspectButton"),
  decisionBox: $("decisionBox"),
  sessionList: $("sessionList"),
  logView: $("logView"),
  refreshButton: $("refreshButton"),
  reloadLogsButton: $("reloadLogsButton"),
  toast: $("toast")
};

let hydrated = false;
let latestState = null;
let selectedSessionId = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `请求失败: ${response.status}`);
  }
  return data;
}

async function loadState() {
  latestState = await api("/api/state");
  if (!hydrated) {
    hydrateControls(latestState);
    hydrated = true;
  }
  renderState(latestState);
}

function hydrateControls(state) {
  const config = state.config;
  elements.configPath.textContent = state.configPath;
  elements.upstreamInput.value = config.modelProxy.upstreamBaseUrl || "https://api.openai.com";
  elements.portInput.value = String(config.modelProxy.port || 8787);
  elements.modeSelect.value = config.mode || "audit";
  elements.allowInput.value = (config.scope.extraAllow || []).join("\n");
  elements.processNamesInput.value = (config.appWatcher.processNames || []).join(", ");
  elements.killOnBlockInput.checked = Boolean(config.appWatcher.killOnBlock);
  updateProxyUrl();
  updateModeLabel();
}

function renderState(state) {
  const proxy = state.runtime.proxy;
  const watcher = state.runtime.watcher;
  elements.configPath.textContent = state.configPath;
  setStatus(elements.proxyStatus, proxy.running, proxy.running ? `代理运行中 ${proxy.url}` : "代理未启动");
  setStatus(elements.watchStatus, watcher.running, watcher.running ? "App 监控运行中" : "App 监控未启动");
  elements.startProxyButton.disabled = proxy.running;
  elements.stopProxyButton.disabled = !proxy.running;
  elements.startWatcherButton.disabled = watcher.running;
  elements.stopWatcherButton.disabled = !watcher.running;
  renderSessions(state.sessions || []);
}

function setStatus(node, running, text) {
  node.classList.toggle("running", Boolean(running));
  node.lastChild.textContent = text;
}

function renderSessions(sessions) {
  elements.sessionList.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "note";
    empty.textContent = "还没有会话日志。启动代理或 App 监控后会自动生成。";
    elements.sessionList.append(empty);
    elements.logView.textContent = "暂无日志。";
    return;
  }

  if (!selectedSessionId || !sessions.some((session) => session.id === selectedSessionId)) {
    selectedSessionId = sessions[0].id;
  }

  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-button";
    button.classList.toggle("active", session.id === selectedSessionId);

    const title = document.createElement("strong");
    title.textContent = session.id;
    const time = document.createElement("span");
    time.textContent = new Date(session.updatedAt).toLocaleString();
    const path = document.createElement("span");
    path.textContent = session.sessionDir;
    button.append(title, time, path);
    button.addEventListener("click", () => {
      selectedSessionId = session.id;
      renderSessions(sessions);
    });
    elements.sessionList.append(button);
  }

  const selected = sessions.find((session) => session.id === selectedSessionId) || sessions[0];
  const alerts = String(selected.alerts || "").trim();
  const summary = String(selected.summary || "").trim();
  const hasRealAlert = alerts && !alerts.includes("No alerts recorded yet");
  elements.logView.textContent = `${hasRealAlert ? alerts : "# Alerts\n\n暂无高危告警。"}\n\n${summary}`;
}

function updateProxyUrl() {
  const port = elements.portInput.value.trim() || "8787";
  elements.localProxyUrl.textContent = `http://127.0.0.1:${port}`;
}

function updateModeLabel() {
  elements.proxyModeLabel.textContent = elements.modeSelect.value === "block" ? "拦截模式" : "审计模式";
}

async function startProxy() {
  await api("/api/proxy/start", {
    method: "POST",
    body: JSON.stringify({
      upstream: elements.upstreamInput.value.trim(),
      port: Number(elements.portInput.value || 8787),
      mode: elements.modeSelect.value,
      allow: elements.allowInput.value
    })
  });
  showToast("模型代理已启动");
  await loadState();
}

async function stopProxy() {
  await api("/api/proxy/stop", { method: "POST", body: "{}" });
  showToast("模型代理已停止");
  await loadState();
}

async function startWatcher() {
  await api("/api/watcher/start", {
    method: "POST",
    body: JSON.stringify({
      processNames: elements.processNamesInput.value,
      mode: elements.modeSelect.value,
      allow: elements.allowInput.value,
      killOnBlock: elements.killOnBlockInput.checked
    })
  });
  showToast("App 监控已启动");
  await loadState();
}

async function stopWatcher() {
  await api("/api/watcher/stop", { method: "POST", body: "{}" });
  showToast("App 监控已停止");
  await loadState();
}

async function inspectCommand() {
  const command = elements.commandInput.value.trim();
  if (!command) {
    showToast("请先输入要检查的命令");
    return;
  }
  const decision = await api("/api/inspect", {
    method: "POST",
    body: JSON.stringify({
      command,
      mode: elements.modeSelect.value,
      allow: elements.allowInput.value
    })
  });
  renderDecision(decision);
}

function renderDecision(decision) {
  elements.decisionBox.replaceChildren();
  const dot = document.createElement("span");
  dot.className = `risk-dot ${decision.severity}`;
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${riskLabel(decision.severity)}，动作：${decision.action === "block" ? "拦截" : "放行"}`;
  const message = document.createElement("p");
  message.textContent = decision.message;
  body.append(title, message);

  if (decision.reasons?.length) {
    const detail = document.createElement("p");
    detail.textContent = decision.reasons.map((reason) => `${reason.code}: ${reason.evidence || reason.message}`).join(" | ");
    body.append(detail);
  }

  if (decision.matchedPaths?.length) {
    const paths = document.createElement("p");
    paths.textContent = `涉及路径：${decision.matchedPaths.join(", ")}`;
    body.append(paths);
  }

  elements.decisionBox.append(dot, body);
}

function riskLabel(severity) {
  return {
    info: "无明显风险",
    low: "低风险",
    medium: "中风险",
    high: "高风险",
    critical: "严重风险"
  }[severity] || severity;
}

async function copyProxyUrl() {
  await navigator.clipboard.writeText(elements.localProxyUrl.textContent);
  showToast("本地 Base URL 已复制");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 2400);
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => loadState().catch(showError));
  elements.reloadLogsButton.addEventListener("click", () => loadState().catch(showError));
  elements.startProxyButton.addEventListener("click", () => startProxy().catch(showError));
  elements.stopProxyButton.addEventListener("click", () => stopProxy().catch(showError));
  elements.startWatcherButton.addEventListener("click", () => startWatcher().catch(showError));
  elements.stopWatcherButton.addEventListener("click", () => stopWatcher().catch(showError));
  elements.inspectButton.addEventListener("click", () => inspectCommand().catch(showError));
  elements.copyProxyButton.addEventListener("click", () => copyProxyUrl().catch(showError));
  elements.portInput.addEventListener("input", updateProxyUrl);
  elements.modeSelect.addEventListener("change", updateModeLabel);
}

function showError(error) {
  console.error(error);
  showToast(error instanceof Error ? error.message : String(error));
}

bindEvents();
loadState().catch(showError);
window.setInterval(() => loadState().catch(() => {}), 6000);
