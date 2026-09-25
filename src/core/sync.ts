import { CONFIG } from '../config.js';
import { requireEnv } from './env.js';
import { desiredEvent, differences, eventKey, patchBody } from './events.js';
import { deleteEvent, getCalendar, insertEvent, listAppEvents, patchEvent, type ApiEvent } from './google.js';
import { message } from './http.js';
import type { Logger } from './logger.js';
import { resolveDays, type Resolution } from './prayers.js';
import { loadMonths, monthsOf } from './source.js';
import { addDays, localClock, localMidnight, monthLabel, parseDate } from './time.js';
import { PRAYER_NAMES, type CalendarRow, type PrayerKey, type SyncStats } from './types.js';

export interface WindowTimes {
  dates: string[];
  resolution: Resolution;
  /** First month that could not be loaded, and why. Days from it onwards cannot be synced. */
  failedMonth?: { year: number; month: number; error: string };
}

/**
 * Downloads and resolves the calendar for `days` days from `firstDate`. Shared by the sync,
 * `--times` and `--check`, so all three see exactly the same values.
 */
export async function loadWindow(firstDate: string, days: number, log?: Logger): Promise<WindowTimes> {
  const dates = Array.from({ length: days }, (_, i) => addDays(firstDate, i));
  const loads = await loadMonths(monthsOf(firstDate, days));

  const rows: CalendarRow[] = [];
  let failedMonth: WindowTimes['failedMonth'];
  for (const load of loads) {
    if (load.rows) {
      rows.push(...load.rows);
      log?.info(`calendar ${monthLabel(load.year, load.month)}: ok, ${load.rows.length} days`);
    } else {
      failedMonth = { year: load.year, month: load.month, error: load.error ?? 'unknown error' };
      log?.error(`calendar ${monthLabel(load.year, load.month)}: ${failedMonth.error}`);
    }
  }

  const keys = CONFIG.events.prayers.map((p) => p.key);
  const resolution = resolveDays(rows, keys);
  for (const notice of resolution.notices) log?.warn(notice);
  return { dates, resolution, ...(failedMonth ? { failedMonth } : {}) };
}

function emptyStats(windowDays: number): SyncStats {
  return { windowDays, daysSynced: 0, created: 0, updated: 0, unchanged: 0, removed: 0 };
}

/**
 * Brings the window [today, today + windowDays) in line with the calendar, day by day,
 * stopping at the first day that fails. Returns counts for the summary.
 */
export async function syncWindow(today: string, log: Logger, dryRun: boolean): Promise<SyncStats> {
  const stats = emptyStats(CONFIG.sync.windowDays);
  const window = await loadWindow(today, CONFIG.sync.windowDays, log);
  const { dates, resolution, failedMonth } = window;

  /** Why a day cannot be synced this run, if it cannot. */
  const blocker = (date: string): string | undefined => {
    const { year, month } = parseDate(date);
    if (failedMonth && (year > failedMonth.year || (year === failedMonth.year && month >= failedMonth.month))) {
      return failedMonth.error;
    }
    if (resolution.errors.has(date)) return resolution.errors.get(date);
    if (!resolution.days.has(date)) return `no times resolved for ${date}`;
    return undefined;
  };

  // Nothing to do with Google if not even the first day has times.
  const firstBlocker = blocker(today);
  if (firstBlocker) {
    stats.stoppedAt = today;
    stats.error = firstBlocker;
    return stats;
  }

  const calendarId = requireEnv('GOOGLE_CALENDAR_ID');
  const calendar = await getCalendar(calendarId);
  if (!calendar) {
    throw new Error(
      `calendar ${calendarId} was not found. It may have been deleted, or it was not created by this app. ` +
        'Remove GOOGLE_CALENDAR_ID from .env and run `npm run auth` to create a new one.',
    );
  }
  log.info(`google calendar "${calendar.summary ?? calendarId}": ok`);

  // Everything this app owns from the day before the window on, grouped by date and prayer.
  const since = addDays(today, -1);
  const existing = await listAppEvents(calendarId, localMidnight(since));
  const byKey = new Map<string, ApiEvent[]>();
  const byDate = new Map<string, ApiEvent[]>();
  for (const event of existing) {
    const props = event.extendedProperties?.private ?? {};
    if (!props.date || !props.prayer) continue;
    const key = eventKey(props.date, props.prayer);
    byKey.set(key, [...(byKey.get(key) ?? []), event]);
    byDate.set(props.date, [...(byDate.get(props.date) ?? []), event]);
  }
  log.info(`found ${existing.length} existing event(s) from ${since} on`);

  const wanted = new Set<string>(CONFIG.events.prayers.map((p) => p.key));

  for (const date of dates) {
    const blocked = blocker(date);
    const prayers = resolution.days.get(date);
    if (blocked || !prayers) {
      stats.stoppedAt = date;
      stats.error = blocked ?? `no times resolved for ${date}`;
      break;
    }

    const changes: DayChanges = { created: [], updated: [], removed: [] };
    try {
      for (const prayer of prayers) {
        const name = PRAYER_NAMES[prayer.prayer];
        const desired = desiredEvent(prayer);
        const [keep, ...extra] = byKey.get(eventKey(date, prayer.prayer)) ?? [];
        const mark = prayer.note ? '*' : '';

        for (const duplicate of extra) {
          if (!dryRun) await deleteEvent(calendarId, duplicate.id);
          stats.removed++;
          changes.removed.push(`a duplicate ${name}`);
        }

        if (!keep) {
          if (!dryRun) await insertEvent(calendarId, desired);
          stats.created++;
          changes.created.push(`${name} ${localClock(prayer.at)}${mark}`);
          continue;
        }

        const diff = differences(keep, desired);
        if (diff.length === 0) {
          stats.unchanged++;
          continue;
        }
        if (!dryRun) await patchEvent(calendarId, keep.id, patchBody(desired));
        stats.updated++;
        changes.updated.push(`${name}${mark} (${diff.map((d) => d.text).join(', ')})`);
      }

      // Events for prayers no longer configured (the prayer list was edited).
      for (const event of byDate.get(date) ?? []) {
        const prayer = event.extendedProperties?.private?.prayer ?? '';
        if (wanted.has(prayer)) continue;
        if (!dryRun) await deleteEvent(calendarId, event.id);
        stats.removed++;
        changes.removed.push(`${PRAYER_NAMES[prayer as PrayerKey] ?? prayer} (no longer configured)`);
      }
    } catch (err) {
      stats.stoppedAt = date;
      stats.error = message(err);
      logDay(log, date, changes, dryRun);
      break;
    }

    stats.daysSynced++;
    if (!logDay(log, date, changes, dryRun)) log.debug(`${date}  unchanged`);
  }

  return stats;
}

/** What changed on one day. A '*' on an entry marks a time that differs from the printed calendar. */
interface DayChanges {
  created: string[];
  updated: string[];
  removed: string[];
}

/**
 * One line per day that changed, e.g.
 * "2026-10-28  created Sobh 04:39, Zuhr 11:22, Maghrib 17:09* (* corrected, see the event's note)".
 * Returns false when there was nothing to report.
 */
function logDay(log: Logger, date: string, c: DayChanges, dryRun: boolean): boolean {
  const verb = (past: string, present: string) => (dryRun ? `would ${present}` : past);
  const parts = [
    c.created.length ? `${verb('created', 'create')} ${c.created.join(', ')}` : '',
    c.updated.length ? `${verb('updated', 'update')} ${c.updated.join(', ')}` : '',
    c.removed.length ? `${verb('removed', 'remove')} ${c.removed.join(', ')}` : '',
  ].filter(Boolean);
  if (parts.length === 0) return false;
  const footnote = [...c.created, ...c.updated].some((s) => s.includes('*')) ? " (* corrected, see the event's note)" : '';
  log.info(`${date}  ${parts.join('; ')}${footnote}`);
  return true;
}
