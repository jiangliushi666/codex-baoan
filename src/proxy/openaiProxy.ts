import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { GuardConfig, PolicyContext, SessionLogger } from "../types.js";
import { extractCommandsFromText } from "../parsers/command.js";
import { decisionMessage, evaluateCommand } from "../policy/engine.js";

export interface ProxyOptions {
  config: GuardConfig;
  logger: SessionLogger;
  policyContext: PolicyContext;
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  host?: string;
  port?: number;
}

export function createOpenAIProxyServer(options: ProxyOptions): http.Server {
  const upstreamBaseUrl = options.upstreamBaseUrl ?? options.config.modelProxy.upstreamBaseUrl;
  return http.createServer((request, response) => {
    void handleProxyRequest(request, response, { ...options, upstreamBaseUrl });
  });
}

export async function listenOpenAIProxyServer(server: http.Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

export async function startOpenAIProxy(options: ProxyOptions): Promise<void> {
  const host = options.host ?? options.config.modelProxy.listenHost;
  const port = options.port ?? options.config.modelProxy.port;
  const upstreamBaseUrl = options.upstreamBaseUrl ?? options.config.modelProxy.upstreamBaseUrl;
  const server = createOpenAIProxyServer({ ...options, upstreamBaseUrl });
  await listenOpenAIProxyServer(server, host, port);

  await options.logger.record({
    type: "proxy.start",
    source: "model-proxy",
    message: `Listening on http://${host}:${port} and forwarding to ${upstreamBaseUrl}.`,
    data: { host, port, upstreamBaseUrl }
  });

  console.log(`codex-guard proxy listening at http://${host}:${port}`);
  console.log(`forwarding to ${upstreamBaseUrl}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      server.close(() => resolve());
    });
    process.once("SIGTERM", () => {
      server.close(() => resolve());
    });
  });
}

async function handleProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyOptions & { upstreamBaseUrl: string }
): Promise<void> {
  const requestBody = await readRequestBody(request, options.config.modelProxy.maxCapturedBodyBytes);
  const target = new URL(request.url ?? "/", options.upstreamBaseUrl);
  const headers = forwardHeaders(request.headers, options.upstreamApiKey);

  await options.logger.record({
    type: "model.request",
    source: "model-proxy",
    message: `${request.method ?? "GET"} ${target.pathname}`,
    data: {
      method: request.method,
      url: target.toString(),
      body: options.config.modelProxy.captureBodies ? requestBody.captured : undefined,
      truncated: requestBody.truncated
    }
  });

  try {
    const outboundBody: BodyInit | undefined = requestBody.body.length > 0 && request.method !== "GET" && request.method !== "HEAD"
      ? requestBody.body.buffer.slice(requestBody.body.byteOffset, requestBody.body.byteOffset + requestBody.body.byteLength) as ArrayBuffer
      : undefined;
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: outboundBody
    });

    if (!upstream.body) {
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      response.end();
      return;
    }

    await streamAndInspect(upstream, response, options);
  } catch (error) {
    await options.logger.record({
      type: "proxy.error",
      source: "model-proxy",
      severity: "high",
      message: error instanceof Error ? error.message : String(error),
      data: { url: target.toString() }
    });
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "codex-guard proxy failed", detail: String(error) }));
  }
}

async function streamAndInspect(
  upstream: Response,
  response: ServerResponse,
  options: ProxyOptions
): Promise<void> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    response.end();
    return;
  }

  const decoder = new TextDecoder();
  const seenCommands = new Set<string>();
  let scanBuffer = "";
  let capturedBytes = 0;
  let headersSent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (!headersSent) {
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      }
      response.end();
      return;
    }

    const chunk = Buffer.from(value);
    const text = decoder.decode(chunk, { stream: true });
    if (options.config.modelProxy.captureBodies && capturedBytes < options.config.modelProxy.maxCapturedBodyBytes) {
      capturedBytes += chunk.byteLength;
      await options.logger.appendRaw("model-response.log", text);
    }

    scanBuffer = `${scanBuffer}${text}`.slice(-32768);
    const shouldBlock = await inspectModelText(scanBuffer, seenCommands, options);
    if (shouldBlock) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Blocked by codex-guard policy" }));
      await reader.cancel();
      return;
    }

    if (!headersSent) {
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      headersSent = true;
    }
    response.write(chunk);
  }
}

async function inspectModelText(text: string, seenCommands: Set<string>, options: ProxyOptions): Promise<boolean> {
  for (const command of extractCommandsFromText(text)) {
    if (seenCommands.has(command)) {
      continue;
    }
    seenCommands.add(command);
    const decision = evaluateCommand(command, options.policyContext);
    await options.logger.record({
      type: "model.command",
      source: "model-proxy",
      severity: decision.severity,
      message: decisionMessage(decision),
      data: { command, action: decision.action, reasons: decision.reasons, matchedPaths: decision.matchedPaths }
    });
    if (decision.action === "block") {
      return true;
    }
  }
  return false;
}

function forwardHeaders(headers: IncomingMessage["headers"], upstreamApiKey?: string): Headers {
  const forwarded = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (["host", "connection", "content-length"].includes(key.toLowerCase())) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        forwarded.append(key, item);
      }
    } else if (typeof value === "string") {
      forwarded.set(key, value);
    }
  }
  if (upstreamApiKey && !forwarded.has("authorization")) {
    forwarded.set("authorization", "Bearer " + upstreamApiKey);
  }
  return forwarded;
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<{ body: Buffer; captured: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    size += buffer.byteLength;
  }
  const body = Buffer.concat(chunks);
  const captured = body.subarray(0, maxBytes).toString("utf8");
  return { body, captured, truncated: size > maxBytes };
}
