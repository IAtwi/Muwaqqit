/** The eight time columns of Al-Manar's calendar. */
export type PrayerKey = 'imsak' | 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha' | 'midnight';

/** Column order on the page, left to right. The table reads right to left, so this is the
 *  reverse of the day: midnight sits on the far left, imsak next to the date. */
export const COLUMN_ORDER: readonly PrayerKey[] = [
  'midnight', 'isha', 'maghrib', 'asr', 'dhuhr', 'sunrise', 'fajr', 'imsak',
];

/** Chronological order within a day. Midnight is left out: it can fall on either side of 00:00. */
export const DAY_ORDER: readonly PrayerKey[] = ['imsak', 'fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

export const PRAYER_NAMES: Record<PrayerKey, string> = {
  imsak: 'Imsak', fajr: 'Sobh', sunrise: 'Sunrise', dhuhr: 'Zuhr',
  asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha', midnight: 'Midnight',
};

/** A clock time exactly as printed in the calendar. */
export interface Listed {
  /** Minutes after local midnight. */
  minutes: number;
  /** The printed text, e.g. "5:19". */
  text: string;
}

/** One row of a monthly calendar. A blank or unreadable cell is simply absent. */
export interface CalendarRow {
  /** Local date, YYYY-MM-DD. */
  date: string;
  times: Partial<Record<PrayerKey, Listed>>;
}

/** A prayer resolved to an exact instant, ready to become a calendar event. */
export interface PrayerTime {
  date: string;
  prayer: PrayerKey;
  at: Date;
  /** Printed value, or undefined when the cell was blank. */
  listed?: string;
  /** Why the printed value was not used as is. Shown in the log and on the event. */
  note?: string;
}

export interface SyncStats {
  windowDays: number;
  daysSynced: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** First day that could not be synced. */
  stoppedAt?: string;
  error?: string;
}

export interface RunRecord extends SyncStats {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  attempt: number;
  dryRun: boolean;
}

/** state.json. Machine data: every instant is a UTC ISO string. */
export interface State {
  /** When the next run is due. Absent until the first run. */
  nextRunAt?: string;
  lastRun?: RunRecord;
  lastSuccessAt?: string;
}
