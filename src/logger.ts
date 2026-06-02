import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GuardConfig, GuardEvent, SessionLogger } from "./types.js";

export async function createSessionLogger(
  config: GuardConfig,
  label: string,
  cwd = process.cwd()
): Promise<SessionLogger> {
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${sanitizeLabel(label)}`;
  const root = path.resolve(cwd, config.logRoot);
  const sessionDir = path.join(root, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const summaryPath = path.join(sessionDir, "summary.md");
  const alertsPath = path.join(sessionDir, "alerts.md");
  await writeFile(summaryPath, `# Codex 保安 Session\n\n- Session: ${sessionId}\n- Started: ${new Date().toISOString()}\n\n## Events\n`, "utf8");
  await writeFile(alertsPath, "# Alerts\n\nNo alerts recorded yet.\n", "utf8");

  return {
    sessionId,
    sessionDir,
    async record(event) {
      const fullEvent: GuardEvent = {
        timestamp: new Date().toISOString(),
        sessionId,
        ...event
      };
      await appendFile(path.join(sessionDir, "events.ndjson"), `${JSON.stringify(fullEvent)}\n`, "utf8");
      await appendFile(summaryPath, renderSummaryLine(fullEvent), "utf8");

      if (fullEvent.severity === "high" || fullEvent.severity === "critical") {
        await appendFile(alertsPath, renderAlert(fullEvent), "utf8");
      }
    },
    async appendRaw(fileName, chunk) {
      await appendFile(path.join(sessionDir, fileName), chunk);
    }
  };
}

function renderSummaryLine(event: GuardEvent): string {
  const severity = event.severity ? ` [${event.severity.toUpperCase()}]` : "";
  return `\n- ${event.timestamp} ${event.source} ${event.type}${severity}: ${event.message}`;
}

function renderAlert(event: GuardEvent): string {
  return [
    "",
    `## ${event.severity?.toUpperCase()} - ${event.type}`,
    "",
    `- Time: ${event.timestamp}`,
    `- Source: ${event.source}`,
    `- Message: ${event.message}`,
    event.data ? `- Evidence: \`${truncate(JSON.stringify(event.data), 900)}\`` : ""
  ]
    .filter(Boolean)
    .join("\n") + "\n";
}

function sanitizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "session";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}
