# Security Policy

Codex 保安 is a local audit and risk-notification tool. It does not replace OS sandboxing, least-privilege accounts, or careful model gateway selection.

Please report security issues privately through GitHub security advisories after the repository is published.

Current limits:

- The current release records and classifies observed Codex activity after it appears in local session logs; it does not guarantee pre-execution blocking.
- Process watching, suspicious process termination, local proxy routing, and model response blocking are roadmap items and are not implemented in the current release.
- Commands are redacted before being stored or displayed, but local audit data can still contain sensitive paths, prompts, or code context. Keep logs local unless intentionally sharing them.
