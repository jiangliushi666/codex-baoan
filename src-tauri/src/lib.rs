use chrono::Utc;
use regex::Regex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Manager;

#[derive(Default)]
struct AppRuntime {
    runtime: Mutex<RuntimeState>,
    activity: Arc<Mutex<Vec<ActivityEvent>>>,
    monitor: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct RuntimeState {
    running: bool,
    provider_id: Option<String>,
    provider_name: Option<String>,
    mode: GuardMode,
    started_at: Option<String>,
    local_proxy_url: Option<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            running: false,
            provider_id: None,
            provider_name: None,
            mode: GuardMode::Audit,
            started_at: None,
            local_proxy_url: None,
        }
    }
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum GuardMode {
    Audit,
    Block,
}

#[derive(Serialize)]
struct AppState {
    app: AppInfo,
    discovery: DiscoveryResult,
    runtime: RuntimeState,
    activity: Vec<ActivityEvent>,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    install_dir: String,
    bundle_managed: bool,
    updater_configured: bool,
}

#[derive(Serialize)]
struct DiscoveryResult {
    generated_at: String,
    providers: Vec<DiscoveredProvider>,
    sources: Vec<DiscoverySourceReport>,
    recommended_provider_id: Option<String>,
    manual_fallback_reason: String,
}

#[derive(Serialize)]
struct DiscoverySourceReport {
    id: String,
    label: String,
    path: String,
    exists: bool,
    status: String,
    provider_count: usize,
    message: String,
}

#[derive(Clone, Serialize)]
struct DiscoveredProvider {
    id: String,
    source: String,
    source_label: String,
    source_path: String,
    native_id: String,
    name: String,
    base_url: Option<String>,
    masked_api_key: Option<String>,
    has_api_key: bool,
    status: String,
    status_text: String,
    is_current: bool,
    is_recommended: bool,
    model: Option<String>,
    protocol: Option<String>,
    notes: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ActivityEvent {
    id: String,
    timestamp: String,
    kind: String,
    title: String,
    command: Option<String>,
    paths: Vec<String>,
    severity: String,
    summary: String,
    line_delta: Option<i64>,
    lines_added: Option<usize>,
    lines_removed: Option<usize>,
    source: Option<String>,
}

#[derive(Deserialize)]
struct FileEventInput {
    kind: String,
    paths: Vec<String>,
    line_delta: Option<i64>,
    lines_added: Option<usize>,
    lines_removed: Option<usize>,
    summary: Option<String>,
    source: Option<String>,
}

#[derive(Serialize)]
struct InspectDecision {
    severity: String,
    action: String,
    message: String,
    matched_paths: Vec<String>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppRuntime::default())
        .invoke_handler(tauri::generate_handler![
            get_state,
            start_guard,
            stop_guard,
            inspect_command,
            get_activity,
            clear_activity,
            record_command,
            record_file_event,
            open_install_dir,
            open_log_dir,
            open_releases,
            open_uninstall_settings
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
            }
            // 启动即自动监控当前 Codex 上游（无需手动点击）；用户仍可在界面停止/重启。
            let state = app.state::<AppRuntime>();
            let discovery = discover_providers();
            if let Some(provider) = select_active_provider(&discovery) {
                if let Ok(mut runtime) = state.runtime.lock() {
                    runtime.running = true;
                    runtime.provider_id = Some(provider.id);
                    runtime.provider_name = Some(provider.name);
                    runtime.mode = GuardMode::Audit;
                    runtime.started_at = Some(Utc::now().to_rfc3339());
                }
                start_monitor(&state, GuardMode::Audit);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Codex Baoan");
}

#[tauri::command]
fn get_state(state: tauri::State<AppRuntime>) -> Result<AppState, String> {
    build_state(&state)
}

#[tauri::command]
fn start_guard(mode: GuardMode, state: tauri::State<AppRuntime>) -> Result<AppState, String> {
    let discovery = discover_providers();
    let provider = select_active_provider(&discovery)
        .ok_or_else(|| "未检测到当前 Codex 上游，请先在 ccswitch、Codex++ 或 Codex 中启用一个供应商。".to_string())?;

    {
        let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
        runtime.running = true;
        runtime.provider_id = Some(provider.id);
        runtime.provider_name = Some(provider.name);
        runtime.mode = mode;
        runtime.started_at = Some(Utc::now().to_rfc3339());
        runtime.local_proxy_url = None;
    }
    start_monitor(&state, mode);
    build_state(&state)
}

#[tauri::command]
fn stop_guard(state: tauri::State<AppRuntime>) -> Result<AppState, String> {
    if let Some(flag) = state.monitor.lock().map_err(|error| error.to_string())?.take() {
        flag.store(true, Ordering::SeqCst);
    }
    let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    *runtime = RuntimeState::default();
    drop(runtime);
    build_state(&state)
}

#[tauri::command]
fn inspect_command(command: String, mode: GuardMode) -> InspectDecision {
    evaluate_command(&command, mode)
}

#[tauri::command]
fn get_activity(state: tauri::State<AppRuntime>) -> Result<Vec<ActivityEvent>, String> {
    Ok(recent_activity(&state, 120)?)
}

#[tauri::command]
fn clear_activity(state: tauri::State<AppRuntime>) -> Result<Vec<ActivityEvent>, String> {
    let mut activity = state.activity.lock().map_err(|error| error.to_string())?;
    activity.clear();
    Ok(vec![])
}

#[tauri::command]
fn record_command(command: String, state: tauri::State<AppRuntime>) -> Result<Vec<ActivityEvent>, String> {
    let mode = state.runtime.lock().map_err(|error| error.to_string())?.mode;
    let event = command_activity_event(&command, mode);
    push_activity(&state, event)?;
    recent_activity(&state, 120)
}

#[tauri::command]
fn record_file_event(input: FileEventInput, state: tauri::State<AppRuntime>) -> Result<Vec<ActivityEvent>, String> {
    push_activity(&state, file_activity_event(input))?;
    recent_activity(&state, 120)
}

#[tauri::command]
fn open_install_dir() -> Result<(), String> {
    let dir = install_dir();
    open_path(&dir)
}

#[tauri::command]
fn open_log_dir() -> Result<(), String> {
    let dir = codex_sessions_dir();
    let target = if dir.exists() { dir } else { dirs::home_dir().unwrap_or_default().join(".codex") };
    open_path(&target)
}

#[tauri::command]
fn open_releases() -> Result<(), String> {
    open_url("https://github.com/jiangliushi666/codex-baoan/releases/latest")
}

#[tauri::command]
fn open_uninstall_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return open_url("ms-settings:appsfeatures");

    #[cfg(target_os = "macos")]
    return open_path(Path::new("/Applications"));

    #[cfg(all(unix, not(target_os = "macos")))]
    return open_url("https://github.com/jiangliushi666/codex-baoan/releases/latest");
}

/// 启动 Codex 会话日志监控线程：tail 最新 rollout-*.jsonl，实时解析其中的 shell 命令。
fn start_monitor(state: &tauri::State<AppRuntime>, mode: GuardMode) {
    let mut guard = match state.monitor.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(old) = guard.take() {
        old.store(true, Ordering::SeqCst);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let activity = Arc::clone(&state.activity);
    let stop_for_thread = Arc::clone(&stop);
    thread::spawn(move || monitor_codex(activity, stop_for_thread, mode));
    *guard = Some(stop);
}

fn codex_sessions_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("sessions")
}

/// 在 ~/.codex/sessions 下递归找出最近修改的 rollout 会话日志（即当前活跃会话）。
fn find_latest_rollout() -> Option<PathBuf> {
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut stack = vec![codex_sessions_dir()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                if let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) {
                    if latest.as_ref().map(|(time, _)| modified > *time).unwrap_or(true) {
                        latest = Some((modified, path));
                    }
                }
            }
        }
    }
    latest.map(|(_, path)| path)
}

fn monitor_codex(activity: Arc<Mutex<Vec<ActivityEvent>>>, stop: Arc<AtomicBool>, mode: GuardMode) {
    let mut current: Option<PathBuf> = None;
    let mut offset: u64 = 0;
    let mut seen: HashSet<String> = HashSet::new();
    let mut tick: u32 = 0;
    while !stop.load(Ordering::SeqCst) {
        // 首次以及每隔数秒重新定位最新会话文件（覆盖用户切换会话/新开会话的情况）。
        if current.is_none() || tick % 5 == 0 {
            if let Some(latest) = find_latest_rollout() {
                if current.as_deref() != Some(latest.as_path()) {
                    current = Some(latest);
                    offset = 0;
                    seen.clear();
                }
            }
        }
        if let Some(path) = current.as_ref() {
            offset = read_and_emit(path, offset, &mut seen, &activity, mode);
        }
        tick = tick.wrapping_add(1);
        thread::sleep(Duration::from_millis(800));
    }
}

/// 从 offset 起读取会话文件的新增完整行，解析出 shell 命令并推入活动列表。返回新的 offset。
fn read_and_emit(
    path: &Path,
    offset: u64,
    seen: &mut HashSet<String>,
    activity: &Arc<Mutex<Vec<ActivityEvent>>>,
    mode: GuardMode,
) -> u64 {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return offset,
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if len <= offset {
        // 文件被轮转/截断时回到开头，否则保持。
        return if len < offset { 0 } else { offset };
    }
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return offset;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return offset;
    }
    // 只处理以换行结尾的完整行，避免读到正在写入的半行。
    let last_newline = match buf.rfind('\n') {
        Some(index) => index,
        None => return offset,
    };
    let complete = &buf[..=last_newline];
    for line in complete.lines() {
        if let Some(event) = parse_shell_event(line, mode) {
            if seen.insert(event.id.clone()) {
                if let Ok(mut act) = activity.lock() {
                    act.push(event);
                    let keep = 500;
                    if act.len() > keep {
                        let drop_count = act.len() - keep;
                        act.drain(0..drop_count);
                    }
                }
            }
        }
    }
    offset + complete.len() as u64
}

/// 解析一行 rollout 记录：若是 shell 命令调用，复用命令风险分析生成活动事件。
fn parse_shell_event(line: &str, mode: GuardMode) -> Option<ActivityEvent> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let payload = value.get("payload")?;
    if payload.get("type")?.as_str()? != "function_call" {
        return None;
    }
    let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
    if !name.contains("shell") && !name.contains("exec") {
        return None;
    }
    let args_raw = payload.get("arguments")?.as_str()?;
    let args: Value = serde_json::from_str(args_raw).ok()?;
    let command = match args.get("command")? {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        _ => return None,
    };
    if command.trim().is_empty() {
        return None;
    }
    let timestamp = value.get("timestamp").and_then(Value::as_str).unwrap_or("").to_string();
    let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or("");
    let mut event = command_activity_event(&command, mode);
    event.id = if call_id.is_empty() {
        format!("codex-{}-{}", timestamp, event.id)
    } else {
        format!("codex-{}", call_id)
    };
    if !timestamp.is_empty() {
        event.timestamp = timestamp;
    }
    event.source = Some("codex".into());
    Some(event)
}

fn build_state(state: &tauri::State<AppRuntime>) -> Result<AppState, String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?.clone();
    let activity = recent_activity(state, 120)?;
    Ok(AppState { app: app_info(), discovery: discover_providers(), runtime, activity })
}

fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        install_dir: install_dir().display().to_string(),
        bundle_managed: cfg!(not(debug_assertions)),
        updater_configured: false,
    }
}

fn install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn discover_providers() -> DiscoveryResult {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut sources = Vec::new();
    let mut providers = Vec::new();

    let (source, mut items) = discover_ccswitch(&home);
    if !items.is_empty() {
        sources.push(source);
        providers.append(&mut items);
    }
    let (source, mut items) = discover_codex_plusplus(&home);
    if !items.is_empty() {
        sources.push(source);
        providers.append(&mut items);
    }
    let (source, mut items) = discover_codex_config(&home);
    if !items.is_empty() {
        sources.push(source);
        providers.append(&mut items);
    }

    mark_recommended(&mut providers);
    let recommended_provider_id = providers.iter().find(|item| item.is_recommended).map(|item| item.id.clone());
    let manual_fallback_reason = if recommended_provider_id.is_some() {
        "已自动发现可用上游。".to_string()
    } else {
        "未检测到当前 Codex 上游，请先在 ccswitch、Codex++ 或 Codex 中启用一个供应商。".to_string()
    };

    DiscoveryResult { generated_at: Utc::now().to_rfc3339(), providers, sources, recommended_provider_id, manual_fallback_reason }
}

fn ccswitch_candidates(home: &Path) -> Vec<PathBuf> {
    unique_paths([
        dirs::data_dir().map(|path| path.join("cc-switch").join("cc-switch.db")),
        dirs::config_dir().map(|path| path.join("cc-switch").join("cc-switch.db")),
        Some(home.join(".cc-switch").join("cc-switch.db")),
    ])
}

fn codex_plusplus_candidates(home: &Path) -> Vec<PathBuf> {
    unique_paths([
        Some(home.join(".codex-session-delete").join("settings.json")),
        dirs::data_dir().map(|path| path.join("codexplusplus").join("settings.json")),
        dirs::data_dir().map(|path| path.join("Codex++").join("settings.json")),
        dirs::data_dir().map(|path| path.join("codex-plus-plus").join("settings.json")),
        dirs::config_dir().map(|path| path.join("codexplusplus").join("settings.json")),
    ])
}

fn unique_paths<const N: usize>(paths: [Option<PathBuf>; N]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .flatten()
        .filter(|path| seen.insert(path.display().to_string()))
        .collect()
}

fn join_paths(paths: &[PathBuf]) -> String {
    paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join("; ")
}

fn discover_ccswitch(home: &Path) -> (DiscoverySourceReport, Vec<DiscoveredProvider>) {
    let candidates = ccswitch_candidates(home);
    let path = match candidates.iter().find(|candidate| candidate.exists()).cloned() {
        Some(path) => path,
        None => {
            let primary = candidates.first().cloned().unwrap_or_else(|| home.join(".cc-switch").join("cc-switch.db"));
            return (source_report("ccswitch", "ccswitch", &primary, false, "missing", 0, &format!("ccswitch database was not found. Checked: {}", join_paths(&candidates))), vec![]);
        }
    };

    match read_ccswitch(&path) {
        Ok(providers) => {
            let message = if providers.is_empty() { "Database exists but has no Codex providers." } else { "Loaded Codex providers from ccswitch." };
            (source_report("ccswitch", "ccswitch", &path, true, "ok", providers.len(), message), providers)
        }
        Err(error) => (source_report("ccswitch", "ccswitch", &path, true, "error", 0, &error), vec![]),
    }
}

fn read_ccswitch(path: &Path) -> Result<Vec<DiscoveredProvider>, String> {
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, settings_config, website_url, category, notes, is_current FROM providers WHERE app_type = 'codex' ORDER BY is_current DESC, COALESCE(sort_index, 999999), name ASC",
        )
        .map_err(|error| error.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let settings: Option<String> = row.get(2)?;
            let notes: Option<String> = row.get(5)?;
            let is_current: i64 = row.get(6)?;
            Ok((id, name, settings.unwrap_or_default(), notes, is_current == 1))
        })
        .map_err(|error| error.to_string())?;

    let mut providers = Vec::new();
    for row in rows {
        let (native_id, name, settings_raw, notes, is_current) = row.map_err(|error| error.to_string())?;
        if !is_current { continue; }
        let settings = parse_json(&settings_raw);
        let config_toml = find_string_by_keys(&settings, &["config", "configContents"]);
        let toml_info = config_toml.as_deref().map(parse_codex_toml).unwrap_or_default();
        let base_url = first_url(vec![
            toml_info.base_url,
            find_string_by_keys(&settings, &["baseUrl", "base_url", "apiBaseUrl", "upstreamBaseUrl"]),
        ]);
        let api_key = first_string(vec![
            toml_info.api_key,
            find_string_by_keys(&settings, &["OPENAI_API_KEY", "apiKey", "api_key", "openaiApiKey", "experimental_bearer_token"]),
        ]);
        providers.push(finalize_provider(ProviderInput {
            id: format!("ccswitch:{}", native_id),
            source: "ccswitch".into(),
            source_label: "ccswitch".into(),
            source_path: path.display().to_string(),
            native_id,
            name,
            base_url,
            api_key,
            is_current,
            model: None,
            protocol: None,
            notes: notes.into_iter().collect(),
        }));
    }
    Ok(providers)
}

fn discover_codex_plusplus(home: &Path) -> (DiscoverySourceReport, Vec<DiscoveredProvider>) {
    let candidates = codex_plusplus_candidates(home);
    let path = match candidates.iter().find(|candidate| candidate.exists()).cloned() {
        Some(path) => path,
        None => {
            let primary = candidates.first().cloned().unwrap_or_else(|| home.join(".codex-session-delete").join("settings.json"));
            return (source_report("codexplusplus", "Codex++", &primary, false, "missing", 0, &format!("Codex++ settings were not found. Checked: {}", join_paths(&candidates))), vec![]);
        }
    };
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let settings = parse_json(&raw);
            let active = find_string_by_keys(&settings, &["activeRelayId"]);
            let relay_base = find_string_by_keys(&settings, &["relayBaseUrl"]);
            let relay_key = find_string_by_keys(&settings, &["relayApiKey"]);
            let mut providers = Vec::new();
            if let (Some(active_id), Some(Value::Array(profiles))) = (active.as_deref(), settings.get("relayProfiles")) {
                for (index, profile) in profiles.iter().enumerate() {
                    let native_id = find_string_by_keys(profile, &["id"]).unwrap_or_else(|| index.to_string());
                    if native_id != active_id { continue; }
                    let name = find_string_by_keys(profile, &["name"]).unwrap_or_else(|| "Codex++ relay".to_string());
                    providers.push(finalize_provider(ProviderInput {
                        id: format!("codexplusplus:{}", native_id),
                        source: "codexplusplus".into(),
                        source_label: "Codex++".into(),
                        source_path: path.display().to_string(),
                        native_id: native_id.clone(),
                        name,
                        base_url: first_url(vec![find_string_by_keys(profile, &["upstreamBaseUrl", "baseUrl"]), relay_base.clone()]),
                        api_key: first_string(vec![find_string_by_keys(profile, &["apiKey"]), relay_key.clone()]),
                        is_current: true,
                        model: find_string_by_keys(profile, &["model"]),
                        protocol: find_string_by_keys(profile, &["protocol"]),
                        notes: vec![],
                    }));
                    break;
                }
            }
            (source_report("codexplusplus", "Codex++", &path, true, "ok", providers.len(), "Loaded Codex++ relay profiles."), providers)
        }
        Err(error) => (source_report("codexplusplus", "Codex++", &path, true, "error", 0, &error.to_string()), vec![]),
    }
}

fn discover_codex_config(home: &Path) -> (DiscoverySourceReport, Vec<DiscoveredProvider>) {
    let path = home.join(".codex").join("config.toml");
    if !path.exists() {
        return (source_report("codex-config", "Codex config", &path, false, "missing", 0, "Codex config.toml was not found."), vec![]);
    }
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let info = parse_codex_toml(&raw);
            if info.provider_name.is_none() && info.base_url.is_none() {
                return (source_report("codex-config", "Codex config", &path, true, "ok", 0, "config.toml has no usable model_provider."), vec![]);
            }
            let native_id = info.provider_name.clone().unwrap_or_else(|| "custom".into());
            let provider = finalize_provider(ProviderInput {
                id: format!("codex-config:{}", native_id),
                source: "codex-config".into(),
                source_label: "Codex config".into(),
                source_path: path.display().to_string(),
                native_id: native_id.clone(),
                name: info.name.unwrap_or(native_id),
                base_url: info.base_url,
                api_key: info.api_key,
                is_current: true,
                model: info.model,
                protocol: info.protocol,
                notes: vec!["from ~/.codex/config.toml".into()],
            });
            (source_report("codex-config", "Codex config", &path, true, "ok", 1, "Loaded current Codex model_provider."), vec![provider])
        }
        Err(error) => (source_report("codex-config", "Codex config", &path, true, "error", 0, &error.to_string()), vec![]),
    }
}

struct ProviderInput {
    id: String,
    source: String,
    source_label: String,
    source_path: String,
    native_id: String,
    name: String,
    base_url: Option<String>,
    api_key: Option<String>,
    is_current: bool,
    model: Option<String>,
    protocol: Option<String>,
    notes: Vec<String>,
}

fn finalize_provider(input: ProviderInput) -> DiscoveredProvider {
    let has_api_key = input.api_key.as_ref().map(|value| !value.is_empty()).unwrap_or(false);
    let ready_url = input.base_url.as_ref().map(|value| value.starts_with("http://") || value.starts_with("https://")).unwrap_or(false);
    let status = if ready_url && has_api_key { "ready" } else if ready_url { "needs-auth" } else { "unconfigured" };
    DiscoveredProvider {
        id: input.id,
        source: input.source,
        source_label: input.source_label,
        source_path: input.source_path,
        native_id: input.native_id,
        name: input.name,
        base_url: input.base_url,
        masked_api_key: mask_secret(input.api_key.as_deref()),
        has_api_key,
        status: status.into(),
        status_text: status.into(),
        is_current: input.is_current,
        is_recommended: false,
        model: input.model,
        protocol: input.protocol,
        notes: input.notes,
    }
}

fn select_active_provider(discovery: &DiscoveryResult) -> Option<DiscoveredProvider> {
    ["ccswitch", "codexplusplus", "codex-config"]
        .iter()
        .find_map(|source| discovery.providers.iter().find(|item| item.source == *source && item.is_current && item.status != "unconfigured").cloned())
        .or_else(|| discovery.providers.iter().find(|item| item.is_current && item.status != "unconfigured").cloned())
        .or_else(|| discovery.providers.iter().find(|item| item.status != "unconfigured").cloned())
}

fn mark_recommended(providers: &mut [DiscoveredProvider]) {
    let mut best_index = None;
    let mut best_score = -1;
    for (index, provider) in providers.iter().enumerate() {
        if provider.status == "unconfigured" { continue; }
        let source_score = match provider.source.as_str() { "ccswitch" => 20, "codexplusplus" => 15, _ => 10 };
        let score = if provider.is_current { 100 } else { 0 } + if provider.has_api_key { 30 } else { 0 } + source_score;
        if score > best_score {
            best_score = score;
            best_index = Some(index);
        }
    }
    if let Some(index) = best_index {
        providers[index].is_recommended = true;
    }
}

#[derive(Default)]
struct TomlInfo {
    provider_name: Option<String>,
    name: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
}

fn parse_codex_toml(raw: &str) -> TomlInfo {
    let parsed: toml::Value = match raw.parse() {
        Ok(value) => value,
        Err(_) => return TomlInfo::default(),
    };
    let provider_name = parsed.get("model_provider").and_then(|value| value.as_str()).map(str::to_string)
        .or_else(|| parsed.get("model_providers").and_then(|value| value.as_table()).and_then(|table| table.keys().next().cloned()));
    let provider = provider_name.as_ref()
        .and_then(|name| parsed.get("model_providers").and_then(|value| value.get(name)))
        .unwrap_or(&toml::Value::Boolean(false))
        .clone();
    TomlInfo {
        provider_name: provider_name.clone(),
        name: provider.get("name").and_then(|value| value.as_str()).map(str::to_string).or(provider_name),
        base_url: provider.get("base_url").and_then(|value| value.as_str()).map(str::to_string),
        api_key: provider.get("experimental_bearer_token").and_then(|value| value.as_str()).map(str::to_string),
        model: parsed.get("model").and_then(|value| value.as_str()).map(str::to_string),
        protocol: provider.get("wire_api").and_then(|value| value.as_str()).map(str::to_string),
    }
}

fn parse_json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

fn find_string_by_keys(value: &Value, keys: &[&str]) -> Option<String> {
    let wanted: HashSet<String> = keys.iter().map(|key| normalize_key(key)).collect();
    fn visit(value: &Value, wanted: &HashSet<String>, depth: usize) -> Option<String> {
        if depth > 6 { return None; }
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if wanted.contains(&normalize_key(key)) {
                        if let Some(text) = child.as_str() {
                            if !text.trim().is_empty() { return Some(text.trim().to_string()); }
                        }
                    }
                }
                for child in map.values() {
                    if let Some(found) = visit(child, wanted, depth + 1) { return Some(found); }
                }
                None
            }
            Value::Array(items) => items.iter().find_map(|item| visit(item, wanted, depth + 1)),
            _ => None,
        }
    }
    visit(value, &wanted, 0)
}

fn normalize_key(value: &str) -> String {
    value.to_ascii_lowercase().replace(['_', '-'], "")
}

fn first_url(values: Vec<Option<String>>) -> Option<String> {
    values.into_iter().flatten().find(|value| value.starts_with("http://") || value.starts_with("https://"))
}

fn first_string(values: Vec<Option<String>>) -> Option<String> {
    values.into_iter().flatten().find(|value| !value.trim().is_empty())
}

fn mask_secret(secret: Option<&str>) -> Option<String> {
    let secret = secret?;
    if secret.len() <= 10 { return Some(format!("{}***", &secret[..secret.len().min(2)])); }
    Some(format!("{}...{}", &secret[..3], &secret[secret.len() - 4..]))
}

fn source_report(id: &str, label: &str, path: &Path, exists: bool, status: &str, provider_count: usize, message: &str) -> DiscoverySourceReport {
    DiscoverySourceReport { id: id.into(), label: label.into(), path: path.display().to_string(), exists, status: status.into(), provider_count, message: message.into() }
}

fn recent_activity(state: &tauri::State<AppRuntime>, limit: usize) -> Result<Vec<ActivityEvent>, String> {
    let activity = state.activity.lock().map_err(|error| error.to_string())?;
    let start = activity.len().saturating_sub(limit);
    Ok(activity[start..].to_vec())
}

fn push_activity(state: &tauri::State<AppRuntime>, event: ActivityEvent) -> Result<(), String> {
    let mut activity = state.activity.lock().map_err(|error| error.to_string())?;
    activity.push(event);
    let keep = 500;
    if activity.len() > keep {
        let drop_count = activity.len() - keep;
        activity.drain(0..drop_count);
    }
    Ok(())
}

fn command_activity_event(command: &str, mode: GuardMode) -> ActivityEvent {
    let decision = evaluate_command(command, mode);
    let lower = command.to_ascii_lowercase();
    let kind = if decision.severity == "critical" || decision.severity == "high" {
        "risk"
    } else if lower.contains("curl ") || lower.contains("wget ") || lower.contains("invoke-webrequest") || lower.contains(" irm ") {
        "network"
    } else if lower.contains("remove-item") || lower.contains("rm ") || lower.contains("del ") {
        "file-delete"
    } else if lower.contains("new-item") || lower.contains("touch ") || lower.contains("mkdir ") {
        "file-create"
    } else if lower.contains(" >") || lower.contains("write-output") || lower.contains("set-content") || lower.contains("add-content") {
        "file-modify"
    } else if lower.contains("cat ") || lower.contains("type ") || lower.contains("get-content") || lower.contains(" rg ") || lower.starts_with("rg ") || lower.contains("grep ") {
        "file-read"
    } else {
        "command"
    };
    let title = activity_title(kind);
    ActivityEvent {
        id: format!("evt-{}", Utc::now().timestamp_nanos_opt().unwrap_or_default()),
        timestamp: Utc::now().to_rfc3339(),
        kind: kind.into(),
        title,
        command: Some(command.to_string()),
        paths: decision.matched_paths.clone(),
        severity: decision.severity,
        summary: decision.message,
        line_delta: None,
        lines_added: None,
        lines_removed: None,
        source: Some("command".into()),
    }
}

fn file_activity_event(input: FileEventInput) -> ActivityEvent {
    let kind = normalize_activity_kind(&input.kind);
    let title = activity_title(&kind);
    let path_count = input.paths.len();
    ActivityEvent {
        id: format!("evt-{}", Utc::now().timestamp_nanos_opt().unwrap_or_default()),
        timestamp: Utc::now().to_rfc3339(),
        kind,
        title,
        command: None,
        paths: input.paths,
        severity: "info".into(),
        summary: input.summary.unwrap_or_else(|| format!("记录了 {} 个文件活动", path_count)),
        line_delta: input.line_delta,
        lines_added: input.lines_added,
        lines_removed: input.lines_removed,
        source: input.source,
    }
}

fn normalize_activity_kind(kind: &str) -> String {
    match kind {
        "file-read" | "file-create" | "file-delete" | "file-modify" | "network" | "risk" | "command" => kind.into(),
        _ => "command".into(),
    }
}

fn activity_title(kind: &str) -> String {
    match kind {
        "file-read" => "读取文件".into(),
        "file-create" => "新建文件".into(),
        "file-delete" => "删除文件".into(),
        "file-modify" => "修改文件".into(),
        "network" => "网络请求".into(),
        "risk" => "高危命令".into(),
        _ => "执行命令".into(),
    }
}

fn evaluate_command(command: &str, mode: GuardMode) -> InspectDecision {
    let path_like = Regex::new(r#"(?i)([a-z]:\\[^\s"']+|/[A-Za-z0-9_./-]+|\.\.?[/\\][^\s"']+)"#).unwrap();
    let matched_paths: Vec<String> = path_like
        .find_iter(command)
        .map(|item| item.as_str().trim_matches(['\"', '\'']).to_string())
        .collect();
    let lower = command.to_ascii_lowercase();

    // 只精确匹配真正的密钥 / 凭据文件，避免把 .codex 下的普通配置、skill、md 笔记误判为高危。
    let secret = Regex::new(
        r"(?i)(id_rsa|id_ed25519|id_ecdsa|\.ssh[\\/]|\.aws[\\/]credentials|\.codex[\\/](auth\.json|secrets|\.sandbox-secrets)|[\\/]\.env\b|\bcredentials\.(json|txt|ya?ml)|private[_-]?key|\.pem\b|\.pfx\b|\.p12\b)",
    )
    .unwrap();
    let touches_secret = secret.is_match(command);

    // 访问其他 AI 工具的凭据 / 供应商数据库（如 cc-switch.db，存有本机所有供应商的 Key 与地址）。
    let cred_store = Regex::new(
        r"(?i)(cc[-_]switch\.db|[\\/]\.?cc-switch[\\/]|\bsqlite3?\b.*\b(providers?|api[_-]?keys?|secrets?|credentials?|tokens?)\b|keychain)",
    )
    .unwrap();
    let touches_db = cred_store.is_match(command);
    let sensitive = touches_secret || touches_db;

    let is_network = lower.contains("invoke-webrequest")
        || lower.contains("invoke-restmethod")
        || lower.contains("curl ")
        || lower.contains(" irm ")
        || lower.contains(" iwr ")
        || lower.contains("wget ");
    let is_recursive_delete = lower.contains("rm -rf")
        || lower.contains("rm -fr")
        || (lower.contains("remove-item") && lower.contains("-recurse"))
        || lower.contains("rmdir /s")
        || lower.contains("rd /s");
    let is_delete = is_recursive_delete
        || lower.contains("remove-item")
        || lower.contains("rm -r ")
        || lower.contains("del ")
        || lower.contains("erase ");

    let block_action = |dangerous: bool| {
        if dangerous && matches!(mode, GuardMode::Block) { "block" } else { "allow" }.to_string()
    };

    // 严重：把密钥 / 凭据通过网络外传。
    if sensitive && is_network {
        return InspectDecision {
            severity: "critical".into(),
            action: block_action(true),
            message: "疑似把密钥或凭据通过网络外传，需要人工确认。".into(),
            matched_paths,
        };
    }
    // 高危：读取其他工具的凭据 / 供应商数据库（含本机配置的全部 API Key 与地址）。
    if touches_db {
        return InspectDecision {
            severity: "high".into(),
            action: "allow".into(),
            message: "命令访问了其他工具的凭据 / 供应商数据库，可能读取本机配置的 API Key 与地址。".into(),
            matched_paths,
        };
    }
    // 高危：直接访问密钥 / 凭据文件，或递归删除。
    if touches_secret {
        return InspectDecision {
            severity: "high".into(),
            action: "allow".into(),
            message: "命令访问了密钥 / 凭据类文件。".into(),
            matched_paths,
        };
    }
    if is_recursive_delete {
        return InspectDecision {
            severity: "high".into(),
            action: block_action(true),
            message: "命令包含递归删除操作。".into(),
            matched_paths,
        };
    }
    // 中：网络请求或一般删除，值得留意但通常是正常操作。
    if is_network {
        return InspectDecision {
            severity: "medium".into(),
            action: "allow".into(),
            message: "命令包含网络请求。".into(),
            matched_paths,
        };
    }
    if is_delete {
        return InspectDecision {
            severity: "medium".into(),
            action: "allow".into(),
            message: "命令包含删除操作。".into(),
            matched_paths,
        };
    }
    // 其余（读取、搜索、调试、普通命令）不告警。
    InspectDecision {
        severity: "info".into(),
        action: "allow".into(),
        message: "命令未命中高危规则。".into(),
        matched_paths,
    }
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");
    command.arg(path).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "start", "", url]);
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(url);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url);
        cmd
    };
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}
