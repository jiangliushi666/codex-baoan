---
name: codex-guard
description: Use Codex 保安, a Tauri desktop guard for Codex, to inspect risky commands, review auto-discovered providers, and guide users through desktop install/update/uninstall flows.
---

# Codex 保安

Use this skill when a user wants a guarded Codex session, provider discovery, or a desktop-first safety layer around untrusted OpenAI-compatible relays.

## Workflow

1. Prefer the desktop app for normal users. Install from the latest GitHub Release and use the Tauri installer package for the operating system.
2. In the ccswitch-style window, use the recommended auto-discovered provider row or the top-right one-click protect button.
3. Use audit mode for visibility first; switch to block mode only when the user wants high-risk behavior stopped in supported guard paths.
4. Use the command-risk checker to inspect suspicious commands before execution.
5. Use the app-management drawer for install package, update check, install directory, and system uninstall entry.

## Discovery Notes

- ccswitch is searched in Roaming AppData/config paths and ~/.cc-switch/cc-switch.db.
- Codex++ is searched in ~/.codex-session-delete/settings.json and common AppData/config variants.
- Codex is searched in ~/.codex/config.toml.
- API keys are not serialized to the frontend; only masked status is shown.

## Limitations

- The current Tauri build provides provider discovery, visible guard state, command-risk inspection, and lifecycle management.
- Full model-response capture and pre-execution blocking require the upcoming CLI wrapper/proxy integration or a native Codex App hook.
