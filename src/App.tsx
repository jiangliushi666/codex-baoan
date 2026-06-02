import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Download, FolderOpen, Play, RefreshCw, Shield, Square, Trash2, Wrench, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppState, DiscoveredProvider, GuardMode, InspectDecision } from "./types";

const emptyState: AppState = {
  app: { version: "0.2.0", install_dir: "", bundle_managed: true, updater_configured: false },
  discovery: { generated_at: "", providers: [], sources: [], manual_fallback_reason: "正在读取本机配置" },
  runtime: { running: false, mode: "audit" }
};

export function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [activeTab, setActiveTab] = useState("codex");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<GuardMode>("audit");
  const [command, setCommand] = useState("");
  const [decision, setDecision] = useState<InspectDecision | null>(null);
  const [toast, setToast] = useState("");

  const recommended = useMemo(
    () => state.discovery.providers.find((item) => item.id === state.discovery.recommended_provider_id),
    [state.discovery.providers, state.discovery.recommended_provider_id]
  );

  async function refresh() {
    const next = await invoke<AppState>("get_state");
    setState(next);
    setMode(next.runtime.mode);
  }

  async function start(provider?: DiscoveredProvider) {
    const target = provider || recommended || state.discovery.providers.find((item) => item.status !== "unconfigured");
    if (!target) {
      notify("没有发现可用上游");
      return;
    }
    const next = await invoke<AppState>("start_guard", { providerId: target.id, mode });
    setState(next);
    notify("保护已启用");
  }

  async function stop() {
    const next = await invoke<AppState>("stop_guard");
    setState(next);
    notify("保护已停止");
  }

  async function inspect() {
    if (!command.trim()) {
      notify("先输入命令");
      return;
    }
    const result = await invoke<InspectDecision>("inspect_command", { command, mode });
    setDecision(result);
  }

  async function checkUpdate() {
    await invoke("open_releases");
    notify("已打开最新版本页面");
  }

  async function openInstallPackage() {
    await invoke("open_releases");
    notify("已打开安装包页面");
  }

  async function openInstallDir() {
    await invoke("open_install_dir");
    notify("已打开安装目录");
  }

  async function openUninstallSettings() {
    await invoke("open_uninstall_settings");
    notify("已打开系统卸载入口");
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  useEffect(() => {
    refresh().catch((error) => notify(String(error)));
  }, []);

  const providers = activeTab === "ccswitch"
    ? state.discovery.providers.filter((item) => item.source === "ccswitch")
    : activeTab === "plus"
      ? state.discovery.providers.filter((item) => item.source !== "ccswitch")
      : state.discovery.providers;

  return (
    <main className="shell">
      <header className="topbar" data-tauri-drag-region>
        <div className="traffic" aria-hidden="true"><span /><span /><span /></div>
        <div className="brand">
          <div className="brandMark"><Shield size={22} /></div>
          <div>
            <h1>Codex 保安</h1>
            <p>{state.discovery.providers.length ? "已发现 " + state.discovery.providers.length + " 个上游" : "正在读取本机配置"}</p>
          </div>
        </div>
        <nav className="tabs" aria-label="view switcher">
          <button className={activeTab === "codex" ? "active" : ""} onClick={() => setActiveTab("codex")}>Codex</button>
          <button className={activeTab === "ccswitch" ? "active" : ""} onClick={() => setActiveTab("ccswitch")}>ccswitch</button>
          <button className={activeTab === "plus" ? "active" : ""} onClick={() => setActiveTab("plus")}>Codex++</button>
          <button className={activeTab === "logs" ? "active" : ""} onClick={() => setActiveTab("logs")}>状态</button>
        </nav>
        <div className="toolbar">
          <button className="iconButton" title="重新扫描" onClick={() => refresh().then(() => notify("已重新扫描"))}><RefreshCw size={18} /></button>
          <button className="iconButton" title="应用设置" onClick={() => setSettingsOpen(true)}><Wrench size={18} /></button>
          <button className="primaryRound" title="一键保护" onClick={() => state.runtime.running ? stop() : start()}>{state.runtime.running ? <Square size={18} /> : <Play size={18} fill="currentColor" />}</button>
        </div>
      </header>

      <section className="statusLine">
        <div>
          <strong>{state.runtime.running ? "已接管" : "未接管"}</strong>
          <span>{state.runtime.running ? state.runtime.provider_name : state.discovery.manual_fallback_reason}</span>
        </div>
        <div className="pills">
          {state.discovery.sources.map((source) => <span className={["pill", source.status].join(" ")} key={source.id}>{source.label} · {source.status === "ok" ? source.provider_count : source.status === "missing" ? "未找到" : "错误"}</span>)}
        </div>
      </section>

      {activeTab === "logs" ? <StatusPanel state={state} /> : (
        <>
          <div className="sectionTitle"><h2>{activeTab === "ccswitch" ? "ccswitch 来源" : activeTab === "plus" ? "Codex++ / Codex" : "Codex 上游"}</h2><p>选择一行即可启用本地保护，密钥只在 Rust 后端读取。</p></div>
          <section className="providerList">
            {providers.length ? providers.map((provider) => <ProviderRow key={provider.id} provider={provider} runningId={state.runtime.provider_id} onStart={() => start(provider)} />) : <EmptyRow />}
          </section>
          <section className="inspectRow">
            <div className="dragHandle">⋮⋮</div>
            <div className="riskIcon"><AlertTriangle size={20} /></div>
            <div className="inspectMain">
              <div className="titleLine"><h3>命令风险检查</h3>{decision && <span className={["riskBadge", decision.severity].join(" ")}>{riskLabel(decision.severity)}</span>}</div>
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="粘贴一条命令，例如 Get-Content C:/Users/j/.ssh/id_rsa" />
              <p>{decision ? (decision.action === "block" ? "会拦截。" : "会放行。") + decision.message + (decision.matched_paths.length ? " 路径：" + decision.matched_paths.join(", ") : "") : "检查风险级别、原因和命中的路径。"}</p>
            </div>
            <button className="ghostButton" onClick={inspect}>检查</button>
          </section>
        </>
      )}

      <aside className={["drawer", settingsOpen ? "open" : ""].join(" ")}>
        <div className="drawerHeader"><h2>应用设置</h2><button className="iconButton" onClick={() => setSettingsOpen(false)}><XCircle size={18} /></button></div>
        <label className="field"><span>模式</span><select value={mode} onChange={(event) => setMode(event.target.value as GuardMode)}><option value="audit">仅记录</option><option value="block">拦截高危</option></select></label>
        <div className="management">
          <div className="managementTitle"><h3>应用管理</h3><span>v{state.app.version}</span></div>
          <div className="managementActions">
            <button onClick={openInstallPackage}><Download size={15} /> 安装包</button>
            <button onClick={checkUpdate}><RefreshCw size={15} /> 检查升级</button>
            <button onClick={openUninstallSettings}><Trash2 size={15} /> 卸载入口</button>
            <button onClick={openInstallDir}><FolderOpen size={15} /> 安装目录</button>
          </div>
          <p>{state.app.bundle_managed ? "Tauri 安装器已接管安装和卸载；升级时安装最新 Release。" : "开发模式：正式安装包由 pnpm tauri build 生成。"}</p>
        </div>
        <div className="configPath"><span>安装目录</span><code>{state.app.install_dir || "未安装"}</code></div>
      </aside>

      <div className={["toast", toast ? "show" : ""].join(" ")}>{toast}</div>
    </main>
  );
}

function ProviderRow({ provider, runningId, onStart }: { provider: DiscoveredProvider; runningId?: string; onStart: () => void }) {
  const running = runningId === provider.id;
  const disabled = provider.status === "unconfigured" || running;
  return <article className={["providerRow", running ? "active" : "", provider.is_recommended ? "recommended" : ""].join(" ")}>
    <div className="dragHandle">⋮⋮</div>
    <div className={["providerIcon", provider.source].join(" ")}>{provider.source === "ccswitch" ? "C" : provider.source === "codexplusplus" ? "++" : "~"}</div>
    <div className="providerMain">
      <div className="titleLine"><h3>{provider.name}</h3><span className={provider.status === "ready" ? "readyBadge" : "mutedBadge"}>{running ? "运行中" : providerStatus(provider.status)}</span></div>
      <p>{provider.base_url || "未配置上游 URL"}</p>
      <div className="badges">{provider.is_recommended && <span>推荐</span>}{provider.is_current && <span>当前</span>}<span>{provider.has_api_key ? "已读取密钥" : "使用现有登录"}</span></div>
    </div>
    <div className="providerMeta"><span>{provider.source_label}</span><span>{provider.model || provider.protocol || "Codex"}</span></div>
    <button className="rowAction" disabled={disabled} onClick={onStart}>{running ? "已启用" : disabled ? "不可用" : "启用"}</button>
  </article>;
}

function EmptyRow() {
  return <article className="providerRow empty"><div className="providerIcon muted">-</div><div className="providerMain"><div className="titleLine"><h3>这里没有来源</h3></div><p>安装 ccswitch / Codex++ 或配置 Codex 后重新扫描。</p></div></article>;
}

function StatusPanel({ state }: { state: AppState }) {
  return <section className="statusPanel">
    <div><h2>运行状态</h2><p>{state.runtime.running ? state.runtime.provider_name + " · " + state.runtime.mode : "保护未启用"}</p></div>
    <div><h2>安装方式</h2><p>{state.app.bundle_managed ? "Tauri bundle managed" : "development mode"}</p></div>
    <div><h2>更新</h2><p>{state.app.updater_configured ? "Updater configured" : "GitHub Releases"}</p></div>
  </section>;
}

function providerStatus(status: string) {
  return ({ ready: "可用", "needs-auth": "需要登录", unconfigured: "未配置" } as Record<string, string>)[status] || status;
}

function riskLabel(severity: string) {
  return ({ info: "无风险", low: "低", medium: "中", high: "高", critical: "严重" } as Record<string, string>)[severity] || severity;
}
