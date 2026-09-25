import { CONFIG } from '../config.js';
import { parseCalendar } from './calendar.js';
import { HttpError, message, request } from './http.js';
import { extractText } from './pdf.js';
import { addDays, monthLabel, parseDate } from './time.js';
import type { CalendarRow } from './types.js';

export function calendarUrl(year: number, month: number): string {
  return CONFIG.source.urlTemplate.replace('{year}', String(year)).replace('{month}', String(month));
}

/** Downloads one monthly calendar PDF. A month not published yet is a normal, clear error. */
export async function downloadMonth(year: number, month: number): Promise<Buffer> {
  const url = calendarUrl(year, month);
  const res = await request(url);
  if (res.status === 404) {
    throw new HttpError(404, '', `the ${monthLabel(year, month)} calendar is not published yet (HTTP 404 from ${url})`);
  }
  if (!res.ok) throw new HttpError(res.status, '', `HTTP ${res.status} from ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    throw new Error(`${url} did not return a PDF (content-type ${res.headers.get('content-type') ?? 'none'})`);
  }
  return body;
}

export function readMonth(pdf: Buffer, year: number, month: number): CalendarRow[] {
  return parseCalendar(extractText(pdf), year, month);
}

export interface MonthLoad {
  year: number;
  month: number;
  rows?: CalendarRow[];
  error?: string;
}

/** The months touched by a window of days, in order. */
export function monthsOf(firstDate: string, days: number): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  for (let i = 0; i < days; i++) {
    const { year, month } = parseDate(addDays(firstDate, i));
    const last = out[out.length - 1];
    if (!last || last.year !== year || last.month !== month) out.push({ year, month });
  }
  return out;
}

/**
 * Loads the months in order and stops at the first one that fails, since days after a
 * failed month can never be synced in the same run anyway.
 */
export async function loadMonths(months: { year: number; month: number }[]): Promise<MonthLoad[]> {
  const out: MonthLoad[] = [];
  for (const { year, month } of months) {
    try {
      out.push({ year, month, rows: readMonth(await downloadMonth(year, month), year, month) });
    } catch (err) {
      out.push({ year, month, error: message(err) });
      break;
    }
  }
  return out;
}
