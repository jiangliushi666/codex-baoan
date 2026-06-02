# Codex 保安

Codex 保安 is an external monitoring layer for Codex CLI and Codex app sessions. It is designed for cases where users route Codex through an unknown OpenAI-compatible model gateway and want visible audit logs plus optional blocking for high-risk behavior.

The first version focuses on a clean local GUI first, with CLI commands kept as the engine underneath:

- `Install-Codex-Baoan.cmd` installs the app, builds it, creates shortcuts, and launches the GUI on Windows.
- `Start-Codex-Baoan.cmd` opens the GUI on Windows.
- `npm start` or `codex-guard gui` opens the local control console in a browser.
- The GUI has a ccswitch-style layout: one main protection row, one-click enable/disable, compact status rows, hidden advanced settings, and visible logs.

The underlying guard paths are:

- `codex-guard run -- <codex args>` wraps Codex CLI, captures stdout/stderr, parses model-emitted command JSON, and watches child process command lines.
- `codex-guard proxy --target <upstream-base-url>` runs an OpenAI-compatible HTTP proxy that records model requests, full captured model responses, and command-like tool calls in streamed responses.
- `codex-guard watch-app` watches Codex app related processes and logs command lines from the app process tree.

## One-Click Install

For normal Windows users, download `Install-Codex-Baoan.cmd` from this repository and double-click it. The installer will:

- install Node.js with `winget` when Node is missing,
- download the latest source from GitHub,
- install dependencies and build the app,
- create Desktop and Start Menu shortcuts,
- launch Codex 保安.

Power users can run the same installer directly:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## Start The GUI

For normal users on Windows, double-click:

```text
Start-Codex-Baoan.cmd
```

For terminal users:

```powershell
npm install
npm run build
npm link
npm start
```

The GUI opens at `http://127.0.0.1:8790` by default.

## Codex App Setup

1. Open the GUI.
2. Click `一键开启`.
3. Copy the displayed local Base URL, usually `http://127.0.0.1:8787`.
4. Paste it into Codex App as the OpenAI-compatible base URL.
5. Use the settings button only when changing the upstream relay, mode, port, or extra allowed folders.

Keep the GUI open while Codex App is running. Recent alerts and session logs appear inside the GUI.

## CLI Usage

Create a local config in a project:

```powershell
codex-guard init
```

Audit a Codex CLI run:

```powershell
codex-guard run -- codex "only edit ./src and do not read other folders"
```

Block configured critical behavior:

```powershell
codex-guard run --mode block -- codex "only work in ./src"
```

Inspect one command without launching Codex:

```powershell
codex-guard inspect-command --mode block "Get-Content C:/Users/j/.ssh/id_rsa"
```

Monitor Codex app model traffic by pointing the app or gateway base URL at the local proxy:

```powershell
codex-guard proxy --mode block --target https://api.openai.com
```

Then configure the Codex app or model gateway base URL to:

```text
http://127.0.0.1:8787
```

## Logs

Each session writes clear, reviewable files under `.codex-guard/sessions/<session-id>/`:

- `summary.md`: human-readable event timeline.
- `alerts.md`: high and critical findings.
- `events.ndjson`: structured event log for integrations.
- `stdout.log` and `stderr.log`: Codex CLI streams when captured.
- `model-response.log`: captured upstream model responses from the proxy.

## Scope Model

The policy engine does not hard-code one safe directory. It builds scope from:

- the current working directory,
- `scope.defaultRoots` and `scope.extraAllow` in config,
- `--allow <path>` flags,
- explicit path-like text in the user's prompt, such as `./src`, `F:/repo/docs`, or `../shared`.

Commands touching paths outside that scope are logged as medium, high, or critical depending on operation type and path sensitivity. Credential paths such as `.ssh`, `.aws`, `.codex`, `.env`, and private key names are always critical.

## Current Limits

Codex 保安 can reliably block before execution when it is in the execution path, such as the CLI wrapper or model proxy. Pure process watching can detect and optionally kill a process after it appears, but it cannot guarantee pre-execution blocking for a closed Codex app without a native hook or OS-level sandbox driver.

This is why the app path should combine model proxy capture with process watching until Codex app exposes a first-class plugin hook for tool calls.

## Open Source

This project is released under the MIT License.
