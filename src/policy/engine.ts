import path from "node:path";
import type { PolicyContext, PolicyDecision, PolicyReason, Severity } from "../types.js";
import { extractPathLikeTokens, isInsideAny, isSubpath, resolveCandidatePath } from "./pathScope.js";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const READ_RE = /\b(Get-Content|gc|cat|type|more|less|Get-ChildItem|gci|ls|dir|rg|grep|findstr|Select-String|open|readFileSync)\b/i;
const WRITE_RE = /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|cp|mv|writeFileSync|appendFileSync)\b/i;
const DESTRUCTIVE_RE = /\b(Remove-Item|rm|del|erase|rmdir|rd|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|format|cipher\s+\/w)\b/i;
const NETWORK_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|scp|sftp|ftp|nc|ncat)\b/i;
const PRIVILEGE_RE = /\b(Set-ExecutionPolicy|Start-Process\s+.*-Verb\s+RunAs|schtasks|reg\s+add|netsh|New-ItemProperty)\b/i;
const SHELL_DOWNLOAD_EXEC_RE = /(curl|wget|iwr|irm).*(\||;|&&).*\b(sh|bash|powershell|pwsh|cmd|python|node)\b/i;
const CREDENTIAL_PATH_RE = /([\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|[\\/]\.azure[\\/]|[\\/]\.gnupg[\\/]|[\\/]\.codex[\\/]|[\\/]\.openai[\\/]|[\\/]AppData[\\/]Roaming[\\/](npm|Code|Cursor)[\\/]|\.env\b|id_rsa|id_ed25519|credentials|known_hosts)/i;

export function evaluateCommand(command: string, context: PolicyContext): PolicyDecision {
  const reasons: PolicyReason[] = [];
  const matchedPaths = extractPathLikeTokens(command).map((token) => resolveCandidatePath(token, context.cwd));
  const isRead = READ_RE.test(command);
  const isWrite = WRITE_RE.test(command);
  const isDestructive = DESTRUCTIVE_RE.test(command);
  const isNetwork = NETWORK_RE.test(command);

  for (const deniedRoot of context.deniedRoots) {
    for (const candidate of matchedPaths) {
      if (isSubpath(candidate, deniedRoot)) {
        reasons.push({
          code: "denied-root",
          message: "Command touches an explicitly denied path.",
          severity: "critical",
          evidence: candidate
        });
      }
    }
  }

  for (const candidate of matchedPaths) {
    if (CREDENTIAL_PATH_RE.test(candidate)) {
      reasons.push({
        code: "credential-path",
        message: "Command references a credential or agent configuration path.",
        severity: "critical",
        evidence: candidate
      });
    }

    if (!isInsideAny(candidate, context.allowedRoots)) {
      const severity: Severity = isDestructive ? "critical" : isRead || isWrite ? "high" : "medium";
      reasons.push({
        code: "outside-scope-path",
        message: "Command references a path outside the user-declared working scope.",
        severity,
        evidence: candidate
      });
    }
  }

  if (isDestructive) {
    reasons.push({
      code: "destructive-command",
      message: "Command can delete, reset, or irreversibly modify files.",
      severity: "high",
      evidence: command
    });
  }

  if (PRIVILEGE_RE.test(command)) {
    reasons.push({
      code: "privilege-or-persistence",
      message: "Command changes execution policy, persistence, registry, scheduled tasks, or networking policy.",
      severity: "critical",
      evidence: command
    });
  }

  if (SHELL_DOWNLOAD_EXEC_RE.test(command)) {
    reasons.push({
      code: "download-and-execute",
      message: "Command downloads remote content and pipes it into an interpreter.",
      severity: "critical",
      evidence: command
    });
  }

  if (isNetwork) {
    const hosts = extractHosts(command);
    const unknownHosts = hosts.filter((host) => !context.allowedNetworkHosts.includes(host));
    if (unknownHosts.length > 0) {
      reasons.push({
        code: "network-egress",
        message: "Command may send data to a network host that is not allowlisted.",
        severity: matchedPaths.some((candidate) => !isInsideAny(candidate, context.allowedRoots)) ? "critical" : "medium",
        evidence: unknownHosts.join(", ")
      });
    }
  }

  const severity = highestSeverity(reasons);
  const action = context.mode === "block" && context.blockLevels.includes(severity) ? "block" : "allow";

  return {
    action,
    severity,
    reasons,
    command,
    matchedPaths: matchedPaths.map((item) => path.normalize(item))
  };
}

export function decisionMessage(decision: PolicyDecision): string {
  if (decision.reasons.length === 0) {
    return "Command is within current policy.";
  }
  return decision.reasons.map((reason) => `${reason.code}: ${reason.message}`).join("; ");
}

function highestSeverity(reasons: PolicyReason[]): Severity {
  let highest: Severity = "info";
  for (const reason of reasons) {
    if (SEVERITY_RANK[reason.severity] > SEVERITY_RANK[highest]) {
      highest = reason.severity;
    }
  }
  return highest;
}

function extractHosts(command: string): string[] {
  const hosts = new Set<string>();
  for (const match of command.matchAll(/https?:\/\/([^\s"'`/]+)/gi)) {
    hosts.add(match[1].toLowerCase());
  }
  return [...hosts];
}
