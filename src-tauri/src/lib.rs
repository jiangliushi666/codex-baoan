use chrono::Utc;
use regex::Regex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct AppRuntime {
    runtime: Mutex<RuntimeState>,
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
            open_install_dir,
            open_releases,
            open_uninstall_settings
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
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
fn start_guard(provider_id: String, mode: GuardMode, state: tauri::State<AppRuntime>) -> Result<AppState, String> {
    let discovery = discover_providers();
    let provider = discovery
        .providers
        .iter()
        .find(|item| item.id == provider_id && item.status != "unconfigured")
        .cloned()
        .ok_or_else(|| "Provider is not available".to_string())?;

    let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    runtime.running = true;
    runtime.provider_id = Some(provider.id);
    runtime.provider_name = Some(provider.name);
    runtime.mode = mode;
    runtime.started_at = Some(Utc::now().to_rfc3339());
    runtime.local_proxy_url = Some("tauri://codex-baoan/local-guard".to_string());
    drop(runtime);
    build_state(&state)
}

#[tauri::command]
fn stop_guard(state: tauri::State<AppRuntime>) -> Result<AppState, String> {
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
fn open_install_dir() -> Result<(), String> {
    let dir = install_dir();
    open_path(&dir)
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

fn build_state(state: &tauri::State<AppRuntime>) -> Result<AppState, String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?.clone();
    Ok(AppState { app: app_info(), discovery: discover_providers(), runtime })
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
    sources.push(source);
    providers.append(&mut items);
    let (source, mut items) = discover_codex_plusplus(&home);
    sources.push(source);
    providers.append(&mut items);
    let (source, mut items) = discover_codex_config(&home);
    sources.push(source);
    providers.append(&mut items);

    mark_recommended(&mut providers);
    let recommended_provider_id = providers.iter().find(|item| item.is_recommended).map(|item| item.id.clone());
    let manual_fallback_reason = if recommended_provider_id.is_some() {
        "已自动发现可用上游。".to_string()
    } else {
        "未发现可用上游，请先在 ccswitch、Codex++ 或 Codex 中配置 provider。".to_string()
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
            if let Some(Value::Array(profiles)) = settings.get("relayProfiles") {
                for (index, profile) in profiles.iter().enumerate() {
                    let native_id = find_string_by_keys(profile, &["id"]).unwrap_or_else(|| index.to_string());
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
                        is_current: active.as_deref() == Some(&native_id),
                        model: find_string_by_keys(profile, &["model"]),
                        protocol: find_string_by_keys(profile, &["protocol"]),
                        notes: vec![],
                    }));
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

fn evaluate_command(command: &str, mode: GuardMode) -> InspectDecision {
    let sensitive = Regex::new(r"(?i)(\.ssh|\.aws|\.env|id_rsa|id_ed25519|\.codex|credentials|private[_-]?key)").unwrap();
    let path_like = Regex::new(r"(?i)([a-z]:\\[^\s]+|/[A-Za-z0-9_./-]+|\.\.?[/\\][^\s]+)").unwrap();
    let matched_paths: Vec<String> = path_like.find_iter(command).map(|item| item.as_str().trim_matches(['\"', '\'']).to_string()).collect();
    if sensitive.is_match(command) {
        return InspectDecision { severity: "critical".into(), action: if matches!(mode, GuardMode::Block) { "block" } else { "allow" }.into(), message: "命令疑似访问密钥、环境变量或 Codex 凭据。".into(), matched_paths };
    }
    let lower = command.to_ascii_lowercase();
    if lower.contains("invoke-webrequest") || lower.contains("curl ") || lower.contains(" irm ") || lower.contains("wget ") {
        return InspectDecision { severity: "critical".into(), action: if matches!(mode, GuardMode::Block) { "block" } else { "allow" }.into(), message: "命令包含网络传输行为，需要人工确认。".into(), matched_paths };
    }
    if lower.contains("remove-item") || lower.contains("rm -rf") || lower.contains("del ") {
        return InspectDecision { severity: "high".into(), action: "allow".into(), message: "命令包含删除行为。".into(), matched_paths };
    }
    InspectDecision { severity: "info".into(), action: "allow".into(), message: "命令未命中当前高危规则。".into(), matched_paths }
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
