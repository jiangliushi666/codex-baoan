import { homedir } from "node:os";
import path from "node:path";

const PROMPT_PATH_RE = /(?:^|[\s:：,，])([A-Za-z]:[\\/][^\s"'`]+|~[\\/][^\s"'`]+|\.\.?[\\/][^\s"'`]+|[\w.-]+[\\/][\w.\\/-]+)/g;

export function normalizeRoot(root: string, cwd = process.cwd()): string {
  return path.resolve(cwd, expandPath(root));
}

export function deriveAllowedRootsFromPrompt(prompt: string, cwd = process.cwd()): string[] {
  const roots = new Set<string>();
  for (const token of extractPathLikeTokens(prompt)) {
    roots.add(resolveCandidatePath(token, cwd));
  }
  return [...roots];
}

export function extractPathLikeTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const token of tokenize(text)) {
    const cleaned = cleanToken(token);
    if (looksPathLike(cleaned)) {
      tokens.add(cleaned);
    }
  }

  for (const match of text.matchAll(PROMPT_PATH_RE)) {
    const cleaned = cleanToken(match[1] ?? "");
    if (looksPathLike(cleaned)) {
      tokens.add(cleaned);
    }
  }

  return [...tokens];
}

export function resolveCandidatePath(candidate: string, cwd = process.cwd()): string {
  const expanded = stripGlob(expandPath(cleanToken(candidate)));
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

export function isInsideAny(candidate: string, roots: string[]): boolean {
  return roots.some((root) => isSubpath(candidate, root));
}

export function isSubpath(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "") {
    return true;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"' || char === "`") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function expandPath(value: string): string {
  let expanded = value.replace(/^~(?=$|[\\/])/, homedir());
  expanded = expanded.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);
  expanded = expanded.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => process.env[name] ?? `$env:${name}`);
  expanded = expanded.replace(/\$(HOME|USERPROFILE)(?=$|[\\/])/g, () => homedir());
  return expanded;
}

function looksPathLike(value: string): boolean {
  if (!value || value.length < 2) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || /^~[\\/]/.test(value) || /^\.\.?[\\/]/.test(value)) {
    return true;
  }
  return /[\\/]/.test(value) && !/^https?:\/\//i.test(value);
}

function cleanToken(token: string): string {
  return token.trim().replace(/^["'`]+|["'`,;]+$/g, "").replace(/[)]$/g, "");
}

function stripGlob(value: string): string {
  const globIndex = value.search(/[*?[{]/);
  if (globIndex === -1) {
    return value;
  }
  const prefix = value.slice(0, globIndex);
  const separator = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  return separator >= 0 ? prefix.slice(0, separator) : ".";
}
