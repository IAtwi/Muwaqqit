import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from '../config.js';
import { formatDate, localParts, pad } from './time.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

/** Log file names and line stamps use CONFIG.timezone, whatever the server clock says. */
export function dateStamp(d = new Date()): string {
  const p = localParts(d);
  return formatDate(p.year, p.month, p.day);
}

export function timeStamp(d = new Date()): string {
  const p = localParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/**
 * One file per local day under logs/, appended to by every run that day. Runs are rare
 * (monthly, plus retries), so a day's file normally holds a single run.
 */
export class Logger {
  constructor(private readonly quiet = false) {}

  private file(): string {
    mkdirSync(CONFIG.logs.dir, { recursive: true });
    // Resolved per line, so a run that crosses midnight rolls into the new day's file.
    return join(CONFIG.logs.dir, `${dateStamp()}.log`);
  }

  /** Writes a line with no level prefix, used for run headers and separators. */
  raw(text: string): void {
    this.append(text);
    if (CONFIG.logs.alsoConsole && !this.quiet) console.log(text);
  }

  debug(msg: string): void { this.write('debug', msg); }
  info(msg: string): void { this.write('info', msg); }
  warn(msg: string): void { this.write('warn', msg); }
  error(msg: string): void { this.write('error', msg); }

  private write(level: Level, msg: string): void {
    if (LEVELS[level] < LEVELS[CONFIG.logs.level]) return;
    const line = `${timeStamp()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    this.append(line);
    if (CONFIG.logs.alsoConsole && !this.quiet) console.log(line);
  }

  /** Logging must never be able to kill a run. */
  private append(line: string): void {
    try {
      appendFileSync(this.file(), `${line}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Deletes log files last modified more than CONFIG.logs.retentionDays ago.
 * Runs at the end of every run so the logs directory cannot grow without bound.
 */
export function pruneOldLogs(): number {
  const root = CONFIG.logs.dir;
  if (!existsSync(root)) return 0;

  const cutoff = Date.now() - CONFIG.logs.retentionDays * 86_400_000;
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.log')) continue;
    const full = join(root, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full);
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
