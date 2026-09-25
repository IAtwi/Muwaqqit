import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/**
 * Sets keys in the .env file: an existing `KEY=` line is replaced in place, a new key is
 * appended, and everything else (comments, other keys) is kept. Written atomically.
 * Used by `npm run auth`, so a refresh token never has to be copied by hand.
 */
export function saveEnv(values: Record<string, string>, file = '.env'): void {
  const path = resolve(process.cwd(), file);
  const pending = new Map(Object.entries(values));
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const out = lines.map((line) => {
    const eq = line.indexOf('=');
    const key = eq > 0 && !line.trimStart().startsWith('#') ? line.slice(0, eq).trim() : '';
    const value = pending.get(key);
    if (value === undefined) return line;
    pending.delete(key);
    return `${key}=${value}`;
  });
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${out.join('\n')}\n`, 'utf8');
  renameSync(tmp, path);
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

export function requireEnv(key: string): string {
  loadEnv();
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing ${key}. Copy .env.example to .env and fill it in (see README.md).`);
  }
  return value;
}
