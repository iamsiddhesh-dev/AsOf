import fs from "node:fs";
import path from "node:path";

const DOT_ENV_PATH = path.resolve(process.cwd(), ".env");

let loaded: string[] = [];

/**
 * Minimal `.env` reader.
 *
 * The server has to boot from a plain `npm run dev` on Windows, so reading the
 * file belongs in the process rather than in a shell wrapper or an npm script.
 *
 * A real environment variable always wins over the file: `LLM_MODEL=x npm run
 * dev` must beat a stale line in `.env`, and CI must never be pointed at a
 * developer's laptop database.
 *
 * Deliberately simple: one KEY=value per line, `#` comments on their own line.
 * Quotes around the value are stripped. Values containing `#` are kept whole,
 * so keys and URLs are safe.
 */
export function loadDotEnv(file = DOT_ENV_PATH): string[] {
  if (!fs.existsSync(file)) {
    loaded = [];
    return loaded;
  }

  const keys: string[] = [];

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = trimmed.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) {
      value = value.slice(1, -1);
    }

    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
    keys.push(key);
  }

  loaded = keys;
  return keys;
}

/** Keys this process took from `.env`, for diagnostics. Never values. */
export function loadedEnvKeys(): readonly string[] {
  return loaded;
}

export function dotEnvPath(): string {
  return DOT_ENV_PATH;
}

export function dotEnvExists(): boolean {
  return fs.existsSync(DOT_ENV_PATH);
}
