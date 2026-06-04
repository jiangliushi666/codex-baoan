import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  Gauge,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, DiscoveredProvider, GuardMode, InspectDecision, ViewId } from "./types";

const emptyState: AppState = {
  app: { version: "0.2.0", install_dir: "", bundle_managed: true, updater_configured: false },
  discovery: { generated_at: "", providers: [], sources: [], manual_fallback_reason: "正在读取本机配置" },
  runtime: { running: false, mode: "audit" }
};

const navItems: Array<{ id: ViewId; label: string; hint: string }> = [
  { id: "all", label: "全部供应商", hint: "按来源分组" },
  { id: "ccswitch", label: "ccswitch", hint: "模型供应商" },
  { id: "codexplusplus", label: "Codex++", hint: "模型供应商" },
  { id: "codex-config", label: "Codex 配置", hint: "模型供应商" },
  { id: "status", label: "状态", hint: "运行概览" }
];

export function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [activeTab, setActiveTab] = useState<ViewId>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<GuardMode>("audit");
  const [command, setCommand] = useState("");
  const [decision, setDecision] = useState<InspectDecision | null>(null);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [managementBusy, setManagementBusy] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const toastTimerRef = useRef<number | null>(null);

  const recommended = useMemo(
    () => state.discovery.providers.find((item) => item.id === state.discovery.recommended_provider_id),
    [state.discovery.providers, state.discovery.recommended_provider_id]
  );

  const notify = useCallback((message: string) => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToast("");
      toastTimerRef.current = null;
    }, 2400);
  }, []);

  const fail = useCallback((err: unknown) => {
    setError(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
  }, []);

  const refresh = useCallback(
    async (announce?: string) => {
      setScanning(true);
      setError("");
      try {
        const next = await invoke<AppState>("get_state");
        setState(next);
        setMode(next.runtime.mode);
        if (announce) notify(announce);
      } catch (err) {
        fail(err);
      } finally {
        setScanning(false);
        setLoading(false);
      }
    },
    [fail, notify]
  );

  async function start(provider?: DiscoveredProvider) {
    const target = provider || recommended || state.discovery.providers.find((item) => item.status !== "unconfigured");
    if (!target) {
      setError("没有发现可用模型供应商，请先在 ccswitch、Codex++ 或 Codex 中配置 provider 后重新扫描。");
      return;
    }
    setActionBusy(true);
    setError("");
    try {
      const next = await invoke<AppState>("start_guard", { providerId: target.id, mode });
      setState(next);
      setMode(next.runtime.mode);
      notify(`保护已启用 · ${target.name}`);
    } catch (err) {
      fail(err);
    } finally {
      setActionBusy(false);
    }
  }

  async function stop() {
    setActionBusy(true);
    setError("");
    try {
      const next = await invoke<AppState>("stop_guard");
      setState(next);
      setMode(next.runtime.mode);
      notify("保护已停止");
    } catch (err) {
      fail(err);
    } finally {
      setActionBusy(false);
    }
  }

  async function inspect() {
    if (!command.trim()) {
      setError("先输入要检查的命令。");
      return;
    }
    setInspecting(true);
    setError("");
    try {
      const result = await invoke<InspectDecision>("inspect_command", { command, mode });
      setDecision(result);
    } catch (err) {
      fail(err);
    } finally {
      setInspecting(false);
    }
  }

  async function runManaged(id: string, message: string, action: () => Promise<unknown>) {
    setManagementBusy(id);
    setError("");
    try {
      await action();
      notify(message);
    } catch (err) {
      fail(err);
    } finally {
      setManagementBusy(null);
    }
  }

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    window.setTimeout(() => settingsButtonRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    refresh().catch(fail);
  }, [fail, refresh]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    window.setTimeout(() => drawerCloseRef.current?.focus(), 0);
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSettings, settingsOpen]);

  const providers = useMemo(() => {
    if (activeTab === "status" || activeTab === "all") return state.discovery.providers;
    return state.discovery.providers.filter((item) => item.source === activeTab);
  }, [activeTab, state.discovery.providers]);

  const readyCount = state.discovery.providers.filter((provider) => provider.status === "ready").length;
  const currentView = navItems.find((item) => item.id === activeTab) || navItems[0];
  const primaryActionLabel = state.runtime.running ? "停止本地保护" : "启动推荐模型供应商保护";

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark" aria-hidden="true">
            <ShieldCheck size={21} />
          </div>
          <div>
            <h1>Codex 保安</h1>
            <p>Tauri 桌面应用 · v{state.app.version}</p>
          </div>
        </div>

        <nav className="navList" aria-label="模型供应商来源筛选">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={activeTab === item.id ? "active" : ""}
              aria-pressed={activeTab === item.id}
              onClick={() => setActiveTab(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>

        <div className="sidebarFooter">
          <div className="modeCard">
            <span>模式</span>
            <strong>{mode === "block" ? "拦截高危" : "仅记录"}</strong>
          </div>
          <button
            ref={settingsButtonRef}
            className="settingsButton"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label="打开应用设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={17} />
            设置
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="statusCluster">
            <span
              className={["runDot", state.runtime.running ? "online" : ""].join(" ")}
              role="img"
              aria-label={state.runtime.running ? "保护运行中" : "保护未启用"}
            />
            <div>
              <p>{state.runtime.running ? "本地保护运行中" : "本地保护未启用"}</p>
              <strong>{state.runtime.running ? state.runtime.provider_name : state.discovery.manual_fallback_reason}</strong>
            </div>
          </div>
          <div className="toolbar">
            <button
              className="iconButton"
              title="重新扫描"
              aria-label="重新扫描本机配置"
              disabled={scanning || loading}
              onClick={() => refresh("已重新扫描")}
            >
              <RefreshCw size={18} className={scanning ? "spin" : ""} />
            </button>
            <button
              className={["primaryAction", state.runtime.running ? "stop" : ""].join(" ")}
              disabled={actionBusy || loading}
              aria-label={primaryActionLabel}
              onClick={() => (state.runtime.running ? stop() : start())}
            >
              {actionBusy ? (
                <Loader2 size={17} className="spin" />
              ) : state.runtime.running ? (
                <Square size={17} />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
              {actionBusy ? "处理中" : state.runtime.running ? "停止" : "启动"}
            </button>
          </div>
        </header>

        {error && (
          <div className="errorBanner" role="alert">
            <AlertTriangle size={17} />
            <p>{error}</p>
            <button className="bannerClose" aria-label="关闭提示" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}

        <section className="metrics" aria-label="运行指标">
          <Metric
            icon={<Server size={18} />}
            label="模型供应商"
            value={loading ? "…" : state.discovery.providers.length}
            detail={loading ? "扫描中" : `${readyCount} 个可用`}
          />
          <Metric
            icon={<CheckCircle2 size={18} />}
            label="推荐"
            value={recommended?.name || "-"}
            detail={recommended?.source_label || (loading ? "扫描中" : "等待扫描")}
          />
          <Metric
            icon={<Gauge size={18} />}
            label="策略"
            value={mode === "block" ? "拦截" : "审计"}
            detail={state.runtime.local_proxy_url || "本机代理"}
          />
        </section>

        {activeTab === "status" ? (
          <StatusPanel state={state} />
        ) : (
          <div className="contentStack">
            <div className="sectionHeader">
              <div>
                <h2>{currentView.label}</h2>
                <p>
                  {loading
                    ? "正在扫描本机配置…"
                    : providers.length
                      ? activeTab === "all"
                        ? `${providers.length} 个模型供应商，已按来源分组`
                        : `${providers.length} 个模型供应商`
                      : "没有匹配的模型供应商"}
                </p>
              </div>
              <div className="sourcePills" aria-label="来源扫描结果">
                {state.discovery.sources.map((source) => (
                  <span className={["sourcePill", source.status].join(" ")} key={source.id} title={source.path}>
                    {source.label}
                    <strong>
                      {source.status === "ok" ? source.provider_count : source.status === "missing" ? "未找到" : "错误"}
                    </strong>
                  </span>
                ))}
              </div>
            </div>

            <section className="providerList" aria-busy={loading}>
              {loading ? (
                <LoadingRow />
              ) : providers.length ? (
                activeTab === "all" ? (
                  <GroupedProviderList
                    providers={providers}
                    runningId={state.runtime.provider_id}
                    busy={actionBusy}
                    onStart={start}
                  />
                ) : (
                  providers.map((provider) => (
                    <ProviderRow
                      key={provider.id}
                      provider={provider}
                      runningId={state.runtime.provider_id}
                      busy={actionBusy}
                      onStart={() => start(provider)}
                    />
                  ))
                )
              ) : (
                <EmptyRow scanning={scanning} onRescan={() => refresh("已重新扫描")} />
              )}
            </section>

            <section className="inspectPanel" aria-labelledby="inspect-title">
              <div className="inspectIcon" aria-hidden="true">
                <Terminal size={20} />
              </div>
              <div className="inspectMain">
                <div className="titleLine">
                  <h3 id="inspect-title">命令检查</h3>
                  {decision && <span className={["riskBadge", decision.severity].join(" ")}>{riskLabel(decision.severity)}</span>}
                </div>
                <div className="commandInput">
                  <label className="srOnly" htmlFor="inspect-command">
                    要检查的命令
                  </label>
                  <input
                    id="inspect-command"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") inspect();
                    }}
                    placeholder="Get-Content C:/Users/j/.ssh/id_rsa"
                  />
                  <button className="ghostButton" disabled={inspecting} onClick={inspect}>
                    {inspecting ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
                    {inspecting ? "检查中" : "检查"}
                  </button>
                </div>
                <p aria-live="polite">
                  {decision
                    ? (decision.action === "block" ? "拦截 · " : "放行 · ") +
                      decision.message +
                      (decision.matched_paths.length ? " · " + decision.matched_paths.join(", ") : "")
                    : "输入命令后按 Enter 或点击检查，返回风险级别、处置动作和命中路径。"}
                </p>
              </div>
            </section>
          </div>
        )}
      </section>

      {settingsOpen && (
        <>
          <div className="drawerOverlay" onClick={closeSettings} aria-hidden="true" />
          <aside className="drawer open" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="drawerHeader">
              <div>
                <h2 id="settings-title">设置</h2>
                <p>Codex 保安 v{state.app.version}</p>
              </div>
              <button ref={drawerCloseRef} className="iconButton" aria-label="关闭设置" onClick={closeSettings}>
                <X size={18} />
              </button>
            </div>
            <label className="field">
              <span>保护模式</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as GuardMode)}>
                <option value="audit">仅记录</option>
                <option value="block">拦截高危</option>
              </select>
            </label>
            <div className="management">
              <div className="managementTitle">
                <h3>应用管理</h3>
                <span>{state.app.bundle_managed ? "正式安装" : "开发模式"}</span>
              </div>
              <div className="managementActions">
                <button
                  disabled={managementBusy !== null}
                  onClick={() => runManaged("releases", "已打开安装包页面", () => invoke("open_releases"))}
                >
                  {managementBusy === "releases" ? <Loader2 size={15} className="spin" /> : <Download size={15} />} 安装包
                </button>
                <button
                  disabled={managementBusy !== null}
                  onClick={() => runManaged("upgrade", "已打开最新版本页面", () => invoke("open_releases"))}
                >
                  {managementBusy === "upgrade" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 检查升级
                </button>
                <button
                  disabled={managementBusy !== null}
                  onClick={() => runManaged("uninstall", "已打开系统卸载入口", () => invoke("open_uninstall_settings"))}
                >
                  {managementBusy === "uninstall" ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} 卸载入口
                </button>
                <button
                  disabled={managementBusy !== null}
                  onClick={() => runManaged("install-dir", "已打开安装目录", () => invoke("open_install_dir"))}
                >
                  {managementBusy === "install-dir" ? <Loader2 size={15} className="spin" /> : <FolderOpen size={15} />} 安装目录
                </button>
              </div>
              <p>{state.app.updater_configured ? "已配置自动更新。" : "升级入口使用 GitHub Releases。"}</p>
            </div>
            <div className="configPath">
              <span>安装目录</span>
              <code>{state.app.install_dir || "未安装"}</code>
            </div>
          </aside>
        </>
      )}

      <div className={["toast", toast ? "show" : ""].join(" ")} role="status" aria-live="polite" aria-atomic="true">
        {toast}
      </div>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
  detail
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="metric">
      <div className="metricIcon" aria-hidden="true">
        {icon}
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function GroupedProviderList({
  providers,
  runningId,
  busy,
  onStart
}: {
  providers: DiscoveredProvider[];
  runningId?: string;
  busy: boolean;
  onStart: (provider: DiscoveredProvider) => void;
}) {
  const groups = groupProviders(providers);
  return (
    <div className="providerGroups">
      {groups.map((group) => (
        <section className="providerGroup" key={group.id} aria-labelledby={`provider-group-${group.id}`}>
          <div className="providerGroupHeader">
            <div>
              <h3 id={`provider-group-${group.id}`}>{group.label}</h3>
              <p>{group.providers.length} 个模型供应商</p>
            </div>
          </div>
          <div className="providerGroupRows">
            {group.providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                runningId={runningId}
                busy={busy}
                onStart={() => onStart(provider)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ProviderRow({
  provider,
  runningId,
  busy,
  onStart
}: {
  provider: DiscoveredProvider;
  runningId?: string;
  busy: boolean;
  onStart: () => void;
}) {
  const running = runningId === provider.id;
  const disabled = provider.status === "unconfigured" || running || busy;
  const actionText = running
    ? "运行中"
    : provider.status === "unconfigured"
      ? "未配置"
      : provider.status === "needs-auth"
        ? "使用登录态启用"
        : "启用";

  return (
    <article
      className={["providerRow", running ? "active" : "", provider.is_recommended ? "recommended" : ""].join(" ")}
      aria-current={running ? "true" : undefined}
    >
      <div className={["providerIcon", sourceClass(provider.source)].join(" ")} aria-hidden="true">
        {provider.source === "ccswitch" ? "C" : provider.source === "codexplusplus" ? "++" : "~"}
      </div>
      <div className="providerMain">
        <div className="titleLine">
          <h3>{provider.name}</h3>
          <span className={provider.status === "ready" ? "readyBadge" : "mutedBadge"}>
            {running ? "运行中" : providerStatus(provider.status)}
          </span>
          {provider.is_recommended && <span className="subtleBadge">推荐</span>}
          {provider.is_current && <span className="subtleBadge">当前</span>}
        </div>
        <p title={provider.source_path}>{provider.base_url || "未配置模型供应商 URL"}</p>
        <div className="providerDetails">
          <span>{provider.source_label}</span>
          <span>{provider.model || provider.protocol || "Codex"}</span>
          <span title={provider.has_api_key ? provider.masked_api_key || "已配置密钥" : "使用登录态"}>
            {provider.has_api_key ? provider.masked_api_key || "API Key" : "登录态"}
          </span>
          <span>{provider.status_text}</span>
        </div>
      </div>
      <button className="rowAction" disabled={disabled} aria-label={`${actionText} ${provider.name}`} onClick={onStart}>
        {busy && !running ? <Loader2 size={15} className="spin" /> : null}
        {actionText}
      </button>
    </article>
  );
}

function LoadingRow() {
  return (
    <div className="loadingRow" aria-label="正在扫描">
      <Loader2 size={20} className="spin" />
      <span>正在扫描本机配置…</span>
    </div>
  );
}

function EmptyRow({ scanning, onRescan }: { scanning: boolean; onRescan: () => void }) {
  return (
    <article className="providerRow empty">
      <div className="providerIcon muted" aria-hidden="true">
        -
      </div>
      <div className="providerMain">
        <div className="titleLine">
          <h3>没有来源</h3>
        </div>
        <p>安装 ccswitch / Codex++ 或配置 Codex 后重新扫描模型供应商。</p>
      </div>
      <button className="rowAction" disabled={scanning} onClick={onRescan}>
        {scanning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
        重新扫描
      </button>
    </article>
  );
}

function StatusPanel({ state }: { state: AppState }) {
  return (
    <section className="statusPanel">
      <div className="statusBlock">
        <Activity size={19} />
        <span>运行状态</span>
        <strong>{state.runtime.running ? state.runtime.provider_name : "未启用"}</strong>
        <p>{state.runtime.running ? state.runtime.mode : "等待启动"}</p>
      </div>
      <div className="statusBlock">
        <Download size={19} />
        <span>安装方式</span>
        <strong>{state.app.bundle_managed ? "Tauri 安装包" : "开发模式"}</strong>
        <p>{state.app.install_dir || "未安装"}</p>
      </div>
      <div className="statusBlock">
        <RefreshCw size={19} />
        <span>更新</span>
        <strong>{state.app.updater_configured ? "自动更新" : "GitHub Releases"}</strong>
        <p>{state.discovery.generated_at || "等待扫描"}</p>
      </div>
    </section>
  );
}

function providerStatus(status: string) {
  return ({ ready: "可用", "needs-auth": "需要登录", unconfigured: "未配置" } as Record<string, string>)[status] || status;
}

function groupProviders(providers: DiscoveredProvider[]) {
  const labels: Record<string, string> = {
    ccswitch: "ccswitch 模型供应商",
    codexplusplus: "Codex++ 模型供应商",
    "codex-config": "Codex 配置模型供应商"
  };
  const order = ["ccswitch", "codexplusplus", "codex-config"];
  const grouped = new Map<string, DiscoveredProvider[]>();
  for (const provider of providers) {
    const key = provider.source || "unknown";
    grouped.set(key, [...(grouped.get(key) || []), provider]);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => {
      const left = order.indexOf(a);
      const right = order.indexOf(b);
      return (left === -1 ? 99 : left) - (right === -1 ? 99 : right) || a.localeCompare(b);
    })
    .map(([id, items]) => ({ id: sourceClass(id), label: labels[id] || `${items[0]?.source_label || id} 模型供应商`, providers: items }));
}

function riskLabel(severity: string) {
  return ({ info: "无风险", low: "低", medium: "中", high: "高", critical: "严重" } as Record<string, string>)[severity] || severity;
}

function sourceClass(source: string) {
  return source.replace(/[^a-z0-9_-]/gi, "-");
}
