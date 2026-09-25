import type { PrayerKey } from './core/types.js';

/**
 * Prayer Times global configuration.
 *
 * Everything tunable lives here. Only the Google credentials and the calendar id live in .env.
 * Rebuild (`npm run build`) after changing anything.
 */
export const CONFIG = {
  /** Wall clock used for "today", midnight scheduling, event display and log stamps. */
  timezone: 'Asia/Beirut',

  source: {
    /** Al-Manar's monthly calendar PDFs. {year} is four digits, {month} has no leading zero. */
    urlTemplate: 'https://almanar.com.lb/static/calendars/{year}/beirut-{month}.pdf',
    /** Degrees east. Solar noon at this longitude reveals which UTC offset the calendar used
     *  on each day (see resolveDays in core/prayers.ts). */
    longitude: 35.5018,
    /** Shown in logs and event descriptions. */
    label: 'Beirut',
  },

  sync: {
    /** Days kept in sync, starting today. */
    windowDays: 60,
    /** After a successful run the next one is due this many days later, at local midnight. */
    rescheduleDays: 30,
    /** A failed run is retried once, this many minutes later. If that fails too, the next
     *  try is the following local midnight. */
    retryMinutes: 5,
  },

  events: {
    /** One event per listed prayer per day. Any column of the calendar can be added:
     *  imsak, fajr, sunrise, dhuhr, asr, maghrib, isha, midnight. */
    prayers: [
      { key: 'fajr', title: 'Sobh prayer time', arabic: 'صلاة الصبح' },
      { key: 'dhuhr', title: 'Zuhr prayer time', arabic: 'صلاة الظهر' },
      { key: 'maghrib', title: 'Maghrib prayer time', arabic: 'صلاة المغرب' },
    ] as { key: PrayerKey; title: string; arabic: string }[],
    durationMinutes: 15,
    /** Popup reminder this many minutes before each event. */
    reminderMinutes: 5,
    /** Name of the Google calendar `npm run auth` creates. */
    calendarName: 'Prayer Times',
    /** Stamped on every event this tool creates, so it only ever touches its own events. */
    appTag: 'prayer-times',
  },

  logs: {
    dir: 'logs',
    /** Log files older than this are deleted at the end of every run. Runs are monthly,
     *  so this keeps roughly a year of history. */
    retentionDays: 400,
    /** 'debug' also logs every unchanged event. */
    level: 'info' as 'debug' | 'info' | 'warn' | 'error',
    /** Also print to stdout. Cron pipes this to journald. */
    alsoConsole: true,
  },

  http: {
    timeoutMs: 20000,
    retries: 2,
    retryDelayMs: 2000,
    userAgent: 'Mozilla/5.0 (compatible; PrayerTimesSync/1.0)',
  },

  /** Paths, relative to the project root. */
  paths: {
    state: 'state.json',
    lock: '.run.lock',
  },
};

export type Config = typeof CONFIG;
