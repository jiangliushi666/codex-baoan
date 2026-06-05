import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AlertTriangle,
  Download,
  Eye,
  FileCog,
  FileMinus,
  FilePen,
  FilePlus,
  FileStack,
  FolderOpen,
  Globe,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEvent, ActivityFilter, ActivityKind, AppState, DiscoveredProvider, GuardMode } from "./types";

const emptyState: AppState = {
  app: { version: "0.2.0", install_dir: "", bundle_managed: true, updater_configured: false },
  discovery: { generated_at: "", providers: [], sources: [], manual_fallback_reason: "正在读取本机配置…" },
  runtime: { running: false, mode: "audit" },
  activity: []
};

const filters: Array<{ id: ActivityFilter; label: string }> = [
  { id: "all", label: "全部活动" },
  { id: "command", label: "命令" },
  { id: "file-read", label: "读取" },
  { id: "file-create", label: "新建" },
  { id: "file-modify", label: "修改" },
  { id: "file-delete", label: "删除" },
  { id: "network", label: "网络" },
  { id: "risk", label: "高危" }
];

export function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<GuardMode>("audit");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [managementBusy, setManagementBusy] = useState<string | null>(null);

  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLElement>(null);

  const activeUpstream = useMemo(
    () => state.discovery.providers.find((item) => item.id === state.discovery.recommended_provider_id) || state.discovery.providers[0],
    [state.discovery.providers, state.discovery.recommended_provider_id]
  );

  const filteredActivity = useMemo(() => {
    if (activityFilter === "all") return state.activity;
    return state.activity.filter((event) => event.kind === activityFilter);
  }, [activityFilter, state.activity]);

  const stats = useMemo(() => {
    const count = (kind: ActivityKind) => state.activity.filter((event) => event.kind === kind).length;
    const riskCount = state.activity.filter((event) => event.kind === "risk" || event.severity === "high" || event.severity === "critical").length;
    return {
      total: state.activity.length,
      commands: count("command"),
      reads: count("file-read"),
      creates: count("file-create"),
      modifies: count("file-modify"),
      deletes: count("file-delete"),
      network: count("network"),
      files: count("file-read") + count("file-create") + count("file-modify") + count("file-delete"),
      risks: riskCount
    };
  }, [state.activity]);

  const notify = useCallback((message: string) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
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

  async function start() {
    if (!activeUpstream) {
      setError("未检测到当前 Codex 上游。请先在 ccswitch、Codex++ 或 Codex 配置里启用一个供应商后重新扫描。");
      return;
    }
    setActionBusy(true);
    setError("");
    try {
      const next = await invoke<AppState>("start_guard", { mode });
      setState(next);
      setMode(next.runtime.mode);
      notify(`监控已启动 · ${next.runtime.provider_name || activeUpstream.name}`);
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
      notify("监控已停止");
    } catch (err) {
      fail(err);
    } finally {
      setActionBusy(false);
    }
  }

  async function clearActivity() {
    setError("");
    try {
      const activity = await invoke<ActivityEvent[]>("clear_activity");
      setState((current) => ({ ...current, activity }));
      notify("监控记录已清空");
    } catch (err) {
      fail(err);
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
    const timer = window.setInterval(() => {
      if (!settingsOpen) refresh().catch(fail);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [fail, refresh, settingsOpen]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    for (const node of [railRef.current, stageRef.current]) {
      if (!node) continue;
      if (settingsOpen) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
    }
  }, [settingsOpen]);

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

  const running = state.runtime.running;
  const primaryActionLabel = running ? "停止 Codex 监控" : "启动 Codex 监控";

  return (
    <main className="app">
      <aside className="rail" ref={railRef}>
        <header className="brand">
          <span className="brand__mark" aria-hidden="true">
            <ShieldCheck size={22} strokeWidth={2.4} />
          </span>
          <span className="brand__text">
            <strong>Codex 保安</strong>
            <small>本机监控 · v{state.app.version}</small>
          </span>
        </header>

        <section className="upstreamChip" aria-label="当前 Codex 上游">
          <span className="railLabel">当前 Codex 上游</span>
          {activeUpstream ? (
            <div className="upstreamChip__body">
              <SourceLogo source={activeUpstream.source} size={32} />
              <span className="upstreamChip__meta">
                <strong>{activeUpstream.name}</strong>
                <small>{activeUpstream.source_label}</small>
              </span>
              <span className={["dot", providerDotClass(activeUpstream.status)].join(" ")} aria-hidden="true" />
            </div>
          ) : (
            <p className="upstreamChip__empty">未检测到正在使用的供应商</p>
          )}
        </section>

        <nav className="filters" aria-label="按活动类型筛选">
          <span className="railLabel">活动筛选</span>
          {filters.map((item) => {
            const active = activityFilter === item.id;
            return (
              <button
                key={item.id}
                className={["filter", active ? "is-active" : ""].join(" ")}
                aria-pressed={active}
                onClick={() => setActivityFilter(item.id)}
              >
                <span className={["filter__icon", item.id].join(" ")} aria-hidden="true">
                  <ActivityKindIcon kind={item.id} size={15} />
                </span>
                <span className="filter__label">{item.label}</span>
                <span className="filter__count">{filterCount(item.id, state.activity)}</span>
              </button>
            );
          })}
        </nav>

        <footer className="rail__foot">
          <div className={["modePill", mode === "block" ? "is-block" : ""].join(" ")}>
            <span className="railLabel">保护策略</span>
            <strong>
              {mode === "block" ? <Shield size={14} /> : <Eye size={14} />}
              {mode === "block" ? "严格告警" : "仅记录"}
            </strong>
          </div>
          <button
            ref={settingsButtonRef}
            className="btn btn--ghost settingsBtn"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label="打开应用设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={16} />
            设置
          </button>
        </footer>
      </aside>

      <section className="stage" ref={stageRef}>
        <header className="statusbar">
          <div className="statusbar__state">
            <span
              className={["pulse", running ? "is-online" : ""].join(" ")}
              role="img"
              aria-label={running ? "监控运行中" : "监控未启用"}
            />
            <span className="statusbar__text">
              <small>{running ? "Codex 监控运行中" : loading ? "正在初始化" : activeUpstream ? "监控未启用" : "未检测到上游"}</small>
              <strong>
                {running
                  ? state.runtime.provider_name
                  : loading
                    ? "正在读取本机配置…"
                    : activeUpstream
                      ? `已就绪 · ${activeUpstream.name}`
                      : "请先启用一个 Codex 供应商"}
              </strong>
            </span>
          </div>
          <div className="statusbar__actions">
            <button
              className="btn btn--icon"
              title="重新扫描本机配置"
              aria-label="重新扫描本机配置"
              disabled={scanning || loading}
              onClick={() => refresh("已重新扫描本机配置")}
            >
              <RefreshCw size={17} className={scanning ? "spin" : ""} />
            </button>
            <button
              className={["btn", running ? "btn--stop" : "btn--primary"].join(" ")}
              disabled={actionBusy || loading}
              aria-label={primaryActionLabel}
              onClick={() => (running ? stop() : start())}
            >
              {actionBusy ? <Loader2 size={16} className="spin" /> : running ? <Square size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
              {actionBusy ? "处理中…" : running ? "停止监控" : "启动监控"}
            </button>
          </div>
        </header>

        {error && (
          <div className="banner banner--error" role="alert">
            <AlertTriangle size={17} />
            <p>{error}</p>
            <button className="banner__close" aria-label="关闭提示" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}

        <section className="kpis" aria-label="监控概览">
          <Kpi
            tone="accent"
            icon={<Activity size={17} />}
            label="活动事件"
            value={loading ? "—" : stats.total}
            detail={`${stats.commands} 命令 · ${stats.network} 网络`}
          />
          <Kpi
            tone="info"
            icon={<FileStack size={17} />}
            label="文件改动"
            value={loading ? "—" : stats.files}
            detail={`读 ${stats.reads} · 改 ${stats.modifies} · 删 ${stats.deletes}`}
          />
          <Kpi
            tone={stats.risks ? "danger" : "calm"}
            icon={<ShieldAlert size={17} />}
            label="风险命中"
            value={loading ? "—" : stats.risks}
            detail={mode === "block" ? "高危重点告警" : "高危仅记录告警"}
          />
        </section>

        <section className="board">
          <UpstreamCard loading={loading} upstream={activeUpstream} sources={state.discovery.sources.length} running={running} />
          <section className="feed">
            <div className="feed__head">
              <div>
                <h2>执行记录</h2>
                <p>命令、文件读取 / 新建 / 修改 / 删除、网络请求都会进入这里，当前显示 {filteredActivity.length} 条。</p>
              </div>
              <button className="btn btn--ghost btn--sm" disabled={!state.activity.length} onClick={clearActivity}>
                <Trash2 size={14} /> 清空
              </button>
            </div>
            <ActivityTimeline events={filteredActivity} loading={loading} filtered={activityFilter !== "all"} />
          </section>
        </section>
      </section>

      {settingsOpen && (
        <>
          <div className="overlay" onClick={closeSettings} aria-hidden="true" />
          <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="drawer__head">
              <div>
                <h2 id="settings-title">设置</h2>
                <p>Codex 保安 · v{state.app.version}</p>
              </div>
              <button ref={drawerCloseRef} className="btn btn--icon" aria-label="关闭设置" onClick={closeSettings}>
                <X size={18} />
              </button>
            </div>

            <label className="field">
              <span className="railLabel">保护模式</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as GuardMode)}>
                <option value="audit">仅记录 · 观察并告警，不干预</option>
                <option value="block">严格告警 · 高危行为重点标记</option>
              </select>
              <small className="field__hint">{mode === "block" ? "对密钥访问、网络外传、删除等高危行为重点标记并告警。" : "记录全部活动并对高危行为告警，不做干预。"}</small>
            </label>

            <section className="manage">
              <div className="manage__head">
                <h3>应用管理</h3>
                <span className={["tag", state.app.bundle_managed ? "tag--ok" : "tag--muted"].join(" ")}>
                  {state.app.bundle_managed ? "正式安装" : "开发模式"}
                </span>
              </div>
              <div className="manage__grid">
                <button className="btn btn--soft" disabled={managementBusy !== null} onClick={() => runManaged("releases", "已打开安装包页面", () => invoke("open_releases"))}>
                  {managementBusy === "releases" ? <Loader2 size={15} className="spin" /> : <Download size={15} />} 安装包
                </button>
                <button className="btn btn--soft" disabled={managementBusy !== null} onClick={() => runManaged("upgrade", "已打开最新版本页面", () => invoke("open_releases"))}>
                  {managementBusy === "upgrade" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 检查升级
                </button>
                <button className="btn btn--soft" disabled={managementBusy !== null} onClick={() => runManaged("install-dir", "已打开安装目录", () => invoke("open_install_dir"))}>
                  {managementBusy === "install-dir" ? <Loader2 size={15} className="spin" /> : <FolderOpen size={15} />} 安装目录
                </button>
                <button className="btn btn--soft" disabled={managementBusy !== null} onClick={() => runManaged("uninstall", "已打开系统卸载入口", () => invoke("open_uninstall_settings"))}>
                  {managementBusy === "uninstall" ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} 卸载入口
                </button>
              </div>
              <p className="manage__note">{state.app.updater_configured ? "已配置应用内自动更新。" : "升级通过 GitHub Releases 下载安装包覆盖安装。"}</p>
            </section>

            <div className="field">
              <span className="railLabel">安装目录</span>
              <code className="pathCode">{state.app.install_dir || "未安装"}</code>
            </div>
          </aside>
        </>
      )}

      <div className={["toast", toast ? "is-show" : ""].join(" ")} role="status" aria-live="polite" aria-atomic="true">
        <ShieldCheck size={16} />
        {toast}
      </div>
    </main>
  );
}

function Kpi({ tone, icon, label, value, detail }: { tone: string; icon: React.ReactNode; label: string; value: React.ReactNode; detail: React.ReactNode }) {
  return (
    <article className={["kpi", `kpi--${tone}`].join(" ")}>
      <span className="kpi__icon" aria-hidden="true">{icon}</span>
      <span className="kpi__body">
        <small className="kpi__label">{label}</small>
        <strong className="kpi__value">{value}</strong>
        <small className="kpi__detail">{detail}</small>
      </span>
    </article>
  );
}

function UpstreamCard({ loading, upstream, sources, running }: { loading: boolean; upstream?: DiscoveredProvider; sources: number; running: boolean }) {
  if (loading) {
    return (
      <article className="upstream upstream--loading">
        <Loader2 size={20} className="spin" />
        <span>正在扫描本机配置…</span>
      </article>
    );
  }
  if (!upstream) {
    return (
      <article className="upstream upstream--empty">
        <span className="upstream__logo muted" aria-hidden="true"><Shield size={26} /></span>
        <h3>没有检测到当前上游</h3>
        <p>只有实际启用的 ccswitch、Codex++ 或 Codex 配置会显示在这里。保安只做监控，不管理或切换供应商。</p>
      </article>
    );
  }
  return (
    <article className="upstream">
      <header className="upstream__top">
        <span className={["upstream__logo", sourceClass(upstream.source)].join(" ")} aria-hidden="true">
          <SourceLogo source={upstream.source} size={30} />
        </span>
        <span className={["badge", running ? "badge--live" : "badge--idle"].join(" ")}>
          <span className="dot" aria-hidden="true" />
          {running ? "监控中" : "未监控"}
        </span>
      </header>
      <div className="upstream__name">
        <h3>{upstream.name}</h3>
        <span className={["tag", upstream.status === "ready" ? "tag--ok" : "tag--muted"].join(" ")}>{providerStatus(upstream.status)}</span>
      </div>
      <p className="upstream__url" title={upstream.source_path}>
        {upstream.base_url || "使用登录态或本地配置，未暴露供应商 URL"}
      </p>
      <dl className="upstream__meta">
        <Meta label="来源" value={<span className={["tag", "tag--src", sourceClass(upstream.source)].join(" ")}><SourceLogo source={upstream.source} size={12} />{upstream.source_label}</span>} />
        <Meta label="模型" value={upstream.model || upstream.protocol || "Codex"} />
        <Meta label="凭据" value={upstream.has_api_key ? upstream.masked_api_key || "已配置 Key" : "登录态"} />
        <Meta label="配置来源" value={`${sources} 个`} />
      </dl>
    </article>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="metaItem">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ActivityTimeline({ events, loading, filtered }: { events: ActivityEvent[]; loading: boolean; filtered: boolean }) {
  const ordered = useMemo(() => [...events].reverse(), [events]);
  if (loading) {
    return (
      <div className="feed__loading" aria-label="正在扫描">
        <Loader2 size={20} className="spin" />
        <span>正在扫描本机配置…</span>
      </div>
    );
  }
  if (!events.length) {
    return (
      <div className="feed__empty">
        <span className="feed__emptyIcon" aria-hidden="true"><Shield size={26} /></span>
        <h3>{filtered ? "该类型暂无记录" : "还没有监控事件"}</h3>
        <p>{filtered ? "换一个筛选条件，或等待新的活动进入。" : "Codex 的命令、文件读写 / 删除 / 修改与网络请求会按时间汇总在这里。"}</p>
      </div>
    );
  }
  return (
    <div className="timeline" aria-label="活动时间线">
      {ordered.map((event) => (
        <article className={["event", `is-${severityTone(event.severity)}`].join(" ")} key={event.id}>
          <span className={["event__icon", `kind-${event.kind}`].join(" ")} aria-hidden="true">
            <ActivityKindIcon kind={event.kind} size={16} />
          </span>
          <div className="event__body">
            <div className="event__title">
              <h3>{event.title}</h3>
              <span className={["sev", `sev--${severityTone(event.severity)}`].join(" ")}>{severityLabel(event.severity)}</span>
              <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
            </div>
            <p>{event.summary}</p>
            {event.command && <code className="event__cmd">{event.command}</code>}
            {!!event.paths.length && (
              <div className="chips">
                {event.paths.slice(0, 4).map((path) => <code key={path} className="chip">{path}</code>)}
                {event.paths.length > 4 && <span className="chip chip--more">+{event.paths.length - 4} 个路径</span>}
              </div>
            )}
            {(event.lines_added !== undefined || event.lines_removed !== undefined || event.line_delta !== undefined) && (
              <div className="diffStats">
                {event.lines_added !== undefined && <span className="diff diff--add">+{event.lines_added}</span>}
                {event.lines_removed !== undefined && <span className="diff diff--del">−{event.lines_removed}</span>}
                {event.line_delta !== undefined && <span className="diff">净变化 {event.line_delta}</span>}
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function providerStatus(status: string) {
  return ({ ready: "可用", "needs-auth": "登录态", unconfigured: "未配置" } as Record<string, string>)[status] || status;
}

function providerDotClass(status: string) {
  return ({ ready: "dot--ok", "needs-auth": "dot--warn", unconfigured: "dot--muted" } as Record<string, string>)[status] || "dot--muted";
}

function filterCount(filter: ActivityFilter, events: ActivityEvent[]) {
  if (filter === "all") return events.length;
  return events.filter((event) => event.kind === filter).length;
}

function severityTone(severity: string) {
  return ({ info: "info", low: "low", medium: "medium", high: "high", critical: "critical" } as Record<string, string>)[severity] || "info";
}

function severityLabel(severity: string) {
  return ({ info: "信息", low: "低", medium: "中", high: "高", critical: "严重" } as Record<string, string>)[severity] || severity;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function sourceClass(source: string) {
  return source.replace(/[^a-z0-9_-]/gi, "-");
}

function SourceLogo({ source, size = 18 }: { source: string; size?: number }) {
  if (source === "ccswitch") {
    return <span className="srcLogo srcLogo--cc" style={{ width: size, height: size, fontSize: Math.max(9, size * 0.34) }}>cc</span>;
  }
  if (source === "codexplusplus") {
    return <span className="srcLogo srcLogo--cpp" style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}>++</span>;
  }
  if (source === "codex-config") return <FileCog size={size} strokeWidth={2.2} />;
  return <Shield size={size} strokeWidth={2.2} />;
}

function ActivityKindIcon({ kind, size = 16 }: { kind: ActivityKind | "all"; size?: number }) {
  if (kind === "all") return <Layers size={size} strokeWidth={2.2} />;
  if (kind === "file-read") return <Eye size={size} strokeWidth={2.2} />;
  if (kind === "file-create") return <FilePlus size={size} strokeWidth={2.2} />;
  if (kind === "file-delete") return <FileMinus size={size} strokeWidth={2.2} />;
  if (kind === "file-modify") return <FilePen size={size} strokeWidth={2.2} />;
  if (kind === "network") return <Globe size={size} strokeWidth={2.2} />;
  if (kind === "risk") return <AlertTriangle size={size} strokeWidth={2.2} />;
  return <Terminal size={size} strokeWidth={2.2} />;
}
