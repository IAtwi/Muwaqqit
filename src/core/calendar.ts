import type { TextItem } from './pdf.js';
import { COLUMN_ORDER, type CalendarRow, type Listed, type PrayerKey } from './types.js';
import { daysInMonth, formatDate, monthLabel } from './time.js';

/**
 * Reads one monthly calendar table from positioned text.
 *
 * Every row has a date, eight clock times, a weekday name and a day number. What makes this
 * harder than it looks, all seen in the publisher's real 2025 and 2026 files:
 * - Cells of one row are drawn up to ~2pt apart vertically, so text-line based extraction
 *   shifts whole columns by a row. Rows are anchored on the date cell instead, and each time
 *   goes to the nearest anchor.
 * - A cell can be drawn in pieces: dates as "1/10/" + "2026" or "2/9" + "/" + "2026", times
 *   as "19:0" + "0" or even "2" + "2" + ":44". Adjacent pieces are rejoined.
 * - Some files print afternoon columns on a 12-hour clock (Asr "3:50"). Columns that are
 *   always afternoon or evening in Lebanon are read as such.
 * - A cell can be blank (Tyre, 31 December 2026). That is left for later stages to handle.
 * Anything structurally unexpected throws, so a changed layout fails loudly instead of
 * producing wrong times.
 */

export class CalendarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarFormatError';
  }
}

const TIME = /^(\d{1,2}):(\d{2})$/;
const TIME_PIECE = /^[\d:]+$/;
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const DATE_PIECE = /^[\d/]+$/;
/** Vertical tolerance when grouping date pieces into one line, in points. */
const LINE_TOLERANCE = 3;
/** Pieces of one cell share a baseline exactly; this only absorbs rounding. */
const FRAGMENT_TOLERANCE = 0.5;
/** Horizontal room per character between the starts of two pieces of one cell, in points. */
const FRAGMENT_GAP_PER_CHAR = 8;

/** Columns that are always after noon in Lebanon, so a 12-hour value there means PM. */
const AFTERNOON: ReadonlySet<PrayerKey> = new Set(['asr', 'maghrib', 'isha', 'midnight']);

interface Anchor {
  page: number;
  y: number;
  date: string;
  day: number;
  month: number;
  year: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function isTime(text: string): boolean {
  const m = TIME.exec(text);
  return m !== null && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/** A printed time as minutes after midnight, reading afternoon columns as PM if needed. */
function toListed(text: string, key: PrayerKey | undefined): Listed | undefined {
  const m = TIME.exec(text);
  if (!m || !isTime(text)) return undefined;
  let minutes = Number(m[1]) * 60 + Number(m[2]);
  if (key && AFTERNOON.has(key) && minutes < 12 * 60) minutes += 12 * 60;
  return { minutes, text };
}

/** Groups items that sit on the same baseline, per page. */
function lines(items: TextItem[], tolerance: number): TextItem[][] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const out: { page: number; y: number; items: TextItem[] }[] = [];
  for (const item of sorted) {
    const line = out.find((l) => l.page === item.page && Math.abs(l.y - item.y) <= tolerance);
    if (line) line.items.push(item);
    else out.push({ page: item.page, y: item.y, items: [item] });
  }
  return out.map((l) => l.items.sort((a, b) => a.x - b.x));
}

/** Rejoins time cells drawn in pieces ("2" "2" ":44", "19:0" "0"). Other items pass through. */
export function joinTimeFragments(items: TextItem[]): TextItem[] {
  const out = items.filter((i) => !TIME_PIECE.test(i.text));
  for (const row of lines(items.filter((i) => TIME_PIECE.test(i.text)), FRAGMENT_TOLERANCE)) {
    let i = 0;
    while (i < row.length) {
      const first = row[i] as TextItem;
      let text = first.text;
      let j = i;
      while (!isTime(text) && j + 1 < row.length && text.length < 5) {
        const prev = row[j] as TextItem;
        const next = row[j + 1] as TextItem;
        if (next.x - prev.x > FRAGMENT_GAP_PER_CHAR * prev.text.length + 4) break;
        text += next.text;
        j++;
      }
      if (j > i && isTime(text)) {
        out.push({ ...first, text });
        i = j + 1;
      } else {
        out.push(first);
        i++;
      }
    }
  }
  return out;
}

/** Rebuilds the date cells from their pieces, one anchor per table row. */
function findAnchors(items: TextItem[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const row of lines(items.filter((i) => DATE_PIECE.test(i.text)), LINE_TOLERANCE)) {
    for (let i = 0; i < row.length; i++) {
      let joined = '';
      for (let j = i; j < Math.min(row.length, i + 4); j++) {
        joined += (row[j] as TextItem).text;
        const m = DATE.exec(joined);
        if (m) {
          const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
          const first = row[i] as TextItem;
          anchors.push({ page: first.page, y: first.y, date: formatDate(year, month, day), day, month, year });
          i = row.length; // one date per row
          break;
        }
      }
    }
  }
  return anchors.sort((a, b) => a.page - b.page || b.y - a.y);
}

export function parseCalendar(rawItems: TextItem[], year: number, month: number): CalendarRow[] {
  const label = monthLabel(year, month);
  const fail = (why: string): never => {
    throw new CalendarFormatError(`${label} calendar: ${why}`);
  };

  const items = joinTimeFragments(rawItems.map((i) => ({ ...i, text: i.text.trim() })).filter((i) => i.text));
  const anchors = findAnchors(items);
  const expectedDays = daysInMonth(year, month);
  if (anchors.length !== expectedDays) {
    fail(`expected ${expectedDays} dated rows, found ${anchors.length}. The layout may have changed.`);
  }
  anchors.forEach((a, i) => {
    if (a.year !== year || a.month !== month || a.day !== i + 1) {
      fail(`row ${i + 1} is dated ${a.day}/${a.month}/${a.year}, expected ${i + 1}/${month}/${year}.`);
    }
  });

  // Row pitch, from consecutive rows on the same page.
  const gaps: number[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1] as Anchor;
    const b = anchors[i] as Anchor;
    if (a.page === b.page) gaps.push(a.y - b.y);
  }
  const pitch = median(gaps);
  if (!(pitch > 4)) fail('rows are too close together to tell apart.');

  // Each time goes to the row whose date is vertically nearest, within half a row.
  const rows: TextItem[][] = anchors.map(() => []);
  for (const item of items) {
    if (!isTime(item.text)) continue;
    let best = -1;
    let bestDistance = Infinity;
    anchors.forEach((a, k) => {
      if (a.page !== item.page) return;
      const d = Math.abs(a.y - item.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = k;
      }
    });
    if (best >= 0 && bestDistance < pitch * 0.45) (rows[best] as TextItem[]).push(item);
  }

  // Column positions, from the rows where all eight cells are filled.
  const complete = rows.filter((r) => r.length === COLUMN_ORDER.length).map((r) => [...r].sort((a, b) => a.x - b.x));
  if (complete.length < Math.min(10, expectedDays)) {
    fail(`only ${complete.length} rows have all ${COLUMN_ORDER.length} times. The layout may have changed.`);
  }
  const centers = COLUMN_ORDER.map((_, k) => median(complete.map((r) => (r[k] as TextItem).x)));
  const spacing = Math.min(...centers.slice(1).map((c, k) => c - (centers[k] as number)));
  if (!(spacing > 10)) fail('time columns overlap.');

  // Left to right the columns run midnight, isha, maghrib ... imsak, so apart from midnight
  // every row must read strictly later to earlier. This is what pins the column meanings.
  const ordered = complete.filter((r) => {
    const values = r.slice(1).map((t, k) => toListed(t.text, COLUMN_ORDER[k + 1])?.minutes ?? NaN);
    return values.every((v, k) => k === 0 || v < (values[k - 1] as number));
  });
  if (ordered.length < complete.length * 0.8) {
    fail(
      `the time columns are not in the expected order (${ordered.length} of ${complete.length} rows fit). ` +
        'The layout may have changed.',
    );
  }

  return anchors.map((anchor, i) => {
    const times: Partial<Record<PrayerKey, Listed>> = {};
    const taken = new Set<PrayerKey>();
    for (const item of rows[i] as TextItem[]) {
      let column = -1;
      let distance = Infinity;
      centers.forEach((c, k) => {
        const d = Math.abs(item.x - c);
        if (d < distance) {
          distance = d;
          column = k;
        }
      });
      const key = COLUMN_ORDER[column];
      const listed = toListed(item.text, key);
      if (key === undefined || distance > spacing * 0.4 || !listed) continue;
      if (taken.has(key)) {
        // Two values in one cell: trust neither.
        delete times[key];
        continue;
      }
      taken.add(key);
      times[key] = listed;
    }
    return { date: anchor.date, times };
  });
}
