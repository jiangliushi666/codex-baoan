import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PolicyContext, SessionLogger } from "../types.js";
import { decisionMessage, evaluateCommand } from "../policy/engine.js";

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

export interface ProcessWatcherOptions {
  logger: SessionLogger;
  policyContext: PolicyContext;
  rootPid?: number;
  processNames?: string[];
  intervalMs: number;
  killOnBlock: boolean;
}

export interface ProcessWatcherHandle {
  stop(): void;
}

export async function startProcessWatcher(options: ProcessWatcherOptions): Promise<ProcessWatcherHandle> {
  const seen = new Set<number>();
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let stopped = false;

  const poll = async () => {
    if (polling || stopped) {
      return;
    }
    polling = true;
    try {
      const processes = await listProcesses();
      const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
      for (const processInfo of processes) {
        if (seen.has(processInfo.pid)) {
          continue;
        }

        const watched = isWatchedProcess(processInfo, byPid, options);
        if (!watched) {
          continue;
        }

        seen.add(processInfo.pid);
        await inspectProcess(processInfo, options);
      }
    } catch (error) {
      await options.logger.record({
        type: "watcher.error",
        source: "process-watcher",
        severity: "medium",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      polling = false;
    }
  };

  await poll();
  timer = setInterval(poll, options.intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
    }
  };
}

async function inspectProcess(processInfo: ProcessInfo, options: ProcessWatcherOptions): Promise<void> {
  const command = processInfo.commandLine || processInfo.name;
  const decision = evaluateCommand(command, options.policyContext);
  await options.logger.record({
    type: "process.command",
    source: "process-watcher",
    severity: decision.severity,
    message: decisionMessage(decision),
    data: {
      pid: processInfo.pid,
      ppid: processInfo.ppid,
      name: processInfo.name,
      commandLine: command,
      action: decision.action,
      reasons: decision.reasons
    }
  });

  if (decision.action === "block" && options.killOnBlock) {
    try {
      process.kill(processInfo.pid);
      await options.logger.record({
        type: "process.killed",
        source: "process-watcher",
        severity: "high",
        message: `Killed process ${processInfo.pid} after policy block.`,
        data: { pid: processInfo.pid, commandLine: command }
      });
    } catch (error) {
      await options.logger.record({
        type: "process.kill_failed",
        source: "process-watcher",
        severity: "high",
        message: error instanceof Error ? error.message : String(error),
        data: { pid: processInfo.pid, commandLine: command }
      });
    }
  }
}

function isWatchedProcess(processInfo: ProcessInfo, byPid: Map<number, ProcessInfo>, options: ProcessWatcherOptions): boolean {
  if (options.rootPid && processInfo.pid !== options.rootPid && hasAncestor(processInfo, byPid, options.rootPid)) {
    return true;
  }

  const names = options.processNames ?? [];
  if (names.length === 0) {
    return false;
  }

  if (names.some((name) => processInfo.name.toLowerCase().includes(name.toLowerCase()))) {
    return true;
  }

  let parent = byPid.get(processInfo.ppid);
  const visited = new Set<number>();
  while (parent && !visited.has(parent.pid)) {
    const parentProcess = parent;
    visited.add(parentProcess.pid);
    if (names.some((name) => parentProcess.name.toLowerCase().includes(name.toLowerCase()))) {
      return true;
    }
    parent = byPid.get(parentProcess.ppid);
  }

  return false;
}

function hasAncestor(processInfo: ProcessInfo, byPid: Map<number, ProcessInfo>, rootPid: number): boolean {
  let parent = byPid.get(processInfo.ppid);
  const visited = new Set<number>();
  while (parent && !visited.has(parent.pid)) {
    const parentProcess = parent;
    if (parentProcess.pid === rootPid) {
      return true;
    }
    visited.add(parentProcess.pid);
    parent = byPid.get(parentProcess.ppid);
  }
  return false;
}

async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    return listWindowsProcesses();
  }
  return listUnixProcesses();
}

async function listWindowsProcesses(): Promise<ProcessInfo[]> {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], { maxBuffer: 20 * 1024 * 1024 });
  if (!stdout.trim()) {
    return [];
  }
  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>> | Record<string, unknown>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    name: String(row.Name ?? ""),
    commandLine: String(row.CommandLine ?? row.Name ?? "")
  })).filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid));
}

async function listUnixProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,comm=,args="], { maxBuffer: 20 * 1024 * 1024 });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) {
      return [];
    }
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: match[3],
      commandLine: match[4] || match[3]
    }];
  });
}
