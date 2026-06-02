import { spawn } from "node:child_process";
import type { GuardConfig, PolicyContext, SessionLogger } from "../types.js";
import { extractCommandsFromText } from "../parsers/command.js";
import { decisionMessage, evaluateCommand } from "../policy/engine.js";
import { startProcessWatcher, type ProcessWatcherHandle } from "./appProcessWatcher.js";

export interface RunCodexOptions {
  args: string[];
  cwd: string;
  executable?: string;
  logger: SessionLogger;
  policyContext: PolicyContext;
}

export async function runCodexUnderGuard(config: GuardConfig, options: RunCodexOptions): Promise<number> {
  const executable = options.executable ?? config.codexCli.executable;
  const child = spawn(executable, options.args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false
  });

  await options.logger.record({
    type: "codex.start",
    source: "codex-cli",
    message: `Started ${executable} ${options.args.join(" ")}`,
    data: { executable, args: options.args, pid: child.pid }
  });

  let processWatcher: ProcessWatcherHandle | undefined;
  if (config.codexCli.watchProcessTree && child.pid) {
    processWatcher = await startProcessWatcher({
      logger: options.logger,
      policyContext: options.policyContext,
      rootPid: child.pid,
      intervalMs: 500,
      killOnBlock: true
    });
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    void handleStreamChunk("stdout", chunk, config.codexCli.captureStdout, options);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    void handleStreamChunk("stderr", chunk, config.codexCli.captureStderr, options);
  });

  return new Promise((resolve) => {
    child.on("error", async (error) => {
      processWatcher?.stop();
      await options.logger.record({
        type: "codex.error",
        source: "codex-cli",
        severity: "high",
        message: error.message,
        data: { executable, args: options.args }
      });
      resolve(127);
    });

    child.on("close", async (code, signal) => {
      processWatcher?.stop();
      await options.logger.record({
        type: "codex.exit",
        source: "codex-cli",
        message: `Codex exited with ${code ?? signal ?? "unknown"}.`,
        data: { code, signal }
      });
      resolve(code ?? 1);
    });
  });
}

async function handleStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: Buffer,
  shouldCapture: boolean,
  options: RunCodexOptions
): Promise<void> {
  if (shouldCapture) {
    await options.logger.appendRaw(`${streamName}.log`, chunk);
  }

  const text = chunk.toString("utf8");
  for (const command of extractCommandsFromText(text)) {
    const decision = evaluateCommand(command, options.policyContext);
    await options.logger.record({
      type: "model.command",
      source: `codex-cli:${streamName}`,
      severity: decision.severity,
      message: decisionMessage(decision),
      data: { command, action: decision.action, reasons: decision.reasons, matchedPaths: decision.matchedPaths }
    });
  }
}
