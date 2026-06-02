import { spawn } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { buildPolicyContext, createDefaultConfig, loadConfig, resolveConfigPath } from "../config.js";
import { createSessionLogger } from "../logger.js";
import { startProcessWatcher, type ProcessWatcherHandle } from "../monitors/appProcessWatcher.js";
import { decisionMessage, evaluateCommand } from "../policy/engine.js";
import { createOpenAIProxyServer, listenOpenAIProxyServer } from "../proxy/openaiProxy.js";
import type { GuardConfig, GuardMode, SessionLogger } from "../types.js";

export interface GuiServerOptions {
  host: string;
  port: number;
  cwd: string;
  configPath?: string;
  openBrowser: boolean;
}

interface RuntimeState {
  proxy?: {
    server: Server;
    logger: SessionLogger;
    url: string;
    upstream: string;
    startedAt: string;
  };
  watcher?: {
    handle: ProcessWatcherHandle;
    logger: SessionLogger;
    processNames: string[];
    startedAt: string;
  };
}

const STATIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");

export async function startGuiServer(options: GuiServerOptions): Promise<void> {
  const state: RuntimeState = {};
  const configPath = path.resolve(options.cwd, options.configPath ?? "codex-guard.json");

  const server = http.createServer((request, response) => {
    void routeRequest(request, response, { ...options, configPath }, state);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });

  const url = `http://${options.host}:${options.port}`;
  console.log(`Codex 保安 GUI: ${url}`);
  if (options.openBrowser) {
    openBrowser(url);
  }

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  state.watcher?.handle.stop();
  if (state.proxy) {
    await closeServer(state.proxy.server);
  }
  await closeServer(server);
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GuiServerOptions & { configPath: string },
  state: RuntimeState
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/") {
      return await serveStatic(response, "index.html");
    }
    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      return await serveStatic(response, url.pathname.replace(/^\/assets\//, ""));
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      return await sendJson(response, await getState(options, state));
    }
    if (url.pathname === "/api/config" && request.method === "POST") {
      return await saveConfig(request, response, options);
    }
    if (url.pathname === "/api/inspect" && request.method === "POST") {
      return await inspectCommand(request, response, options);
    }
    if (url.pathname === "/api/proxy/start" && request.method === "POST") {
      return await startProxy(request, response, options, state);
    }
    if (url.pathname === "/api/proxy/stop" && request.method === "POST") {
      return await stopProxy(response, state);
    }
    if (url.pathname === "/api/quick/start" && request.method === "POST") {
      return await quickStart(request, response, options, state);
    }
    if (url.pathname === "/api/quick/stop" && request.method === "POST") {
      return await quickStop(response, state);
    }
    if (url.pathname === "/api/watcher/start" && request.method === "POST") {
      return await startWatcher(request, response, options, state);
    }
    if (url.pathname === "/api/watcher/stop" && request.method === "POST") {
      return await stopWatcher(response, state);
    }

    sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function getState(options: GuiServerOptions & { configPath: string }, state: RuntimeState): Promise<Record<string, unknown>> {
  const config = await loadConfig(options.configPath, options.cwd).catch(() => createDefaultConfig());
  return {
    appName: "Codex 保安",
    configPath: resolveConfigPath(options.configPath, options.cwd),
    cwd: options.cwd,
    config,
    runtime: {
      proxy: state.proxy ? {
        running: true,
        url: state.proxy.url,
        upstream: state.proxy.upstream,
        startedAt: state.proxy.startedAt,
        sessionDir: state.proxy.logger.sessionDir
      } : { running: false },
      watcher: state.watcher ? {
        running: true,
        processNames: state.watcher.processNames,
        startedAt: state.watcher.startedAt,
        sessionDir: state.watcher.logger.sessionDir
      } : { running: false }
    },
    sessions: await readSessions(config, options.cwd)
  };
}

async function saveConfig(
  request: IncomingMessage,
  response: ServerResponse,
  options: GuiServerOptions & { configPath: string }
): Promise<void> {
  const body = await readJsonBody<{ config: GuardConfig }>(request);
  if (!body.config) {
    return sendJson(response, { error: "Missing config" }, 400);
  }

  await mkdir(path.dirname(options.configPath), { recursive: true });
  await writeFile(options.configPath, `${JSON.stringify(body.config, null, 2)}\n`, "utf8");
  sendJson(response, { ok: true, configPath: options.configPath });
}

async function inspectCommand(
  request: IncomingMessage,
  response: ServerResponse,
  options: GuiServerOptions & { configPath: string }
): Promise<void> {
  const body = await readJsonBody<{ command?: string; mode?: GuardMode; allow?: string }>(request);
  if (!body.command?.trim()) {
    return sendJson(response, { error: "Missing command" }, 400);
  }

  const config = await loadConfig(options.configPath, options.cwd);
  const policyContext = buildPolicyContext(config, {
    cwd: options.cwd,
    mode: body.mode,
    extraAllow: splitList(body.allow)
  });
  const decision = evaluateCommand(body.command, policyContext);
  sendJson(response, { ...decision, message: decisionMessage(decision), policyContext });
}

async function startProxy(
  request: IncomingMessage,
  response: ServerResponse,
  options: GuiServerOptions & { configPath: string },
  state: RuntimeState
): Promise<void> {
  if (state.proxy) {
    return sendJson(response, { error: "Model proxy is already running" }, 409);
  }

  const body = await readJsonBody<{ upstream?: string; host?: string; port?: number; mode?: GuardMode; allow?: string }>(request);
  const config = await loadConfig(options.configPath, options.cwd);
  const host = body.host || config.modelProxy.listenHost;
  const port = Number(body.port || config.modelProxy.port);
  const upstream = body.upstream || config.modelProxy.upstreamBaseUrl;
  const logger = await createSessionLogger(config, "gui-proxy", options.cwd);
  const policyContext = buildPolicyContext(config, {
    cwd: options.cwd,
    mode: body.mode,
    extraAllow: splitList(body.allow)
  });
  const server = createOpenAIProxyServer({ config, logger, policyContext, upstreamBaseUrl: upstream, host, port });
  await listenOpenAIProxyServer(server, host, port);

  state.proxy = {
    server,
    logger,
    url: `http://${host}:${port}`,
    upstream,
    startedAt: new Date().toISOString()
  };
  await logger.record({
    type: "gui.proxy_start",
    source: "gui",
    message: `Model proxy started at ${state.proxy.url}.`,
    data: { upstream, mode: policyContext.mode, allowedRoots: policyContext.allowedRoots }
  });
  sendJson(response, { ok: true, proxy: state.proxy });
}

async function stopProxy(response: ServerResponse, state: RuntimeState): Promise<void> {
  if (!state.proxy) {
    return sendJson(response, { ok: true, running: false });
  }
  const proxy = state.proxy;
  state.proxy = undefined;
  await proxy.logger.record({
    type: "gui.proxy_stop",
    source: "gui",
    message: "Model proxy stopped."
  });
  await closeServer(proxy.server);
  sendJson(response, { ok: true, running: false });
}

async function quickStart(
  request: IncomingMessage,
  response: ServerResponse,
  options: GuiServerOptions & { configPath: string },
  state: RuntimeState
): Promise<void> {
  const body = await readJsonBody<{
    upstream?: string;
    host?: string;
    port?: number;
    mode?: GuardMode;
    allow?: string;
    processNames?: string;
    killOnBlock?: boolean;
  }>(request);
  const config = await loadConfig(options.configPath, options.cwd);
  const mode = body.mode ?? config.mode;
  const extraAllow = splitList(body.allow);

  if (!state.proxy) {
    const host = body.host || config.modelProxy.listenHost;
    const port = Number(body.port || config.modelProxy.port);
    const upstream = body.upstream || config.modelProxy.upstreamBaseUrl;
    const logger = await createSessionLogger(config, "quick-proxy", options.cwd);
    const policyContext = buildPolicyContext(config, { cwd: options.cwd, mode, extraAllow });
    const server = createOpenAIProxyServer({ config, logger, policyContext, upstreamBaseUrl: upstream, host, port });
    await listenOpenAIProxyServer(server, host, port);
    state.proxy = {
      server,
      logger,
      url: `http://${host}:${port}`,
      upstream,
      startedAt: new Date().toISOString()
    };
    await logger.record({
      type: "quick.proxy_start",
      source: "gui",
      message: `One-click model proxy started at ${state.proxy.url}.`,
      data: { upstream, mode, allowedRoots: policyContext.allowedRoots }
    });
  }

  if (!state.watcher) {
    const processNames = splitList(body.processNames).length > 0 ? splitList(body.processNames) : config.appWatcher.processNames;
    const logger = await createSessionLogger(config, "quick-watch", options.cwd);
    const policyContext = buildPolicyContext(config, { cwd: options.cwd, mode, extraAllow });
    const handle = await startProcessWatcher({
      logger,
      policyContext,
      processNames,
      intervalMs: config.appWatcher.pollIntervalMs,
      killOnBlock: Boolean(body.killOnBlock || config.appWatcher.killOnBlock)
    });
    state.watcher = {
      handle,
      logger,
      processNames,
      startedAt: new Date().toISOString()
    };
    await logger.record({
      type: "quick.watcher_start",
      source: "gui",
      message: `One-click app watcher started for ${processNames.join(", ")}.`,
      data: { mode, allowedRoots: policyContext.allowedRoots }
    });
  }

  sendJson(response, { ok: true, state: await getState(options, state) });
}

async function quickStop(response: ServerResponse, state: RuntimeState): Promise<void> {
  if (state.proxy) {
    const proxy = state.proxy;
    state.proxy = undefined;
    await proxy.logger.record({ type: "quick.proxy_stop", source: "gui", message: "One-click protection stopped the model proxy." });
    await closeServer(proxy.server);
  }
  if (state.watcher) {
    const watcher = state.watcher;
    state.watcher = undefined;
    watcher.handle.stop();
    await watcher.logger.record({ type: "quick.watcher_stop", source: "gui", message: "One-click protection stopped the app watcher." });
  }
  sendJson(response, { ok: true, running: false });
}

async function startWatcher(
  request: IncomingMessage,
  response: ServerResponse,
  options: GuiServerOptions & { configPath: string },
  state: RuntimeState
): Promise<void> {
  if (state.watcher) {
    return sendJson(response, { error: "App watcher is already running" }, 409);
  }

  const body = await readJsonBody<{ processNames?: string; mode?: GuardMode; allow?: string; killOnBlock?: boolean }>(request);
  const config = await loadConfig(options.configPath, options.cwd);
  const processNames = splitList(body.processNames).length > 0 ? splitList(body.processNames) : config.appWatcher.processNames;
  const logger = await createSessionLogger(config, "gui-watch", options.cwd);
  const policyContext = buildPolicyContext(config, {
    cwd: options.cwd,
    mode: body.mode,
    extraAllow: splitList(body.allow)
  });
  const handle = await startProcessWatcher({
    logger,
    policyContext,
    processNames,
    intervalMs: config.appWatcher.pollIntervalMs,
    killOnBlock: Boolean(body.killOnBlock || config.appWatcher.killOnBlock)
  });
  state.watcher = {
    handle,
    logger,
    processNames,
    startedAt: new Date().toISOString()
  };
  await logger.record({
    type: "gui.watcher_start",
    source: "gui",
    message: `App watcher started for ${processNames.join(", ")}.`,
    data: { mode: policyContext.mode, allowedRoots: policyContext.allowedRoots }
  });
  sendJson(response, { ok: true, watcher: state.watcher });
}

async function stopWatcher(response: ServerResponse, state: RuntimeState): Promise<void> {
  if (!state.watcher) {
    return sendJson(response, { ok: true, running: false });
  }
  const watcher = state.watcher;
  state.watcher = undefined;
  watcher.handle.stop();
  await watcher.logger.record({
    type: "gui.watcher_stop",
    source: "gui",
    message: "App watcher stopped."
  });
  sendJson(response, { ok: true, running: false });
}

async function readSessions(config: GuardConfig, cwd: string): Promise<Array<Record<string, unknown>>> {
  const root = path.resolve(cwd, config.logRoot);
  if (!existsSync(root)) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const sessionDir = path.join(root, entry.name);
    const info = await stat(sessionDir);
    return {
      id: entry.name,
      sessionDir,
      updatedAt: info.mtime.toISOString(),
      summary: await readOptional(path.join(sessionDir, "summary.md")),
      alerts: await readOptional(path.join(sessionDir, "alerts.md"))
    };
  }));

  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 12);
}

async function serveStatic(response: ServerResponse, relativePath: string): Promise<void> {
  const safePath = safeStaticPath(relativePath);
  const body = await readFile(safePath);
  response.writeHead(200, { "content-type": mimeType(safePath) });
  response.end(body);
}

function safeStaticPath(relativePath: string): string {
  const clean = relativePath.replace(/^[\\/]+/, "");
  const resolved = path.resolve(STATIC_ROOT, clean);
  if (!resolved.startsWith(STATIC_ROOT)) {
    throw new Error("Invalid static path");
  }
  return resolved;
}

async function readOptional(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    return "";
  }
  const value = await readFile(filePath, "utf8");
  return value.length > 6000 ? `${value.slice(0, 6000)}\n...` : value;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {} as T;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function splitList(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function mimeType(filePath: string): string {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  return "application/octet-stream";
}
