import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GuardConfig, GuardMode, PolicyContext, Severity } from "./types.js";
import { deriveAllowedRootsFromPrompt, normalizeRoot } from "./policy/pathScope.js";

export const DEFAULT_CONFIG_FILE = "codex-guard.json";

export function createDefaultConfig(): GuardConfig {
  return {
    version: 1,
    mode: "audit",
    logRoot: ".codex-guard/sessions",
    scope: {
      defaultRoots: ["."],
      extraAllow: [],
      deny: []
    },
    risk: {
      blockLevels: ["critical"],
      allowedNetworkHosts: []
    },
    codexCli: {
      executable: "codex",
      captureStdout: true,
      captureStderr: true,
      watchProcessTree: true
    },
    appWatcher: {
      processNames: ["codex", "Codex", "codex-app"],
      pollIntervalMs: 1000,
      killOnBlock: false
    },
    modelProxy: {
      listenHost: "127.0.0.1",
      port: 8787,
      upstreamBaseUrl: "https://api.openai.com",
      captureBodies: true,
      maxCapturedBodyBytes: 1024 * 1024
    }
  };
}

export function resolveConfigPath(explicitPath?: string, cwd = process.cwd()): string {
  if (explicitPath) {
    return path.resolve(cwd, explicitPath);
  }

  if (process.env.CODEX_GUARD_CONFIG) {
    return path.resolve(cwd, process.env.CODEX_GUARD_CONFIG);
  }

  const local = path.resolve(cwd, DEFAULT_CONFIG_FILE);
  if (existsSync(local)) {
    return local;
  }

  return path.join(homedir(), ".codex-guard", "config.json");
}

export async function loadConfig(explicitPath?: string, cwd = process.cwd()): Promise<GuardConfig> {
  const configPath = resolveConfigPath(explicitPath, cwd);
  const defaults = createDefaultConfig();
  if (!existsSync(configPath)) {
    return defaults;
  }

  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<GuardConfig>;
  return mergeConfig(defaults, parsed);
}

export async function writeDefaultConfig(configPath: string, force = false): Promise<void> {
  const resolved = path.resolve(configPath);
  if (existsSync(resolved) && !force) {
    throw new Error(`Config already exists: ${resolved}. Pass --force to overwrite it.`);
  }

  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(createDefaultConfig(), null, 2)}\n`, "utf8");
}

export function buildPolicyContext(
  config: GuardConfig,
  options: {
    cwd?: string;
    mode?: GuardMode;
    promptText?: string;
    extraAllow?: string[];
    blockLevels?: Severity[];
  } = {}
): PolicyContext {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const promptRoots = options.promptText ? deriveAllowedRootsFromPrompt(options.promptText, cwd) : [];
  const rawAllowed = [
    ...config.scope.defaultRoots,
    ...config.scope.extraAllow,
    ...(options.extraAllow ?? []),
    ...promptRoots
  ];
  const allowedRoots = rawAllowed.map((root) => normalizeRoot(root, cwd));
  const deniedRoots = config.scope.deny.map((root) => normalizeRoot(root, cwd));

  return {
    cwd,
    allowedRoots: uniquePaths(allowedRoots),
    deniedRoots: uniquePaths(deniedRoots),
    mode: options.mode ?? config.mode,
    blockLevels: options.blockLevels ?? config.risk.blockLevels,
    allowedNetworkHosts: config.risk.allowedNetworkHosts
  };
}

function mergeConfig(defaults: GuardConfig, overrides: Partial<GuardConfig>): GuardConfig {
  return {
    ...defaults,
    ...overrides,
    scope: { ...defaults.scope, ...overrides.scope },
    risk: { ...defaults.risk, ...overrides.risk },
    codexCli: { ...defaults.codexCli, ...overrides.codexCli },
    appWatcher: { ...defaults.appWatcher, ...overrides.appWatcher },
    modelProxy: { ...defaults.modelProxy, ...overrides.modelProxy }
  };
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const key = process.platform === "win32" ? item.toLowerCase() : item;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}
