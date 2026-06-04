export type SourceStatus = "ok" | "missing" | "error";
export type ProviderStatus = "ready" | "needs-auth" | "unconfigured";
export type GuardMode = "audit" | "block";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type KnownProviderSource = "ccswitch" | "codexplusplus" | "codex-config";
export type ProviderSource = KnownProviderSource | (string & {});
export type ViewId = "all" | KnownProviderSource | "status";

export interface DiscoverySourceReport {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  status: SourceStatus;
  provider_count: number;
  message: string;
}

export interface DiscoveredProvider {
  id: string;
  source: ProviderSource;
  source_label: string;
  source_path: string;
  native_id: string;
  name: string;
  base_url?: string;
  masked_api_key?: string;
  has_api_key: boolean;
  status: ProviderStatus;
  status_text: string;
  is_current: boolean;
  is_recommended: boolean;
  model?: string;
  protocol?: string;
  notes: string[];
}

export interface DiscoveryResult {
  generated_at: string;
  providers: DiscoveredProvider[];
  sources: DiscoverySourceReport[];
  recommended_provider_id?: string;
  manual_fallback_reason: string;
}

export interface RuntimeState {
  running: boolean;
  provider_id?: string;
  provider_name?: string;
  mode: GuardMode;
  started_at?: string;
  local_proxy_url?: string;
}

export interface AppInfo {
  version: string;
  install_dir: string;
  bundle_managed: boolean;
  updater_configured: boolean;
}

export interface AppState {
  app: AppInfo;
  discovery: DiscoveryResult;
  runtime: RuntimeState;
}

export interface InspectDecision {
  severity: Severity;
  action: "allow" | "block";
  message: string;
  matched_paths: string[];
}
