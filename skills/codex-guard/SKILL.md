---
name: codex-guard
description: Monitor Codex CLI or Codex app sessions with Codex 保安, including command-risk logging, dynamic workspace scope, optional blocking, and OpenAI-compatible model proxy capture.
---

# Codex 保安

Use this skill when a user wants a guarded Codex session, visible audit logs, or monitoring around an untrusted OpenAI-compatible model proxy.

## Workflow

1. Prefer the GUI for normal users: run `codex-guard gui`, double-click `Start-Codex-Baoan.cmd`, or install with `Install-Codex-Baoan.cmd` on Windows.
2. In the ccswitch-style GUI, pick the recommended auto-discovered provider row or click the orange one-click button. Manual Base URL and API key fields are only fallback controls.
3. Start App monitoring from the GUI when process-level command visibility is needed.
4. For Codex CLI, run `codex-guard run -- <codex args>` so Codex 保安 can capture stdout, stderr, model-emitted command JSON, and child process command lines.
5. Review logs in the GUI or in `.codex-guard/sessions/<session>/summary.md`, `alerts.md`, `events.ndjson`, and captured response logs.

## Policy Notes

- The allowed filesystem scope starts with the working directory and is expanded from explicit paths in the user's prompt or `--allow` flags.
- Use `--mode block` and configure `risk.blockLevels` when the user wants enforcement instead of audit-only logging.
- Codex app pre-execution blocking is limited unless the app is routed through the model proxy or exposes a native hook point.
