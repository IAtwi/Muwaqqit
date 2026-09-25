import { CONFIG } from '../config.js';

/**
 * Timezone helpers built on Intl, so no dependency is needed and the server clock's own
 * timezone never matters. Dates are 'YYYY-MM-DD' strings in CONFIG.timezone throughout.
 */

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(d: Date, tz = CONFIG.timezone): LocalParts {
  let fmt = partsFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(tz, fmt);
  }
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(d)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? 0, month: out.month ?? 0, day: out.day ?? 0,
    hour: out.hour ?? 0, minute: out.minute ?? 0, second: out.second ?? 0,
  };
}

/** UTC offset of `tz` at that instant, in minutes. Beirut gives 120 or 180. */
export function offsetMinutes(d: Date, tz = CONFIG.timezone): number {
  let fmt = offsetFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    offsetFormatters.set(tz, fmt);
  }
  const name = fmt.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  const total = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -total : total;
}

/** "+03:00" style rendering of an offset in minutes. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseDate(date: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Calendar arithmetic on a date string. Month and year boundaries are handled by Date.UTC. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The local date of an instant. */
export function localDate(d: Date, tz = CONFIG.timezone): string {
  const p = localParts(d, tz);
  return formatDate(p.year, p.month, p.day);
}

/**
 * The instant at which the wall clock in `tz` reads `minutes` past midnight on `date`.
 * A wall time skipped by a DST jump is pushed forward by the jump (a skipped 00:00 becomes
 * 01:00), and a wall time that occurs twice resolves to its later occurrence, which is the
 * one that reads as that date. Both matter here: Lebanon changes its clocks at midnight.
 */
export function zonedTime(date: string, minutes: number, tz = CONFIG.timezone): Date {
  const { year, month, day } = parseDate(date);
  const asUtc = Date.UTC(year, month - 1, day, 0, minutes);
  const first = offsetMinutes(new Date(asUtc), tz);
  let t = asUtc - first * 60_000;
  const second = offsetMinutes(new Date(t), tz);
  if (second !== first) t = asUtc - second * 60_000;
  return new Date(t);
}

/** Local midnight at the start of `date`. */
export function localMidnight(date: string, tz = CONFIG.timezone): Date {
  return zonedTime(date, 0, tz);
}

/** RFC 3339 with the local offset, e.g. "2026-10-26T11:22:00+02:00". Google needs the offset. */
export function isoLocal(d: Date, tz = CONFIG.timezone): string {
  const p = localParts(d, tz);
  return (
    `${formatDate(p.year, p.month, p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    formatOffset(offsetMinutes(d, tz))
  );
}

/** "HH:MM" for a count of minutes after midnight. */
export function clock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "HH:MM" of an instant on the local wall clock. */
export function localClock(d: Date, tz = CONFIG.timezone): string {
  const p = localParts(d, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "YYYY-MM-DD HH:MM:SS +03:00" for anything human facing. */
export function fullStamp(value: Date | string | undefined, tz = CONFIG.timezone): string {
  if (value === undefined || value === '') return 'never';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  const p = localParts(d, tz);
  return (
    `${formatDate(p.year, p.month, p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ` +
    formatOffset(offsetMinutes(d, tz))
  );
}

/** "29 days 3 hours", "4 minutes": how far away an instant is. */
export function describeWait(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `${days} day${days === 1 ? '' : 's'}` + (rest ? ` ${rest} hour${rest === 1 ? '' : 's'}` : '');
}

/** Month name for logs, e.g. "October 2026". */
export function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}
