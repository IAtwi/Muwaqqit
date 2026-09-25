import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { CONFIG } from '../config.js';
import type { State } from './types.js';

export function loadState(): State {
  const path = CONFIG.paths.state;
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as State) : {};
  } catch {
    // A corrupt schedule is a stop condition, not something to paper over.
    throw new Error(`${path} is not valid JSON. Fix it, or delete it to make the next run happen immediately.`);
  }
}

/** Atomic: write a temp file then rename, so a crash mid-write cannot corrupt state. */
export function saveState(state: State): void {
  const path = CONFIG.paths.state;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One run at a time, across cron and manual runs alike. A run can legitimately last a few
 * minutes (the retry waits 5), so an overlapping start just steps aside. A lock left behind
 * by a killed process is detected by its pid and taken over.
 */
export function acquireLock(): boolean {
  const path = CONFIG.paths.lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder = '';
      try {
        holder = readFileSync(path, 'utf8');
      } catch {
        continue; // released between our write and read
      }
      const [pidText, since] = holder.trim().split(' ');
      const stale = !isAlive(Number(pidText)) || Date.now() - Date.parse(since ?? '') > 3 * 3_600_000;
      if (!stale) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

export function releaseLock(): void {
  try {
    rmSync(CONFIG.paths.lock, { force: true });
  } catch {
    /* ignore */
  }
}
