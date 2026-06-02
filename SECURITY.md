# Security Policy

Codex 保安 is an audit and guardrail tool. It does not replace OS sandboxing, least-privilege accounts, or careful model gateway selection.

Please report security issues privately through GitHub security advisories after the repository is published.

Known first-version limits:

- Process watching can detect and optionally kill suspicious processes, but it cannot guarantee pre-execution blocking for a closed-source GUI app.
- Model response blocking is strongest when Codex App traffic is routed through the local proxy.
- Full model response capture can contain sensitive prompt or code data. Keep logs local unless intentionally sharing them.
