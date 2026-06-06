import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AlertTriangle,
  ArrowUpCircle,
  Check,
  Eye,
  EyeOff,
  FileMinus,
  FilePen,
  FilePlus,
  FileStack,
  FolderOpen,
  Globe,
  Layers,
  Loader2,
  Minimize2,
  Monitor,
  Moon,
  Play,
  Power,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEvent, ActivityFilter, ActivityKind, AppState, DiscoveredProvider, GuardMode } from "./types";
import ccswitchIcon from "./assets/ccswitch.png";

type Theme = "light" | "dark" | "system";
type KpiTone = "primary" | "neutral" | "danger" | "calm";
type UpdateState = { status: "idle" | "checking" | "latest" | "available" | "error"; latest?: string; message?: string };
type Settings = { background_run: boolean; silent_start: boolean; autostart: boolean };

const THEME_KEY = "cgx-theme";
const RELEASE_API = "https://api.github.com/repos/jiangliushi666/codex-baoan/releases/latest";

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

function readTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

function compareVersion(a: string, b: string) {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [search, setSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode] = useState<GuardMode>("audit");
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const [settings, setSettings] = useState<Settings>({ background_run: true, silent_start: false, autostart: false });
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
    let list =
      activityFilter === "all"
        ? state.activity
        : activityFilter === "risk"
          ? state.activity.filter(isRisk)
          : state.activity.filter((event) => event.kind === activityFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (event) =>
          (event.command || "").toLowerCase().includes(q) ||
          event.title.toLowerCase().includes(q) ||
          event.summary.toLowerCase().includes(q) ||
          event.paths.some((path) => path.toLowerCase().includes(q))
      );
    }
    return list;
  }, [activityFilter, state.activity, search]);

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

  const checkUpdate = useCallback(async () => {
    setUpdate({ status: "checking" });
    try {
      const res = await fetch(RELEASE_API, { headers: { Accept: "application/vnd.github+json" } });
      if (res.status === 404) {
        setUpdate({ status: "latest", message: "暂未发布正式版本" });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { tag_name?: string };
      const latest = (data.tag_name || "").replace(/^v/, "");
      if (latest && compareVersion(latest, state.app.version) > 0) {
        setUpdate({ status: "available", latest });
      } else {
        setUpdate({ status: "latest", latest: latest || state.app.version });
      }
    } catch {
      setUpdate({ status: "error", message: "检查失败，请检查网络连接" });
    }
  }, [state.app.version]);

  async function updateSetting(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const applied = await invoke<Settings>("set_settings", next);
      setSettings(applied);
    } catch (err) {
      fail(err);
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
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => root.classList.toggle("dark", theme === "dark" || (theme === "system" && mq.matches));
    apply();
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    if (theme === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  useEffect(() => {
    for (const node of [railRef.current, stageRef.current]) {
      if (!node) continue;
      if (settingsOpen) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
    }
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    if (update.status === "idle") checkUpdate();
    invoke<Settings>("get_settings").then(setSettings).catch(() => {});
    window.setTimeout(() => drawerCloseRef.current?.focus(), 0);
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSettings, settingsOpen, update.status, checkUpdate]);

  const running = state.runtime.running;
  const primaryActionLabel = running ? "停止 Codex 监控" : "启动 Codex 监控";

  return (
    <main className="app">
      <aside className="rail" ref={railRef}>
        <header className="brand">
          <span className="brand__mark" aria-hidden="true">
            <ShieldCheck size={20} strokeWidth={2.5} />
          </span>
          <span className="brand__text">
            <strong>Codex 保安</strong>
            <small>本机监控 · v{state.app.version}</small>
          </span>
        </header>

        <nav className="filters" aria-label="按活动类型筛选">
          <span className="railLabel filters__label">活动筛选</span>
          {filters.map((item) => {
            const active = activityFilter === item.id;
            return (
              <button key={item.id} className={["filter", active ? "is-active" : ""].join(" ")} aria-pressed={active} onClick={() => setActivityFilter(item.id)}>
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
          <div className="modePill">
            <Eye size={14} />
            <span>
              <small>保护策略</small>
              <strong>{running ? "监控记录中" : "未启用"}</strong>
            </span>
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
        <header className="topbar">
          <UpstreamBar loading={loading} upstream={activeUpstream} sources={state.discovery.sources} running={running} fallback={state.discovery.manual_fallback_reason} />
          <div className="topbar__actions">
            <button className="btn btn--soft" title="切换供应商后点此重新扫描本机配置" aria-label="重新扫描本机配置" disabled={scanning || loading} onClick={() => refresh("已重新扫描本机配置")}>
              <RefreshCw size={15} className={scanning ? "spin" : ""} />
              重新扫描
            </button>
            <button className={["btn", running ? "btn--stop" : "btn--primary"].join(" ")} disabled={actionBusy || loading} aria-label={primaryActionLabel} onClick={() => (running ? stop() : start())}>
              {actionBusy ? <Loader2 size={16} className="spin" /> : running ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
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
          <Kpi tone="primary" icon={<Activity size={17} />} label="活动事件" value={loading ? "—" : stats.total} detail={`${stats.commands} 命令 · ${stats.network} 网络`} active={activityFilter === "all"} onClick={() => { setActivityFilter("all"); setSearch(""); }} />
          <Kpi tone="neutral" icon={<FileStack size={17} />} label="文件改动" value={loading ? "—" : stats.files} detail={`读 ${stats.reads} · 改 ${stats.modifies} · 删 ${stats.deletes}`} active={activityFilter === "file-read"} onClick={() => { setActivityFilter("file-read"); setSearch(""); }} />
          <Kpi tone={stats.risks ? "danger" : "calm"} icon={<ShieldAlert size={17} />} label="风险命中" value={loading ? "—" : stats.risks} detail="点击查看高危记录" active={activityFilter === "risk"} onClick={() => { setActivityFilter("risk"); setSearch(""); }} />
        </section>

        <section className="feed">
          <div className="feed__head">
            <div className="feed__headText">
              <h2>执行记录</h2>
              <p>命令、文件读取 / 新建 / 修改 / 删除、网络请求会按时间汇总在这里，当前显示 {filteredActivity.length} 条。</p>
            </div>
            <div className="feed__tools">
              <div className="searchBox">
                <Search size={15} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索命令 / 路径…" aria-label="搜索执行记录" />
                {search && (
                  <button className="searchBox__clear" aria-label="清除搜索" onClick={() => setSearch("")}>
                    <X size={13} />
                  </button>
                )}
              </div>
              <button className="btn btn--ghost btn--sm" disabled={!state.activity.length} onClick={clearActivity}>
                <Trash2 size={14} /> 清空
              </button>
            </div>
          </div>
          <ActivityTimeline events={filteredActivity} loading={loading} filtered={activityFilter !== "all" || !!search.trim()} />
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

            <div className="field">
              <span className="railLabel">外观主题</span>
              <div className="segmented" role="group" aria-label="主题">
                <button className={theme === "light" ? "is-active" : ""} aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
                  <Sun size={15} /> 浅色
                </button>
                <button className={theme === "dark" ? "is-active" : ""} aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
                  <Moon size={15} /> 深色
                </button>
                <button className={theme === "system" ? "is-active" : ""} aria-pressed={theme === "system"} onClick={() => setTheme("system")}>
                  <Monitor size={15} /> 跟随系统
                </button>
              </div>
            </div>

            <div className="field">
              <span className="railLabel">运行设置</span>
              <div className="settingGroup">
                <Toggle checked={settings.background_run} onChange={(v) => updateSetting({ background_run: v })} icon={<Minimize2 size={16} />} label="后台运行" hint="关闭窗口时最小化到托盘，监控继续运行" />
                <Toggle checked={settings.autostart} onChange={(v) => updateSetting({ autostart: v })} icon={<Power size={16} />} label="开机自启动" hint="开机时自动启动 Codex 保安" />
                <Toggle checked={settings.silent_start} onChange={(v) => updateSetting({ silent_start: v })} icon={<EyeOff size={16} />} label="开机静默启动" hint="开机自启时不弹窗，直接在后台监控（需先开启自启）" />
              </div>
            </div>

            <section className="updateCard">
              <div className="updateCard__row">
                <div className="updateCard__info">
                  <span className="railLabel">版本更新</span>
                  <strong>当前 v{state.app.version}</strong>
                  <small>
                    {update.status === "checking" && "正在检查最新版本…"}
                    {update.status === "latest" && (update.message || `已是最新版本${update.latest ? ` (v${update.latest})` : ""}`)}
                    {update.status === "available" && `发现新版本 v${update.latest}`}
                    {update.status === "error" && (update.message || "检查失败")}
                    {update.status === "idle" && "点击检查是否有新版本"}
                  </small>
                </div>
                {update.status === "available" ? (
                  <button className="btn btn--primary btn--sm" onClick={() => runManaged("update", `正在前往 v${update.latest} 下载页`, () => invoke("open_releases"))}>
                    <ArrowUpCircle size={15} /> 更新到 v{update.latest}
                  </button>
                ) : (
                  <button className="btn btn--soft btn--sm" disabled={update.status === "checking"} onClick={checkUpdate}>
                    {update.status === "checking" ? <Loader2 size={14} className="spin" /> : update.status === "latest" ? <Check size={14} /> : <RefreshCw size={14} />}
                    {update.status === "checking" ? "检查中" : update.status === "latest" ? "已最新" : "检查更新"}
                  </button>
                )}
              </div>
            </section>

            <button className="logDirRow" onClick={() => runManaged("log-dir", "已打开监控日志目录", () => invoke("open_log_dir"))} disabled={managementBusy !== null}>
              <span className="logDirRow__icon" aria-hidden="true">
                {managementBusy === "log-dir" ? <Loader2 size={16} className="spin" /> : <FolderOpen size={16} />}
              </span>
              <span className="logDirRow__text">
                <strong>监控日志目录</strong>
                <small>打开 Codex 会话日志所在文件夹（监控数据来源）</small>
              </span>
            </button>

            <p className="drawer__note">监控读取本机 Codex 会话日志（~/.codex/sessions）来还原执行记录，仅在本地处理，不上传任何数据。</p>
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

function UpstreamBar({
  loading,
  upstream,
  sources,
  running,
  fallback
}: {
  loading: boolean;
  upstream?: DiscoveredProvider;
  sources: AppState["discovery"]["sources"];
  running: boolean;
  fallback: string;
}) {
  if (loading) {
    return (
      <div className="upstreamBar upstreamBar--plain">
        <span className="pulse" aria-hidden="true" />
        <div className="upstreamBar__info">
          <small>正在初始化</small>
          <strong>正在读取本机配置…</strong>
        </div>
      </div>
    );
  }
  if (!upstream) {
    return (
      <div className="upstreamBar upstreamBar--plain">
        <span className="upstreamBar__logo muted" aria-hidden="true">
          <Shield size={20} />
        </span>
        <div className="upstreamBar__info">
          <small>未检测到上游</small>
          <strong>请先启用一个 Codex 供应商</strong>
          <p className="upstreamBar__hint">{fallback}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="upstreamBar">
      <span className="upstreamBar__logo" aria-hidden="true">
        <SourceLogo source={upstream.source} size={28} />
      </span>
      <div className="upstreamBar__info">
        <div className="upstreamBar__title">
          <span className="pulse-inline">
            <span className={["pulse", running ? "is-online" : ""].join(" ")} role="img" aria-label={running ? "监控运行中" : "监控未启用"} />
          </span>
          <strong>{upstream.name}</strong>
          <span className={["badge", running ? "badge--live" : "badge--idle"].join(" ")}>{running ? "监控中" : "未监控"}</span>
          <span className={["tag", upstream.status === "ready" ? "tag--ok" : "tag--muted"].join(" ")}>{providerStatus(upstream.status)}</span>
        </div>
        <div className="upstreamBar__meta">
          <code className="upstreamBar__url" title={upstream.source_path}>
            {upstream.base_url || "登录态 / 本地配置"}
          </code>
          <span className="sep" aria-hidden="true" />
          <span>{upstream.model || upstream.protocol || "Codex"}</span>
          <span className="sep" aria-hidden="true" />
          <span>{upstream.has_api_key ? upstream.masked_api_key || "已配置 Key" : "登录态"}</span>
        </div>
        {!!sources.length && (
          <div className="upstreamBar__sources">
            <span className="srcLabel">配置来源</span>
            {sources.map((source) => (
              <span key={source.id} className="srcChip" title={source.path}>
                <SourceLogo source={source.id} size={14} />
                {source.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ tone, icon, label, value, detail, active, onClick }: { tone: KpiTone; icon: React.ReactNode; label: string; value: React.ReactNode; detail: React.ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button className={["kpi", `kpi--${tone}`, active ? "is-active" : ""].join(" ")} onClick={onClick} aria-pressed={active}>
      <span className="kpi__icon" aria-hidden="true">{icon}</span>
      <span className="kpi__body">
        <small className="kpi__label">{label}</small>
        <strong className="kpi__value">{value}</strong>
        <small className="kpi__detail">{detail}</small>
      </span>
    </button>
  );
}

function Toggle({ checked, onChange, icon, label, hint }: { checked: boolean; onChange: (value: boolean) => void; icon: React.ReactNode; label: string; hint: string }) {
  return (
    <button className={["settingRow", checked ? "is-on" : ""].join(" ")} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="settingRow__icon" aria-hidden="true">{icon}</span>
      <span className="settingRow__text">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <span className="toggle" aria-hidden="true"><span className="toggle__knob" /></span>
    </button>
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
        <span className="feed__emptyIcon" aria-hidden="true">
          <Shield size={26} />
        </span>
        <h3>{filtered ? "没有匹配的记录" : "还没有监控事件"}</h3>
        <p>{filtered ? "换一个筛选条件或搜索词，或等待新的活动进入。" : "Codex 的命令、文件读写 / 删除 / 修改与网络请求会按时间汇总在这里。"}</p>
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
                {event.paths.slice(0, 4).map((path) => (
                  <code key={path} className="chip">{path}</code>
                ))}
                {event.paths.length > 4 && <span className="chip chip--more">+{event.paths.length - 4} 个路径</span>}
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

function isRisk(event: ActivityEvent) {
  return event.kind === "risk" || event.severity === "high" || event.severity === "critical";
}

function filterCount(filter: ActivityFilter, events: ActivityEvent[]) {
  if (filter === "all") return events.length;
  if (filter === "risk") return events.filter(isRisk).length;
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

function SourceLogo({ source, size = 18 }: { source: string; size?: number }) {
  if (source === "ccswitch") {
    return <img className="srcImg" src={ccswitchIcon} width={size} height={size} alt="" draggable={false} />;
  }
  if (source === "codexplusplus") return <CodexMark size={size} plus />;
  if (source === "codex-config") return <CodexMark size={size} />;
  return <Shield size={size} strokeWidth={2.2} />;
}

// OpenAI / Codex 官方标志（花结）
function CodexMark({ size = 18, plus = false }: { size?: number; plus?: boolean }) {
  return (
    <span className="codexMark" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.305a4.471 4.471 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.376-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.098-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
      {plus && <span className="codexMark__plus" aria-hidden="true">+</span>}
    </span>
  );
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
