#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPolicyContext, loadConfig, resolveConfigPath, writeDefaultConfig } from "./config.js";
import { createSessionLogger } from "./logger.js";
import { startGuiServer } from "./gui/server.js";
import { runCodexUnderGuard } from "./monitors/codexCli.js";
import { startProcessWatcher } from "./monitors/appProcessWatcher.js";
import { startOpenAIProxy } from "./proxy/openaiProxy.js";
import { decisionMessage, evaluateCommand } from "./policy/engine.js";
import type { GuardMode } from "./types.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv.shift();
  try {
    switch (command) {
      case "init":
        return await initCommand(argv);
      case "run":
        return await runCommand(argv);
      case "proxy":
        return await proxyCommand(argv);
      case "watch-app":
        return await watchAppCommand(argv);
      case "gui":
        return await guiCommand(argv);
      case "inspect-command":
        return await inspectCommand(argv);
      case "doctor":
        return await doctorCommand(argv);
      case "help":
      case "--help":
      case "-h":
      case undefined:
        printHelp();
        return 0;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function initCommand(argv: string[]): Promise<number> {
  const configPath = takeOption(argv, "--config") ?? path.resolve(process.cwd(), "codex-guard.json");
  const force = takeFlag(argv, "--force");
  await writeDefaultConfig(configPath, force);
  console.log(`Created ${path.resolve(configPath)}`);
  return 0;
}

async function runCommand(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  const guardArgs = separator >= 0 ? argv.slice(0, separator) : [];
  const codexArgs = separator >= 0 ? argv.slice(separator + 1) : argv;
  const configPath = takeOption(guardArgs, "--config");
  const mode = parseMode(takeOption(guardArgs, "--mode"));
  const cwd = path.resolve(takeOption(guardArgs, "--cwd") ?? process.cwd());
  const executable = takeOption(guardArgs, "--exec");
  const extraAllow = takeRepeatedOption(guardArgs, "--allow");
  const config = await loadConfig(configPath, cwd);
  const logger = await createSessionLogger(config, "codex-cli", cwd);
  const promptText = extractPromptText(codexArgs);
  const policyContext = buildPolicyContext(config, { cwd, mode, promptText, extraAllow });

  await logger.record({
    type: "guard.scope",
    source: "codex-guard",
    message: "Computed dynamic allowed roots for this run.",
    data: { cwd, allowedRoots: policyContext.allowedRoots, deniedRoots: policyContext.deniedRoots, mode: policyContext.mode }
  });

  const exitCode = await runCodexUnderGuard(config, { args: codexArgs, cwd, executable, logger, policyContext });
  console.log(`codex-guard log: ${logger.sessionDir}`);
  return exitCode;
}

async function proxyCommand(argv: string[]): Promise<number> {
  const configPath = takeOption(argv, "--config");
  const mode = parseMode(takeOption(argv, "--mode"));
  const target = takeOption(argv, "--target");
  const host = takeOption(argv, "--host");
  const portRaw = takeOption(argv, "--port");
  const extraAllow = takeRepeatedOption(argv, "--allow");
  const config = await loadConfig(configPath);
  const logger = await createSessionLogger(config, "model-proxy");
  const policyContext = buildPolicyContext(config, { mode, extraAllow });
  await startOpenAIProxy({ config, logger, policyContext, upstreamBaseUrl: target, host, port: portRaw ? Number(portRaw) : undefined });
  console.log(`codex-guard log: ${logger.sessionDir}`);
  return 0;
}

async function watchAppCommand(argv: string[]): Promise<number> {
  const configPath = takeOption(argv, "--config");
  const mode = parseMode(takeOption(argv, "--mode"));
  const extraAllow = takeRepeatedOption(argv, "--allow");
  const processNames = takeRepeatedOption(argv, "--process-name");
  const intervalRaw = takeOption(argv, "--interval-ms");
  const killOnBlock = takeFlag(argv, "--kill-on-block");
  const config = await loadConfig(configPath);
  const logger = await createSessionLogger(config, "app-watch");
  const policyContext = buildPolicyContext(config, { mode, extraAllow });
  const watcher = await startProcessWatcher({
    logger,
    policyContext,
    processNames: processNames.length > 0 ? processNames : config.appWatcher.processNames,
    intervalMs: intervalRaw ? Number(intervalRaw) : config.appWatcher.pollIntervalMs,
    killOnBlock: killOnBlock || config.appWatcher.killOnBlock
  });

  console.log(`watching Codex app processes; log: ${logger.sessionDir}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  watcher.stop();
  return 0;
}

async function guiCommand(argv: string[]): Promise<number> {
  const configPath = takeOption(argv, "--config");
  const host = takeOption(argv, "--host") ?? "127.0.0.1";
  const port = Number(takeOption(argv, "--port") ?? 8790);
  const cwd = path.resolve(takeOption(argv, "--cwd") ?? process.cwd());
  const noOpen = takeFlag(argv, "--no-open");
  await startGuiServer({ host, port, cwd, configPath, openBrowser: !noOpen });
  return 0;
}

async function inspectCommand(argv: string[]): Promise<number> {
  const configPath = takeOption(argv, "--config");
  const mode = parseMode(takeOption(argv, "--mode"));
  const cwd = path.resolve(takeOption(argv, "--cwd") ?? process.cwd());
  const extraAllow = takeRepeatedOption(argv, "--allow");
  const command = argv.join(" ");
  if (!command) {
    throw new Error("inspect-command requires a command string.");
  }
  const config = await loadConfig(configPath, cwd);
  const policyContext = buildPolicyContext(config, { cwd, mode, extraAllow });
  const decision = evaluateCommand(command, policyContext);
  console.log(JSON.stringify({ ...decision, message: decisionMessage(decision) }, null, 2));
  return decision.action === "block" ? 3 : 0;
}

async function doctorCommand(argv: string[]): Promise<number> {
  const configPath = takeOption(argv, "--config");
  const resolved = resolveConfigPath(configPath);
  const config = await loadConfig(configPath);
  console.log(JSON.stringify({
    node: process.version,
    platform: process.platform,
    configPath: resolved,
    mode: config.mode,
    logRoot: path.resolve(config.logRoot),
    appProcessNames: config.appWatcher.processNames,
    proxy: `${config.modelProxy.listenHost}:${config.modelProxy.port}`
  }, null, 2));
  return 0;
}

function extractPromptText(args: string[]): string {
  const promptParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (["-p", "--prompt", "--ask"].includes(value) && args[index + 1]) {
      promptParts.push(args[index + 1]);
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) {
      promptParts.push(value);
    }
  }
  return promptParts.join(" ");
}

function parseMode(value?: string): GuardMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value !== "audit" && value !== "block") {
    throw new Error("--mode must be audit or block.");
  }
  return value;
}

function takeOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  argv.splice(index, 2);
  return value;
}

function takeRepeatedOption(argv: string[], name: string): string[] {
  const values: string[] = [];
  while (true) {
    const value = takeOption(argv, name);
    if (!value) {
      return values;
    }
    values.push(value);
  }
}

function takeFlag(argv: string[], name: string): boolean {
  const index = argv.indexOf(name);
  if (index === -1) {
    return false;
  }
  argv.splice(index, 1);
  return true;
}

function printHelp(): void {
  console.log(`codex-guard

Commands:
  gui [--config path] [--host 127.0.0.1] [--port 8790] [--no-open]
  init [--config path] [--force]
  run [--config path] [--mode audit|block] [--cwd path] [--allow path] [--exec codex] -- <codex args>
  proxy [--config path] [--mode audit|block] [--target https://api.example.com] [--host 127.0.0.1] [--port 8787]
  watch-app [--config path] [--mode audit|block] [--process-name name] [--kill-on-block]
  inspect-command [--config path] [--mode audit|block] [--cwd path] [--allow path] <command>
  doctor [--config path]
`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
