import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

/** Minimal .env reader so cron can run `node dist/main.js` with no extra flags. */
export function loadEnv(file = '.env'): void {
  if (loaded) return;
  loaded = true;
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    // Real environment variables win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(key: string): string {
  loadEnv();
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing ${key}. Copy .env.example to .env and fill it in (see README.md).`);
  }
  return value;
}
