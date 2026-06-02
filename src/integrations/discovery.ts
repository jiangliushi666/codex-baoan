import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { parse as parseToml } from "smol-toml";

export type DiscoverySource = "ccswitch" | "codexplusplus" | "codex-config";
export type ProviderStatus = "ready" | "needs-auth" | "unconfigured";
export type SourceStatus = "ok" | "missing" | "error";

export interface DiscoverySourceReport {
  id: DiscoverySource;
  label: string;
  path: string;
  exists: boolean;
  status: SourceStatus;
  providerCount: number;
  message: string;
}

export interface DiscoveredProvider {
  id: string;
  source: DiscoverySource;
  sourceLabel: string;
  sourcePath: string;
  nativeId: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  maskedApiKey?: string;
  hasApiKey: boolean;
  authState: "present" | "missing";
  status: ProviderStatus;
  statusText: string;
  isCurrent: boolean;
  isRecommended: boolean;
  model?: string;
  providerName?: string;
  protocol?: string;
  category?: string;
  websiteUrl?: string;
  notes: string[];
}

export interface ProviderDiscoveryResult {
  generatedAt: string;
  providers: DiscoveredProvider[];
  sources: DiscoverySourceReport[];
  recommendedProviderId?: string;
  manualFallback: { enabled: boolean; reason: string };
}

export interface DiscoveryOptions {
  homeDir?: string;
}

const require = createRequire(import.meta.url);
let sqlJsPromise: Promise<SqlJsStatic> | undefined;

export async function discoverProviders(options: DiscoveryOptions = {}): Promise<ProviderDiscoveryResult> {
  const homeDir = options.homeDir || homedir();
  const sources: DiscoverySourceReport[] = [];
  const providers: DiscoveredProvider[] = [];
  for (const discover of [discoverCcswitch, discoverCodexPlusPlus, discoverCodexConfig]) {
    const result = await discover(homeDir);
    sources.push(result.source);
    providers.push(...result.providers);
  }

  markRecommended(providers);
  const recommendedProviderId = providers.find((provider) => provider.isRecommended)?.id;
  return {
    generatedAt: new Date().toISOString(),
    providers,
    sources,
    recommendedProviderId,
    manualFallback: {
      enabled: !recommendedProviderId,
      reason: recommendedProviderId ? "Auto-discovered a Codex upstream." : "No usable upstream was discovered. Manual fallback is needed."
    }
  };
}

export function selectDiscoveredProvider(discovery: ProviderDiscoveryResult, providerId?: string): DiscoveredProvider | undefined {
  if (providerId) {
    return discovery.providers.find((provider) => provider.id === providerId && isSelectable(provider));
  }
  return discovery.providers.find((provider) => provider.isRecommended && isSelectable(provider))
    || discovery.providers.find((provider) => provider.isCurrent && isSelectable(provider))
    || discovery.providers.find(isSelectable);
}

export function publicDiscoveryResult(discovery: ProviderDiscoveryResult): ProviderDiscoveryResult {
  return { ...discovery, providers: discovery.providers.map(redactProvider) };
}

export function maskSecret(secret?: string): string | undefined {
  if (!secret) return undefined;
  if (secret.length <= 10) return secret.slice(0, 2) + "***";
  return secret.slice(0, 3) + "..." + secret.slice(-4);
}

export function extractCodexProviderFromToml(contents: string, preferredProvider?: string): Partial<DiscoveredProvider> {
  if (!contents.trim()) return {};
  const parsed = parseToml(contents) as Record<string, unknown>;
  const modelProviders = asRecord(parsed.model_providers);
  const providerName = preferredProvider || asString(parsed.model_provider) || Object.keys(modelProviders)[0];
  const provider = providerName ? asRecord(modelProviders[providerName]) : {};
  const envKey = asString(provider.env_key);
  return {
    providerName,
    name: asString(provider.name) || providerName || "Codex Provider",
    baseUrl: asString(provider.base_url),
    apiKey: asString(provider.experimental_bearer_token) || (envKey ? asString(process.env[envKey]) : undefined),
    model: asString(parsed.model),
    protocol: asString(provider.wire_api)
  };
}

async function discoverCcswitch(homeDir: string): Promise<{ source: DiscoverySourceReport; providers: DiscoveredProvider[] }> {
  const paths = uniquePaths([
    path.join(homeDir, ".cc-switch", "cc-switch.db"),
    path.join(homeDir, ".ccswitch", "cc-switch.db"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "cc-switch", "cc-switch.db") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "cc-switch", "cc-switch.db") : ""
  ].filter(Boolean));
  const dbPath = paths.find((candidate) => existsSync(candidate)) || paths[0];
  if (!dbPath || !existsSync(dbPath)) {
    return { source: sourceReport("ccswitch", "ccswitch", dbPath || path.join(homeDir, ".cc-switch", "cc-switch.db"), false, "missing", 0, "ccswitch database was not found."), providers: [] };
  }

  try {
    const providers = await readCcswitchProviders(dbPath);
    const message = providers.length ? "Loaded " + providers.length + " Codex providers." : "Database exists but has no Codex providers.";
    return { source: sourceReport("ccswitch", "ccswitch", dbPath, true, "ok", providers.length, message), providers };
  } catch (error) {
    return { source: sourceReport("ccswitch", "ccswitch", dbPath, true, "error", 0, errorMessage(error)), providers: [] };
  }
}

async function readCcswitchProviders(dbPath: string): Promise<DiscoveredProvider[]> {
  const SQL = await getSqlJs();
  const db = new SQL.Database(await readFile(dbPath));
  try {
    if (db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providers'").length === 0) {
      throw new Error("ccswitch database has no providers table.");
    }
    const sql = [
      "SELECT p.id, p.name, p.settings_config, p.website_url, p.category, p.notes,",
      "       p.icon, p.icon_color, p.meta, p.is_current, p.sort_index, p.created_at,",
      "       (SELECT GROUP_CONCAT(e.url, char(10)) FROM provider_endpoints e",
      "        WHERE e.provider_id = p.id AND e.app_type = p.app_type) AS endpoints",
      "FROM providers p",
      "WHERE p.app_type = 'codex'",
      "ORDER BY p.is_current DESC, COALESCE(p.sort_index, 999999), COALESCE(p.created_at, 0), p.name ASC"
    ].join("\n");
    return execRows(db, sql).map((row, index) => ccswitchRowToProvider(row, dbPath, index));
  } finally {
    db.close();
  }
}

async function discoverCodexPlusPlus(homeDir: string): Promise<{ source: DiscoverySourceReport; providers: DiscoveredProvider[] }> {
  const settingsPath = path.join(homeDir, ".codex-session-delete", "settings.json");
  if (!existsSync(settingsPath)) {
    return { source: sourceReport("codexplusplus", "Codex++", settingsPath, false, "missing", 0, "Codex++ settings were not found."), providers: [] };
  }

  try {
    const settings = parseJsonObject(await readFile(settingsPath, "utf8"));
    const providers = codexPlusSettingsToProviders(settings, settingsPath);
    const message = providers.length ? "Loaded " + providers.length + " Codex++ relay profiles." : "Settings exist but no relay profile is configured.";
    return { source: sourceReport("codexplusplus", "Codex++", settingsPath, true, "ok", providers.length, message), providers };
  } catch (error) {
    return { source: sourceReport("codexplusplus", "Codex++", settingsPath, true, "error", 0, errorMessage(error)), providers: [] };
  }
}

async function discoverCodexConfig(homeDir: string): Promise<{ source: DiscoverySourceReport; providers: DiscoveredProvider[] }> {
  const configPath = path.join(homeDir, ".codex", "config.toml");
  if (!existsSync(configPath)) {
    return { source: sourceReport("codex-config", "Codex config", configPath, false, "missing", 0, "Codex config.toml was not found."), providers: [] };
  }

  try {
    const auth = await readCodexAuth(homeDir);
    const provider = codexConfigToProvider(await readFile(configPath, "utf8"), configPath, asString(auth.OPENAI_API_KEY));
    const providers = provider ? [provider] : [];
    const message = providers.length ? "Loaded current Codex model_provider." : "config.toml exists but has no usable model_provider.";
    return { source: sourceReport("codex-config", "Codex config", configPath, true, "ok", providers.length, message), providers };
  } catch (error) {
    return { source: sourceReport("codex-config", "Codex config", configPath, true, "error", 0, errorMessage(error)), providers: [] };
  }
}

function ccswitchRowToProvider(row: Record<string, unknown>, dbPath: string, index: number): DiscoveredProvider {
  const settings = parseJsonObject(asString(row.settings_config) || "{}");
  const meta = parseJsonObject(asString(row.meta) || "{}");
  const auth = asRecord(settings.auth);
  const configInfo = parseTomlLenient(asString(settings.config));
  const endpointCandidates = [
    ...arrayOfStrings(settings.endpointCandidates),
    ...arrayOfStrings(meta.endpointCandidates),
    ...Object.keys(asRecord(meta.custom_endpoints)),
    ...splitLines(asString(row.endpoints))
  ];
  const baseUrl = firstUsableUrl(configInfo.baseUrl, findStringByKeys(settings, ["baseUrl", "base_url", "apiBaseUrl", "api_base_url", "upstreamBaseUrl", "upstream_base_url"]), endpointCandidates[0]);
  const apiKey = firstString(
    findStringByKeys(auth, ["OPENAI_API_KEY", "apiKey", "api_key", "openaiApiKey", "experimental_bearer_token"]),
    configInfo.apiKey,
    findStringByKeys(settings, ["OPENAI_API_KEY", "apiKey", "api_key", "openaiApiKey", "experimental_bearer_token"])
  );
  const nativeId = asString(row.id) || String(index);
  return finalizeProvider({
    id: "ccswitch:" + encodeId(nativeId),
    source: "ccswitch",
    sourceLabel: "ccswitch",
    sourcePath: dbPath,
    nativeId,
    name: asString(row.name) || "ccswitch Provider",
    baseUrl,
    apiKey,
    isCurrent: asBoolean(row.is_current),
    model: configInfo.model || findStringByKeys(settings, ["model", "modelName", "testModel"]),
    providerName: configInfo.providerName,
    protocol: configInfo.protocol || findStringByKeys(settings, ["wireApi", "wire_api", "apiFormat", "protocol"]),
    category: asString(row.category),
    websiteUrl: asString(row.website_url),
    notes: compact([asString(row.notes), endpointCandidates.length > 1 ? String(endpointCandidates.length) + " endpoint candidates" : undefined])
  });
}

function codexPlusSettingsToProviders(settings: Record<string, unknown>, settingsPath: string): DiscoveredProvider[] {
  const activeRelayId = asString(settings.activeRelayId) || "default";
  const relayBaseUrl = asString(settings.relayBaseUrl);
  const relayApiKey = asString(settings.relayApiKey);
  const providers = arrayOfRecords(settings.relayProfiles).map((profile, index) => {
    const configInfo = parseTomlLenient(asString(profile.configContents));
    const auth = parseJsonObject(asString(profile.authContents) || "{}");
    const nativeId = asString(profile.id) || String(index);
    return finalizeProvider({
      id: "codexplusplus:" + encodeId(nativeId),
      source: "codexplusplus",
      sourceLabel: "Codex++",
      sourcePath: settingsPath,
      nativeId,
      name: asString(profile.name) || "Codex++ relay",
      baseUrl: firstUsableUrl(asString(profile.upstreamBaseUrl), asString(profile.baseUrl), configInfo.baseUrl, relayBaseUrl),
      apiKey: firstString(asString(profile.apiKey), configInfo.apiKey, findStringByKeys(auth, ["OPENAI_API_KEY", "apiKey", "api_key", "experimental_bearer_token"]), relayApiKey),
      isCurrent: nativeId === activeRelayId,
      model: asString(profile.model) || configInfo.model || asString(settings.relayTestModel),
      providerName: configInfo.providerName || "CodexPlusPlus",
      protocol: asString(profile.protocol) || configInfo.protocol,
      category: asString(profile.relayMode),
      notes: compact([asString(profile.linkedCcsProviderId) ? "linked ccswitch: " + asString(profile.linkedCcsProviderId) : undefined, asBoolean(profile.officialMixApiKey) ? "official login mixed with API key" : undefined])
    });
  });

  if (asBoolean(settings.cliWrapperEnabled) && asString(settings.cliWrapperBaseUrl)) {
    providers.push(finalizeProvider({
      id: "codexplusplus:cli-wrapper",
      source: "codexplusplus",
      sourceLabel: "Codex++",
      sourcePath: settingsPath,
      nativeId: "cli-wrapper",
      name: "Codex++ CLI Wrapper",
      baseUrl: asString(settings.cliWrapperBaseUrl),
      apiKey: asString(settings.cliWrapperApiKey) || asString(process.env[asString(settings.cliWrapperApiKeyEnv) || ""]),
      isCurrent: providers.every((provider) => !isSelectable(provider)),
      providerName: "cli-wrapper",
      protocol: "responses",
      notes: ["from Codex++ CLI wrapper settings"]
    }));
  }

  return providers;
}

function codexConfigToProvider(configText: string, configPath: string, authApiKey?: string): DiscoveredProvider | undefined {
  const configInfo = extractCodexProviderFromToml(configText);
  if (!configInfo.providerName && !configInfo.baseUrl) return undefined;
  const providerName = configInfo.providerName || "custom";
  return finalizeProvider({
    id: "codex-config:" + encodeId(providerName),
    source: "codex-config",
    sourceLabel: "Codex config",
    sourcePath: configPath,
    nativeId: providerName,
    name: configInfo.name || providerName,
    baseUrl: configInfo.baseUrl,
    apiKey: configInfo.apiKey || authApiKey,
    isCurrent: true,
    model: configInfo.model,
    providerName,
    protocol: configInfo.protocol,
    notes: ["from ~/.codex/config.toml"]
  });
}

async function readCodexAuth(homeDir: string): Promise<Record<string, unknown>> {
  const authPath = path.join(homeDir, ".codex", "auth.json");
  if (!existsSync(authPath)) return {};
  try {
    return parseJsonObject(await readFile(authPath, "utf8"));
  } catch {
    return {};
  }
}

function finalizeProvider(provider: Omit<DiscoveredProvider, "hasApiKey" | "authState" | "status" | "statusText" | "isRecommended" | "maskedApiKey">): DiscoveredProvider {
  const hasApiKey = Boolean(provider.apiKey);
  const status: ProviderStatus = provider.baseUrl && !looksPlaceholder(provider.baseUrl) ? (hasApiKey ? "ready" : "needs-auth") : "unconfigured";
  return {
    ...provider,
    maskedApiKey: maskSecret(provider.apiKey),
    hasApiKey,
    authState: hasApiKey ? "present" : "missing",
    status,
    statusText: status === "ready" ? "Ready" : status === "needs-auth" ? "Needs auth" : "Not configured",
    isRecommended: false
  };
}

function markRecommended(providers: DiscoveredProvider[]): void {
  let best: DiscoveredProvider | undefined;
  let bestScore = -1;
  const sourceScore: Record<DiscoverySource, number> = { ccswitch: 20, codexplusplus: 15, "codex-config": 10 };
  for (const provider of providers) {
    if (!isSelectable(provider)) continue;
    const score = (provider.isCurrent ? 100 : 0) + (provider.hasApiKey ? 30 : 0) + sourceScore[provider.source] + (provider.status === "ready" ? 10 : 0);
    if (score > bestScore) {
      best = provider;
      bestScore = score;
    }
  }
  if (best) best.isRecommended = true;
}

function isSelectable(provider: DiscoveredProvider): boolean {
  return Boolean(provider.baseUrl && !looksPlaceholder(provider.baseUrl));
}

function redactProvider(provider: DiscoveredProvider): DiscoveredProvider {
  const { apiKey: _apiKey, ...safe } = provider;
  return safe;
}

function parseTomlLenient(contents?: string): Partial<DiscoveredProvider> {
  if (!contents || !contents.trim()) return {};
  try {
    return extractCodexProviderFromToml(contents);
  } catch {
    return {};
  }
}

function execRows(db: Database, sql: string): Array<Record<string, unknown>> {
  const stmt = db.prepare(sql);
  try {
    const rows: Array<Record<string, unknown>> = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
    return rows;
  } finally {
    stmt.free();
  }
}

async function getSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise = sqlJsPromise || initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
  return sqlJsPromise;
}

function sourceReport(id: DiscoverySource, label: string, sourcePath: string, exists: boolean, status: SourceStatus, providerCount: number, message: string): DiscoverySourceReport {
  return { id, label, path: sourcePath, exists, status, providerCount, message };
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function findStringByKeys(value: unknown, keys: string[]): string | undefined {
  const wanted = new Set(keys.map(normalizeKey));
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): string | undefined => {
    if (!node || typeof node !== "object" || depth > 5 || seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(node)) {
      if (wanted.has(normalizeKey(key))) {
        const text = asString(child);
        if (text) return text;
      }
    }
    for (const child of Object.values(node)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value, 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((item): item is string => Boolean(item)) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find(Boolean);
}

function firstUsableUrl(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value && /^https?:\/\//i.test(value) && !looksPlaceholder(value)));
}

function looksPlaceholder(value: string): boolean {
  return /YOUR_|example\.(com|test)|<|>|\{\}/i.test(value);
}

function splitLines(value?: string): string[] {
  return value ? value.split(/[\r\n]+/).map((item) => item.trim()).filter(Boolean) : [];
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[_-]/g, "");
}

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function encodeId(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
