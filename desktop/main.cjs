const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const NODE = process.env.npm_node_execpath || process.env.NODE || "node";
const PORTS = [8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797, 8798, 8799];

let backend = null;
let backendUrl = null;

app.setName("Codex Baoan");
app.setAppUserModelId("com.codexbaoan.desktop");
Menu.setApplicationMenu(null);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.whenReady().then(async () => {
  backendUrl = await ensureBackend();
  const window = createWindow();
  await window.loadURL(backendUrl);
}).catch((error) => {
  dialog.showErrorBox("Codex Baoan failed to start", error instanceof Error ? error.stack || error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopBackend);

function createWindow() {
  const window = new BrowserWindow({
    width: 1000,
    height: 650,
    minWidth: 900,
    minHeight: 600,
    center: true,
    show: false,
    title: "Codex Baoan",
    backgroundColor: "#f7f8fa",
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: process.platform === "win32" ? { color: "#f7f8fa", symbolColor: "#667085", height: 48 } : undefined,
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  window.once("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

async function ensureBackend() {
  for (const port of PORTS) {
    const url = "http://127.0.0.1:" + port;
    if (await isHealthy(url)) return url;
  }

  for (const port of PORTS) {
    const child = spawn(NODE, [CLI, "gui", "--no-open", "--port", String(port)], {
      cwd: ROOT,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, CODEX_BAOAN_DESKTOP: "1" }
    });
    backend = child;
    child.unref();
    const url = "http://127.0.0.1:" + port;
    if (await waitForHealth(url, 7000)) return url;
    stopBackend();
  }

  throw new Error("Could not start Codex Baoan backend.");
}

function isHealthy(url) {
  return new Promise((resolve) => {
    const request = http.get(url + "/api/state", { timeout: 800 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitForHealth(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isHealthy(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function stopBackend() {
  if (backend && !backend.killed) {
    backend.kill();
  }
  backend = null;
}
