import { CONFIG } from '../config.js';
import { clock, formatOffset, localClock, offsetMinutes, parseDate, zonedTime } from './time.js';
import { DAY_ORDER, PRAYER_NAMES, type CalendarRow, type PrayerKey, type PrayerTime } from './types.js';

/**
 * Turns calendar rows into exact instants, and catches what the printed calendar gets wrong.
 *
 * 1. Which clock the calendar used. Each day's Zuhr sits within about a minute of solar noon,
 *    which is pure astronomy. Comparing the two gives the UTC offset the calendar assumed for
 *    that day, whatever the DST rules say. That matters: the 2026 calendar leaves summer time
 *    on Wednesday 28 October, while Lebanon's rule (and Google) switch on Sunday the 25th.
 *    Converting with the calendar's own offset puts every event at the right moment either way.
 *
 * 2. Typos. In absolute (UTC) time each prayer drifts by at most ~2 minutes a day, with no DST
 *    jumps, so a value far from its neighbours, or out of order within its own row, is a
 *    misprint. The 2026 calendar prints Maghrib on 28 October as 18:09 (it is 17:09). Such a
 *    value is replaced by the neighbouring days' trend and flagged, in the log and on the event.
 */

/** Minutes a value may sit from its neighbours' median before it counts as a misprint. */
const OUTLIER_MINUTES = 4;
/** More corrections than this for one prayer in one run means something structural is wrong. */
const MAX_CORRECTIONS_PER_PRAYER = 4;

/** Solar noon in minutes after 00:00 UTC (NOAA approximation, good to about 30 seconds). */
export function solarNoonUtcMinutes(date: string, longitude: number): number {
  const { year, month, day } = parseDate(date);
  const dayOfYear = (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  return 720 - 4 * longitude - equationOfTime;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface Resolution {
  /** Prayers per date, for every date that resolved cleanly. */
  days: Map<string, PrayerTime[]>;
  /** Dates that could not be resolved, with the reason. */
  errors: Map<string, string>;
  /** Human-readable findings worth a warning in the log. */
  notices: string[];
}

interface DayWork {
  row: CalendarRow;
  /** The UTC offset the zone rules give for that day, in minutes. */
  zoneOffset: number;
  /** The UTC offset the calendar itself used, in minutes. */
  calendarOffset?: number;
}

/**
 * @param rows consecutive days, oldest first (several months may be concatenated)
 * @param keys the prayers to resolve
 */
export function resolveDays(rows: CalendarRow[], keys: PrayerKey[]): Resolution {
  const days = new Map<string, PrayerTime[]>();
  const errors = new Map<string, string>();
  const notices: string[] = [];
  const tz = CONFIG.timezone;

  // 1. The offset each day was printed in, read off Zuhr against solar noon.
  const work: DayWork[] = rows.map((row) => {
    const zoneOffset = offsetMinutes(zonedTime(row.date, 12 * 60), tz);
    const dhuhr = row.times.dhuhr;
    let calendarOffset: number | undefined;
    if (dhuhr) {
      const noon = solarNoonUtcMinutes(row.date, CONFIG.source.longitude);
      const hours = Math.round((dhuhr.minutes - noon) / 60);
      // Only a one-hour disagreement with the zone rules is plausible; more means a misprint.
      if (Math.abs(hours * 60 - zoneOffset) <= 60) calendarOffset = hours * 60;
    }
    return { row, zoneOffset, calendarOffset };
  });

  // A single day disagreeing with both neighbours is a misprinted Zuhr, not a clock change.
  work.forEach((w, i) => {
    const before = work[i - 1]?.calendarOffset;
    const after = work[i + 1]?.calendarOffset;
    if (before !== undefined && before === after && w.calendarOffset !== before) w.calendarOffset = before;
  });
  work.forEach((w, i) => {
    if (w.calendarOffset === undefined) {
      w.calendarOffset = work[i - 1]?.calendarOffset ?? work[i + 1]?.calendarOffset ?? w.zoneOffset;
    }
  });

  // Report stretches where the calendar's clock differs from the zone rules.
  for (let i = 0; i < work.length; i++) {
    const w = work[i] as DayWork;
    if (w.calendarOffset === w.zoneOffset) continue;
    let j = i;
    while (j + 1 < work.length && (work[j + 1] as DayWork).calendarOffset !== (work[j + 1] as DayWork).zoneOffset) j++;
    const last = work[j] as DayWork;
    const range = i === j ? w.row.date : `${w.row.date} to ${last.row.date}`;
    const sample = w.row.times.dhuhr;
    const example = sample
      ? ` For example Zuhr, printed ${sample.text}, is ${clock(sample.minutes - (w.calendarOffset as number) + w.zoneOffset)} local time.`
      : '';
    notices.push(
      `${range}: the calendar lists ${i === j ? 'this day' : 'these days'} in UTC${formatOffset(w.calendarOffset as number)}, ` +
        `but ${tz} is on UTC${formatOffset(w.zoneOffset)} then. Times are converted with the calendar's own offset, ` +
        `so the events land at the right moment.${example}`,
    );
    i = j;
  }

  // 2. Each prayer as absolute minutes after 00:00 UTC of its date, then misprint detection.
  const corrections = new Map<PrayerKey, number>();
  const resolved: Map<PrayerKey, { utc?: number; note?: string }[]> = new Map();

  for (const key of keys) {
    const utc = work.map((w) => {
      const listed = w.row.times[key];
      return listed ? listed.minutes - (w.calendarOffset as number) : undefined;
    });

    // Out of order within its own row: compare with the nearest filled columns either side.
    const orderPosition = DAY_ORDER.indexOf(key);
    const outOfOrder = work.map((w) => {
      const own = w.row.times[key];
      if (!own || orderPosition === -1) return false;
      const earlier = DAY_ORDER.slice(0, orderPosition).map((k) => w.row.times[k]).filter(Boolean).pop();
      const later = DAY_ORDER.slice(orderPosition + 1).map((k) => w.row.times[k]).find(Boolean);
      return (earlier !== undefined && own.minutes <= earlier.minutes) || (later !== undefined && own.minutes >= later.minutes);
    });

    const neighbours = (i: number, exclude: boolean[]): number[] =>
      [i - 2, i - 1, i + 1, i + 2]
        .filter((j) => j >= 0 && j < utc.length && !exclude[j])
        .map((j) => utc[j])
        .filter((v): v is number => v !== undefined);

    const none = utc.map(() => false);
    const suspect = utc.map((v, i) => {
      if (v === undefined) return true; // blank cell
      const around = neighbours(i, none);
      // The trend of neighbouring days is the reliable test. The row's own order is only a
      // fallback, since a misprint in another column (not validated here) would break it too.
      if (around.length >= 2) return Math.abs(v - median(around)) > OUTLIER_MINUTES;
      return outOfOrder[i] ?? false;
    });

    const out = utc.map((v, i) => {
      if (!suspect[i]) return { utc: v };
      const w = work[i] as DayWork;
      const name = PRAYER_NAMES[key];
      const around = neighbours(i, suspect);
      if (around.length === 0) {
        errors.set(
          w.row.date,
          v === undefined
            ? `${name} is blank in the calendar and there are no neighbouring days to estimate it from.`
            : `${name} is printed as ${w.row.times[key]?.text}, which does not fit the day, and there are no ` +
              'neighbouring days to estimate it from.',
        );
        return {};
      }
      corrections.set(key, (corrections.get(key) ?? 0) + 1);
      const estimate = Math.round(median(around));
      const localEstimate = clock(estimate + (w.calendarOffset as number));
      const printed = w.row.times[key]?.text;
      const note =
        printed === undefined
          ? `The calendar leaves ${name} blank on this day; ${localEstimate} is estimated from the neighbouring days.`
          : `The calendar prints ${name} as ${printed} on this day, far off the neighbouring days, so it is ` +
            `treated as a misprint; ${localEstimate} is estimated from the neighbouring days.`;
      notices.push(`${w.row.date} ${name}: ${note}`);
      return { utc: estimate, note };
    });
    resolved.set(key, out);
  }

  for (const [key, count] of corrections) {
    if (count > MAX_CORRECTIONS_PER_PRAYER) {
      throw new Error(
        `${count} ${PRAYER_NAMES[key]} values needed correcting, far more than the occasional misprint. ` +
          'The calendar layout has probably changed; refusing to guess.',
      );
    }
  }

  // 3. Instants, plus a note wherever the printed clock differs from the local one.
  work.forEach((w, i) => {
    if (errors.has(w.row.date)) return;
    const { year, month, day } = parseDate(w.row.date);
    const prayers: PrayerTime[] = [];
    for (const key of keys) {
      const r = resolved.get(key)?.[i];
      if (r?.utc === undefined) continue;
      const at = new Date(Date.UTC(year, month - 1, day) + r.utc * 60_000);
      const listed = w.row.times[key]?.text;
      let note = r.note;
      if (!note && w.calendarOffset !== w.zoneOffset && listed) {
        note =
          `The calendar prints ${listed} for this day on UTC${formatOffset(w.calendarOffset as number)} ` +
          `(it changes its clock on a different day than ${tz}); that is ${localClock(at)} local time.`;
      }
      prayers.push({ date: w.row.date, prayer: key, at, ...(listed ? { listed } : {}), ...(note ? { note } : {}) });
    }
    days.set(w.row.date, prayers);
  });

  return { days, errors, notices };
}
