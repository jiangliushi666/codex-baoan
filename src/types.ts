export type GuardMode = "audit" | "block";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type PolicyAction = "allow" | "block";

export interface GuardConfig {
  version: 1;
  mode: GuardMode;
  logRoot: string;
  scope: {
    defaultRoots: string[];
    extraAllow: string[];
    deny: string[];
  };
  risk: {
    blockLevels: Severity[];
    allowedNetworkHosts: string[];
  };
  codexCli: {
    executable: string;
    captureStdout: boolean;
    captureStderr: boolean;
    watchProcessTree: boolean;
  };
  appWatcher: {
    processNames: string[];
    pollIntervalMs: number;
    killOnBlock: boolean;
  };
  modelProxy: {
    listenHost: string;
    port: number;
    upstreamBaseUrl: string;
    captureBodies: boolean;
    maxCapturedBodyBytes: number;
  };
}

export interface PolicyReason {
  code: string;
  message: string;
  severity: Severity;
  evidence?: string;
}

export interface PolicyDecision {
  action: PolicyAction;
  severity: Severity;
  reasons: PolicyReason[];
  command: string;
  matchedPaths: string[];
}

export interface PolicyContext {
  cwd: string;
  allowedRoots: string[];
  deniedRoots: string[];
  mode: GuardMode;
  blockLevels: Severity[];
  allowedNetworkHosts: string[];
}

export interface GuardEvent {
  timestamp: string;
  sessionId: string;
  type: string;
  source: string;
  severity?: Severity;
  message: string;
  data?: Record<string, unknown>;
}

export interface SessionLogger {
  sessionId: string;
  sessionDir: string;
  record(event: Omit<GuardEvent, "timestamp" | "sessionId">): Promise<void>;
  appendRaw(fileName: string, chunk: string | Buffer): Promise<void>;
}
