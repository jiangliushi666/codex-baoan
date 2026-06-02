---
name: codex-guard
description: Monitor Codex CLI or Codex app sessions with the Codex 保安 desktop app, including command-risk logging, dynamic workspace scope, optional blocking, and OpenAI-compatible model proxy capture.
---

# Codex 保安

Use this skill when a user wants a guarded Codex session, visible audit logs, or monitoring around an untrusted OpenAI-compatible model proxy.

## Workflow

1. Prefer the desktop app for normal users: install with Install-Codex-Baoan.cmd on Windows, then open the Codex Baoan shortcut or Start-Codex-Baoan.vbs.
2. In the ccswitch-style desktop window, pick the recommended auto-discovered provider row or click the orange one-click button. Manual Base URL and API key fields are only fallback controls.
3. Start App monitoring from the desktop app when process-level command visibility is needed.
4. For Codex CLI, run codex-guard run -- <codex args> so Codex 保安 can capture stdout, stderr, model-emitted command JSON, and child process command lines.
5. Review logs in the desktop app or in .codex-guard/sessions/<session>/summary.md, alerts.md, events.ndjson, and captured response logs.

## Policy Notes

- The allowed filesystem scope starts with the working directory and is expanded from explicit paths in the user's prompt or --allow flags.
- Use --mode block and configure risk.blockLevels when the user wants enforcement instead of audit-only logging.
- Codex app pre-execution blocking is limited unless the app is routed through the model proxy or exposes a native hook point.
