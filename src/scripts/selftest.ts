import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from '../config.js';
import { joinTimeFragments, parseCalendar } from '../core/calendar.js';
import { saveEnv } from '../core/env.js';
import { desiredEvent, differences } from '../core/events.js';
import type { ApiEvent } from '../core/google.js';
import { dateStamp, Logger, pruneOldLogs } from '../core/logger.js';
import { extractText, type TextItem } from '../core/pdf.js';
import { resolveDays, solarNoonUtcMinutes, type Resolution } from '../core/prayers.js';
import { isDue, nextAfterFailure, nextAfterSuccess, retryAt } from '../core/schedule.js';
import { acquireLock, loadState, releaseLock, saveState } from '../core/state.js';
import { addDays, fullStamp, isoLocal, localClock, localMidnight } from '../core/time.js';
import type { CalendarRow, PrayerKey, PrayerTime } from '../core/types.js';

/**
 * Offline verification of everything that needs no network or credentials: PDF extraction
 * and table parsing on real calendars (fixtures/), offset detection, misprint repair, time
 * zones, scheduling, event diffing, state and logging. Run with `npm run selftest`.
 */
let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}\n         expected ${e}\n         actual   ${a}`);
    console.log(`  FAIL ${name}  expected ${e}, got ${a}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const KEYS: PrayerKey[] = ['fajr', 'dhuhr', 'maghrib'];
const fixture = (name: string) => extractText(readFileSync(join('fixtures', name)));
const texts = (row: CalendarRow | undefined) => ({
  date: row?.date,
  fajr: row?.times.fajr?.text,
  dhuhr: row?.times.dhuhr?.text,
  maghrib: row?.times.maghrib?.text,
});
const prayer = (res: Resolution, date: string, key: PrayerKey): PrayerTime | undefined =>
  res.days.get(date)?.find((p) => p.prayer === key);

// Real calendars, each chosen for a quirk:
//   beirut-2026-10  a misprinted Maghrib (28th) and a clock change 3 days after Lebanon's
//   beirut-2026-03  cells offset vertically enough to break line-based extraction; spring change
//   saida-2026-09   dates drawn as "2/9" + "/" + "2026" and a time as "19:0" + "0"
console.log('\npdf extraction');
const octItems = fixture('beirut-2026-10.pdf');
check('every time cell of October is found', octItems.filter((i) => /^\d{1,2}:\d{2}$/.test(i.text.trim())).length, 31 * 8);
check('cell text and position', octItems.some((i) => i.text === '5:19' && Math.abs(i.x - 363.67) < 0.01 && Math.abs(i.y - 626.5) < 0.01), true);
check('Type0 font text decodes through ToUnicode', octItems.some((i) => /[؀-ۿ]/.test(i.text)), true);
check('not a PDF is rejected', throws(() => extractText(Buffer.from('<html>404</html>'))), true);

console.log('\ncalendar parsing');
const oct = parseCalendar(octItems, 2026, 10);
check('October has 31 rows', oct.length, 31);
check('1 October', texts(oct[0]), { date: '2026-10-01', fajr: '5:19', dhuhr: '12:28', maghrib: '18:42' });
check('28 October keeps the misprint as printed', oct[27]?.times.maghrib?.text, '18:09');
check('every cell filled', oct.every((r) => Object.keys(r.times).length === 8), true);
const mar = parseCalendar(fixture('beirut-2026-03.pdf'), 2026, 3);
check('March, despite offset cells', mar.length, 31);
check('1 March', texts(mar[0]), { date: '2026-03-01', fajr: '4:54', dhuhr: '11:50', maghrib: '17:51' });
check('1 March Isha is on its own row', mar[0]?.times.isha?.text, '18:43');
check('29 March, first day of summer time', texts(mar[28]), { date: '2026-03-29', fajr: '5:16', dhuhr: '12:42', maghrib: '19:13' });
const saida = parseCalendar(fixture('saida-2026-09.pdf'), 2026, 9);
check('date drawn as "2/9" + "/" + "2026"', saida[1]?.date, '2026-09-02');
check('time drawn as "19:0" + "0"', saida[16]?.times.maghrib?.text, '19:00');
check('the wrong month is rejected', throws(() => parseCalendar(octItems, 2026, 11)), true);
check('an empty page is rejected', throws(() => parseCalendar([], 2026, 10)), true);

console.log('\ntime fragments');
const item = (x: number, text: string): TextItem => ({ page: 1, x, y: 100, text });
check('"2" "2" ":44" rejoins', joinTimeFragments([item(99.38, '2'), item(105.38, '2'), item(111.38, ':44'), item(153.14, '18:01')]).map((i) => i.text).sort(), ['18:01', '22:44']);
check('"19:0" "0" rejoins', joinTimeFragments([item(199.13, '19:0'), item(221.09, '0')]).map((i) => i.text), ['19:00']);
check('a distant day number stays apart', joinTimeFragments([item(470, '2026'), item(556.8, '1')]).map((i) => i.text).sort(), ['1', '2026']);
check('whole times are left alone', joinTimeFragments([item(99, '23:43'), item(153, '19:31')]).map((i) => i.text).sort(), ['19:31', '23:43']);

console.log('\nclock detection and misprints');
check('solar noon, Beirut, 23 October (09:22 UTC)', Math.round(solarNoonUtcMinutes('2026-10-23', CONFIG.source.longitude)), 9 * 60 + 22);
const octRes = resolveDays(oct, KEYS);
check('24 October Zuhr, summer time as printed', prayer(octRes, '2026-10-24', 'dhuhr')?.at.toISOString(), '2026-10-24T09:22:00.000Z');
check('26 October Zuhr, still printed on summer time', prayer(octRes, '2026-10-26', 'dhuhr')?.at.toISOString(), '2026-10-26T09:22:00.000Z');
check('... which is 11:22 on the Beirut clock', localClock(prayer(octRes, '2026-10-26', 'dhuhr')?.at as Date), '11:22');
check('... and says so on the event', prayer(octRes, '2026-10-26', 'dhuhr')?.note?.includes('12:22'), true);
check('28 October Maghrib misprint 18:09 repaired', localClock(prayer(octRes, '2026-10-28', 'maghrib')?.at as Date), '17:09');
check('... with a note naming the printed value', prayer(octRes, '2026-10-28', 'maghrib')?.note?.includes('18:09'), true);
check('28 October Sobh untouched', prayer(octRes, '2026-10-28', 'fajr')?.note, undefined);
check('two findings reported', octRes.notices.length, 2);
const marRes = resolveDays(mar, KEYS);
check('March clock change matches the zone rules: nothing to report', marRes.notices.length, 0);
check('29 March Sobh is 05:16 local', localClock(prayer(marRes, '2026-03-29', 'fajr')?.at as Date), '05:16');

const blank = structuredClone(oct);
delete (blank[9] as CalendarRow).times.fajr;
const blankRes = resolveDays(blank, KEYS);
check('a blank cell is estimated from neighbouring days', localClock(prayer(blankRes, '2026-10-10', 'fajr')?.at as Date), '05:26');
check('... and flagged', prayer(blankRes, '2026-10-10', 'fajr')?.note?.includes('blank'), true);
const zero = structuredClone(oct);
(zero[14] as CalendarRow).times.dhuhr = { minutes: 40, text: '0:40' };
const zeroRes = resolveDays(zero, KEYS);
check('a Zuhr printed as 0:40 is repaired', localClock(prayer(zeroRes, '2026-10-15', 'dhuhr')?.at as Date), '12:24');
check('... without disturbing that day\'s Sobh', prayer(zeroRes, '2026-10-15', 'fajr')?.note, undefined);
const broken = structuredClone(oct);
for (const i of [2, 6, 10, 14, 18, 22]) (broken[i] as CalendarRow).times.maghrib = { minutes: 600, text: '10:00' };
check('many misprints in one column: refuses to guess', throws(() => resolveDays(broken, KEYS)), true);

console.log('\ntime zones');
check('midnight, 26 September', localMidnight('2026-09-26').toISOString(), '2026-09-25T21:00:00.000Z');
check('midnight on the autumn change day', localMidnight('2026-10-25').toISOString(), '2026-10-24T22:00:00.000Z');
check('skipped spring midnight becomes 01:00', localMidnight('2026-03-29').toISOString(), '2026-03-28T22:00:00.000Z');
check('local ISO, summer', isoLocal(new Date('2026-10-24T09:22:00Z')), '2026-10-24T12:22:00+03:00');
check('local ISO, winter', isoLocal(new Date('2026-10-26T09:22:00Z')), '2026-10-26T11:22:00+02:00');
check('adding days across a year', addDays('2026-12-31', 1), '2027-01-01');
check('fullStamp is local, not UTC', fullStamp('2026-08-30T15:39:32.134Z'), '2026-08-30 18:39:32 +03:00');

console.log('\nschedule');
const now = new Date('2026-09-25T18:40:00Z'); // 21:40 in Beirut
check('success: local midnight 30 days on', fullStamp(nextAfterSuccess(now)), '2026-10-25 00:00:00 +02:00');
check('double failure: the coming midnight', fullStamp(nextAfterFailure(now)), '2026-09-26 00:00:00 +03:00');
check('failure right after midnight: the next one', fullStamp(nextAfterFailure(new Date('2026-09-25T21:00:30Z'))), '2026-09-27 00:00:00 +03:00');
check('retry 5 minutes later', retryAt(now).toISOString(), '2026-09-25T18:45:00.000Z');
check('due when never run', isDue(undefined, now), true);
check('not due before the time', isDue('2026-09-25T21:00:00.000Z', now), false);
check('due once the time has come', isDue('2026-09-25T18:40:00.000Z', now), true);

console.log('\nevents');
const sobh = prayer(octRes, '2026-10-26', 'fajr') as PrayerTime;
const body = desiredEvent(sobh);
check('title', body.summary, 'Sobh prayer time');
check('start, with the Beirut offset', body.start.dateTime, '2026-10-26T04:38:00+02:00');
check('a point in time: ends when it starts', body.end.dateTime, '2026-10-26T04:38:00+02:00');
check('popup 5 minutes before', body.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] });
check('tagged as ours', body.extendedProperties?.private, { app: 'muwaqqit', date: '2026-10-26', prayer: 'fajr' });
const existing: ApiEvent = {
  id: 'abc',
  summary: body.summary,
  description: body.description,
  start: { dateTime: '2026-10-26T05:38:00+03:00' }, // the same instant, written in another offset
  end: { dateTime: '2026-10-26T05:38:00+03:00' },
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
};
check('same instant in another offset: unchanged', differences(existing, body), []);
check('moved by hand: time differs', differences({ ...existing, start: { dateTime: '2026-10-26T05:00:00+02:00' } }, body).map((d) => d.field), ['time']);
check('... described old to new', differences({ ...existing, start: { dateTime: '2026-10-26T05:00:00+02:00' } }, body)[0]?.text, 'time 05:00 -> 04:38');
check('a longer event is shortened', differences({ ...existing, end: { dateTime: '2026-10-26T05:53:00+03:00' } }, body).map((d) => d.field), ['duration']);
check('reminder removed by hand', differences({ ...existing, reminders: { useDefault: true } }, body).map((d) => d.field), ['reminder']);
check('renamed by hand', differences({ ...existing, summary: 'x' }, body).map((d) => d.field), ['title']);

console.log('\nstate and lock');
const tmp = mkdtempSync(join(tmpdir(), 'muwaqqit-'));
CONFIG.paths.state = join(tmp, 'state.json');
CONFIG.paths.lock = join(tmp, '.run.lock');
check('no state yet', loadState(), {});
saveState({ nextRunAt: '2026-10-24T21:00:00.000Z' });
check('state round trip', loadState(), { nextRunAt: '2026-10-24T21:00:00.000Z' });
writeFileSync(CONFIG.paths.state, '{ not json');
check('corrupt state is an error, not a reset', throws(() => loadState()), true);
check('lock taken', acquireLock(), true);
check('second lock refused', acquireLock(), false);
releaseLock();
check('lock free again', acquireLock(), true);
releaseLock();
writeFileSync(CONFIG.paths.lock, `99999999 ${new Date().toISOString()}\n`);
check('lock left by a dead process is taken over', acquireLock(), true);
releaseLock();

console.log('\n.env writing');
const envFile = join(tmp, '.env');
writeFileSync(envFile, '# a comment\nGOOGLE_CLIENT_ID=abc\nGOOGLE_REFRESH_TOKEN=\n\n');
saveEnv({ GOOGLE_REFRESH_TOKEN: 'tok', GOOGLE_CALENDAR_ID: 'cal@group' }, envFile);
check(
  'replaces in place, appends new keys, keeps the rest',
  readFileSync(envFile, 'utf8'),
  '# a comment\nGOOGLE_CLIENT_ID=abc\nGOOGLE_REFRESH_TOKEN=tok\nGOOGLE_CALENDAR_ID=cal@group\n',
);

console.log('\nlogging');
CONFIG.logs.dir = join(tmp, 'logs');
CONFIG.logs.alsoConsole = false;
new Logger().info('hello');
check('log file named by local date', readdirSync(CONFIG.logs.dir), [`${dateStamp()}.log`]);
check('log line carries the message', readFileSync(join(CONFIG.logs.dir, `${dateStamp()}.log`), 'utf8').includes('INFO  hello'), true);
const stale = join(CONFIG.logs.dir, '2020-01-01.log');
writeFileSync(stale, 'old\n');
const longAgo = Date.now() / 1000 - (CONFIG.logs.retentionDays + 5) * 86400;
utimesSync(stale, longAgo, longAgo);
check('prunes logs past retention', pruneOldLogs(), 1);
check('keeps the current log', readdirSync(CONFIG.logs.dir), [`${dateStamp()}.log`]);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  process.exit(1);
}
