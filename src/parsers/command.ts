export function extractCommandsFromText(text: string): string[] {
  const commands = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = stripSsePrefix(line.trim());
    if (!trimmed) {
      continue;
    }

    parseJsonCandidate(trimmed, commands);
    collectRegexCommands(trimmed, commands);
  }

  return [...commands];
}

function parseJsonCandidate(value: string, commands: Set<string>): void {
  if (!value.startsWith("{") && !value.startsWith("[")) {
    return;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    collectCommands(parsed, commands);
  } catch {
    // Streaming chunks are often partial JSON. Regex scanning below still catches common command text.
  }
}

function collectCommands(value: unknown, commands: Set<string>, keyPath: string[] = []): void {
  if (typeof value === "string") {
    const lastKey = keyPath[keyPath.length - 1]?.toLowerCase() ?? "";
    if (["command", "cmd", "shell", "shell_command"].includes(lastKey) && value.length <= 4096) {
      commands.add(value);
      return;
    }
    if (lastKey === "arguments") {
      parseJsonCandidate(value, commands);
    }
    collectRegexCommands(value, commands);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCommands(item, commands, [...keyPath, String(index)]));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectCommands(nested, commands, [...keyPath, key]);
    }
  }
}

function collectRegexCommands(value: string, commands: Set<string>): void {
  const patterns = [
    /"command"\s*:\s*"((?:\\"|[^"])*)"/gi,
    /'command'\s*:\s*'((?:\\'|[^'])*)'/gi,
    /\b(?:shell_command|exec_command|cmd)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const command = unescapeCommand(match[1] ?? "").trim();
      if (command) {
        commands.add(command);
      }
    }
  }
}

function stripSsePrefix(line: string): string {
  return line.startsWith("data: ") ? line.slice(6).trim() : line;
}

function unescapeCommand(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n");
}
