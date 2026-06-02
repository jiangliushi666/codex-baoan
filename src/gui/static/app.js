const $ = (id) => document.getElementById(id);

const el = {
  tabs: [...document.querySelectorAll(".tab-button")],
  views: {
    app: $("view-app"),
    cli: $("view-cli"),
    logs: $("view-logs")
  },
  settingsButton: $("settingsButton"),
  closeSettingsButton: $("closeSettingsButton"),
  settingsPanel: $("settingsPanel"),
  quickToggleButton: $("quickToggleButton"),
  quickStartButton: $("quickStartButton"),
  stopAllButton: $("stopAllButton"),
  copyProxyButton: $("copyProxyButton"),
  copyCliButton: $("copyCliButton"),
  copyInstallButton: $("copyInstallButton"),
  inspectButton: $("inspectButton"),
  commandInput: $("commandInput"),
  inspectBadge: $("inspectBadge"),
  decisionText: $("decisionText"),
  heroTitle: $("heroTitle"),
  heroText: $("heroText"),
  trustMeter: $("trustMeter"),
  protectionRow: $("protectionRow"),
  protectionBadge: $("protectionBadge"),
  protectionSubtitle: $("protectionSubtitle"),
  proxyMiniStatus: $("proxyMiniStatus"),
  watchMiniStatus: $("watchMiniStatus"),
  modeBadge: $("modeBadge"),
  localProxyUrl: $("localProxyUrl"),
  upstreamLabel: $("upstreamLabel"),
  proxySessionText: $("proxySessionText"),
  watchSessionText: $("watchSessionText"),
  processLabel: $("processLabel"),
  cliCommand: $("cliCommand"),
  installCommand: $("installCommand"),
  sessionList: $("sessionList"),
  logView: $("logView"),
  installState: $("installState"),
  configPath: $("configPath"),
  upstreamInput: $("upstreamInput"),
  portInput: $("portInput"),
  modeSelect: $("modeSelect"),
  allowInput: $("allowInput"),
  processNamesInput: $("processNamesInput"),
  killOnBlockInput: $("killOnBlockInput"),
  saveSettingsButton: $("saveSettingsButton"),
  toast: $("toast")
};

let latestState = null;
let hydrated = false;
let selectedSessionId = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}

async function loadState() {
  latestState = await api("/api/state");
  if (!hydrated) {
    hydrate(latestState);
    hydrated = true;
  }
  render(latestState);
}

function hydrate(state) {
  const config = state.config;
  el.installState.textContent = "本机防护控制台";
  el.configPath.textContent = state.configPath;
  el.upstreamInput.value = config.modelProxy.upstreamBaseUrl || "https://api.openai.com";
  el.portInput.value = String(config.modelProxy.port || 8787);
  el.modeSelect.value = config.mode || "audit";
  el.allowInput.value = (config.scope.extraAllow || []).join("\n");
  el.processNamesInput.value = (config.appWatcher.processNames || []).join(", ");
  el.killOnBlockInput.checked = Boolean(config.appWatcher.killOnBlock);
  updateDerivedLabels();
}

function render(state) {
  const proxy = state.runtime.proxy;
  const watcher = state.runtime.watcher;
  const proxyRunning = Boolean(proxy.running);
  const watcherRunning = Boolean(watcher.running);
  const fullyProtected = proxyRunning && watcherRunning;
  const partiallyProtected = proxyRunning || watcherRunning;

  el.configPath.textContent = state.configPath;
  el.protectionRow.classList.toggle("active", fullyProtected);
  el.protectionBadge.classList.toggle("off", !fullyProtected);
  el.protectionBadge.textContent = fullyProtected ? "当前使用" : partiallyProtected ? "部分启用" : "未启用";
  el.protectionSubtitle.textContent = fullyProtected
    ? "Codex App 流量和进程已处于监控中。"
    : "模型代理 + App 进程监控，一键开启。";
  el.proxyMiniStatus.textContent = `代理：${proxyRunning ? "运行中" : "未启动"}`;
  el.watchMiniStatus.textContent = `监控：${watcherRunning ? "运行中" : "未启动"}`;
  el.proxySessionText.textContent = proxyRunning ? shortPath(proxy.sessionDir) : "无会话";
  el.watchSessionText.textContent = watcherRunning ? shortPath(watcher.sessionDir) : "无会话";

  el.quickStartButton.textContent = partiallyProtected ? "停止防护" : "一键开启";
  el.quickStartButton.classList.toggle("stop", partiallyProtected);
  el.stopAllButton.disabled = !partiallyProtected;
  el.quickToggleButton.textContent = partiallyProtected ? "×" : "+";
  el.quickToggleButton.title = partiallyProtected ? "停止防护" : "一键开启防护";

  el.trustMeter.classList.toggle("active", fullyProtected);
  el.trustMeter.classList.toggle("partial", partiallyProtected && !fullyProtected);
  el.trustMeter.querySelector("strong").textContent = fullyProtected ? "已接管" : partiallyProtected ? "部分启用" : "待启动";
  el.heroTitle.textContent = fullyProtected ? "Codex App 已被接管" : partiallyProtected ? "防护已部分启用" : "未接管 Codex App";
  el.heroText.textContent = fullyProtected
    ? `把 Codex App 的 Base URL 保持为 ${proxy.url}，模型返回和进程行为会持续记录。`
    : "点击一键开启后，把 Codex App 的 Base URL 指向本机地址即可开始记录和拦截。";

  if (proxyRunning) {
    el.localProxyUrl.textContent = proxy.url;
    el.upstreamLabel.textContent = proxy.upstream;
  } else {
    updateDerivedLabels();
  }
  renderSessions(state.sessions || []);
}

function updateDerivedLabels() {
  const port = el.portInput.value.trim() || "8787";
  const upstream = el.upstreamInput.value.trim() || "https://api.openai.com";
  el.localProxyUrl.textContent = `http://127.0.0.1:${port}`;
  el.upstreamLabel.textContent = upstream;
  el.modeBadge.textContent = el.modeSelect.value === "block" ? "拦截高危" : "只记录";
  el.processLabel.textContent = el.processNamesInput.value.trim() || "codex, Codex, codex-app";
}

async function toggleProtection() {
  const running = latestState?.runtime?.proxy?.running || latestState?.runtime?.watcher?.running;
  if (running) {
    await stopProtection();
  } else {
    await api("/api/quick/start", {
      method: "POST",
      body: JSON.stringify(currentControlValues())
    });
    showToast("防护已开启");
  }
  await loadState();
}

async function stopProtection() {
  await api("/api/quick/stop", { method: "POST", body: "{}" });
  showToast("防护已停止");
  await loadState();
}

function currentControlValues() {
  return {
    upstream: el.upstreamInput.value.trim(),
    port: Number(el.portInput.value || 8787),
    mode: el.modeSelect.value,
    allow: el.allowInput.value,
    processNames: el.processNamesInput.value,
    killOnBlock: el.killOnBlockInput.checked
  };
}

async function inspectCommand() {
  const command = el.commandInput.value.trim();
  if (!command) {
    showToast("请先输入命令");
    return;
  }
  const decision = await api("/api/inspect", {
    method: "POST",
    body: JSON.stringify({ command, mode: el.modeSelect.value, allow: el.allowInput.value })
  });
  el.inspectBadge.textContent = riskLabel(decision.severity);
  el.inspectBadge.className = `soft-badge risk-${decision.severity}`;
  const paths = decision.matchedPaths?.length ? ` 涉及路径：${decision.matchedPaths.join(", ")}` : "";
  el.decisionText.textContent = `${decision.action === "block" ? "会拦截" : "会放行"}。${decision.message}${paths}`;
}

async function saveSettings() {
  const config = structuredClone(latestState.config);
  config.mode = el.modeSelect.value;
  config.scope.extraAllow = splitLines(el.allowInput.value);
  config.modelProxy.upstreamBaseUrl = el.upstreamInput.value.trim() || config.modelProxy.upstreamBaseUrl;
  config.modelProxy.port = Number(el.portInput.value || config.modelProxy.port);
  config.appWatcher.processNames = splitLines(el.processNamesInput.value).length
    ? splitLines(el.processNamesInput.value)
    : config.appWatcher.processNames;
  config.appWatcher.killOnBlock = el.killOnBlockInput.checked;
  await api("/api/config", { method: "POST", body: JSON.stringify({ config }) });
  showToast("设置已保存");
  await loadState();
}

function renderSessions(sessions) {
  el.sessionList.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "暂无会话日志。";
    el.sessionList.append(empty);
    el.logView.textContent = "暂无日志。开启防护后会显示最近会话。";
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
    const name = document.createElement("strong");
    name.textContent = session.id;
    const time = document.createElement("span");
    time.textContent = new Date(session.updatedAt).toLocaleString();
    const dir = document.createElement("span");
    dir.textContent = session.sessionDir;
    button.append(name, time, dir);
    button.addEventListener("click", () => {
      selectedSessionId = session.id;
      renderSessions(sessions);
    });
    el.sessionList.append(button);
  }

  const selected = sessions.find((session) => session.id === selectedSessionId) || sessions[0];
  const alerts = String(selected.alerts || "").trim();
  const summary = String(selected.summary || "").trim();
  const hasRealAlert = alerts && !alerts.includes("No alerts recorded yet");
  el.logView.textContent = `${hasRealAlert ? alerts : "# Alerts\n\n暂无高危告警。"}\n\n${summary}`;
}

function switchView(name) {
  for (const tab of el.tabs) {
    tab.classList.toggle("active", tab.dataset.view === name);
  }
  for (const [viewName, node] of Object.entries(el.views)) {
    node.classList.toggle("active", viewName === name);
  }
}

async function copyText(text, message) {
  await navigator.clipboard.writeText(text);
  showToast(message);
}

function riskLabel(severity) {
  return ({ info: "无明显风险", low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" })[severity] || severity;
}

function shortPath(value) {
  const text = String(value || "");
  return text.length > 30 ? `...${text.slice(-30)}` : text;
}

function splitLines(value) {
  return String(value || "").split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => el.toast.classList.remove("show"), 2300);
}

function showError(error) {
  console.error(error);
  showToast(error instanceof Error ? error.message : String(error));
}

function bindEvents() {
  el.tabs.forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
  el.settingsButton.addEventListener("click", () => el.settingsPanel.classList.add("open"));
  el.closeSettingsButton.addEventListener("click", () => el.settingsPanel.classList.remove("open"));
  el.quickToggleButton.addEventListener("click", () => toggleProtection().catch(showError));
  el.quickStartButton.addEventListener("click", () => toggleProtection().catch(showError));
  el.stopAllButton.addEventListener("click", () => stopProtection().catch(showError));
  el.inspectButton.addEventListener("click", () => inspectCommand().catch(showError));
  el.copyProxyButton.addEventListener("click", () => copyText(el.localProxyUrl.textContent, "Base URL 已复制").catch(showError));
  el.copyCliButton.addEventListener("click", () => copyText(el.cliCommand.textContent, "CLI 命令已复制").catch(showError));
  el.copyInstallButton.addEventListener("click", () => copyText(el.installCommand.textContent, "安装命令已复制").catch(showError));
  el.saveSettingsButton.addEventListener("click", () => saveSettings().catch(showError));
  [el.upstreamInput, el.portInput, el.modeSelect, el.processNamesInput].forEach((node) => {
    node.addEventListener("input", updateDerivedLabels);
    node.addEventListener("change", updateDerivedLabels);
  });
}

bindEvents();
loadState().catch(showError);
window.setInterval(() => loadState().catch(() => {}), 6000);
