import { CONFIG } from './config.js';
import { loadEnv } from './core/env.js';
import { getAccessToken, getCalendar } from './core/google.js';
import { message } from './core/http.js';
import { dateStamp, Logger, pruneOldLogs } from './core/logger.js';
import { isDue, nextAfterFailure, nextAfterSuccess, retryAt } from './core/schedule.js';
import { acquireLock, loadState, releaseLock, saveState } from './core/state.js';
import { loadWindow, syncWindow } from './core/sync.js';
import { addDays, describeWait, fullStamp, localClock, localDate, monthLabel } from './core/time.js';
import { PRAYER_NAMES, type RunRecord, type State, type SyncStats } from './core/types.js';

const ATTEMPTS = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function counts(s: SyncStats): string {
  return `created ${s.created}, updated ${s.updated}, unchanged ${s.unchanged}, removed ${s.removed}`;
}

function describeRun(r: RunRecord): string {
  const head = `${fullStamp(r.startedAt)}, attempt ${r.attempt}${r.dryRun ? ', dry run' : ''}`;
  return r.ok
    ? `${head}: ok, ${r.daysSynced}/${r.windowDays} days synced (${counts(r)})`
    : `${head}: FAILED at ${r.stoppedAt ?? '?'}, ${r.daysSynced}/${r.windowDays} days synced. ${r.error ?? ''}`;
}

/** One pass over the window, fully logged. Never throws. */
async function runOnce(log: Logger, attempt: number, dryRun: boolean): Promise<RunRecord> {
  const started = new Date();
  const today = localDate(started);
  const days = CONFIG.sync.windowDays;

  log.raw('');
  log.raw(`=== run started ${fullStamp(started)} | attempt ${attempt} of ${ATTEMPTS}${dryRun ? ' | DRY RUN, nothing is written' : ''} ===`);
  log.info(`window: ${today} to ${addDays(today, days - 1)} (${days} days)`);

  let stats: SyncStats;
  try {
    stats = await syncWindow(today, log, dryRun);
  } catch (err) {
    stats = { windowDays: days, daysSynced: 0, created: 0, updated: 0, unchanged: 0, removed: 0, stoppedAt: today, error: message(err) };
  }

  const finished = new Date();
  const ok = !stats.error && stats.daysSynced === stats.windowDays;
  const elapsed = ((finished.getTime() - started.getTime()) / 1000).toFixed(1);
  if (ok) {
    log.info(`finished ${fullStamp(finished)} in ${elapsed}s: all good, ${stats.daysSynced}/${stats.windowDays} days synced (${counts(stats)})`);
  } else {
    log.error(`stopped at ${stats.stoppedAt}: ${stats.error ?? 'unknown error'}`);
    log.error(
      `finished ${fullStamp(finished)} in ${elapsed}s: FAILED at ${stats.stoppedAt}, ` +
        `${stats.daysSynced}/${stats.windowDays} days synced (${counts(stats)})`,
    );
  }
  return { ...stats, startedAt: started.toISOString(), finishedAt: finished.toISOString(), ok, attempt, dryRun };
}

/**
 * A run with the retry policy: on failure, one retry 5 minutes later in the same process;
 * if that fails too, the next try is the coming local midnight. On success the next run is
 * local midnight 30 days on.
 */
async function run(dryRun: boolean): Promise<number> {
  const log = new Logger();
  const state = loadState();

  if (!dryRun) {
    // Written before any work, so a run killed midway (reboot, OOM) still leaves a schedule:
    // the one a double failure would have produced.
    state.nextRunAt = nextAfterFailure(new Date()).toISOString();
    saveState(state);
  }

  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const record = await runOnce(log, attempt, dryRun);
      if (dryRun) return record.ok ? 0 : 1;

      state.lastRun = record;
      if (record.ok) state.lastSuccessAt = record.finishedAt;
      saveState(state);

      if (record.ok) {
        const next = nextAfterSuccess(new Date());
        state.nextRunAt = next.toISOString();
        saveState(state);
        log.info(`next run: ${fullStamp(next)} (in ${describeWait(next.getTime() - Date.now())})`);
        return 0;
      }

      if (attempt < ATTEMPTS) {
        const at = retryAt(new Date());
        log.warn(`retrying in ${CONFIG.sync.retryMinutes} minutes, at ${localClock(at)}`);
        await sleep(at.getTime() - Date.now());
      }
    }

    const next = nextAfterFailure(new Date());
    state.nextRunAt = next.toISOString();
    saveState(state);
    log.warn(`the retry failed too. Next try: ${fullStamp(next)} (in ${describeWait(next.getTime() - Date.now())})`);
    return 1;
  } finally {
    const pruned = pruneOldLogs();
    if (pruned > 0) log.info(`pruned ${pruned} old log file(s)`);
  }
}

function printStatus(state: State): void {
  const now = Date.now();
  let next: string;
  if (!state.nextRunAt) next = 'not scheduled yet: the next hourly cron check runs the first sync';
  else if (isDue(state.nextRunAt, new Date(now))) next = `${fullStamp(state.nextRunAt)} (due: the next hourly cron check runs it)`;
  else next = `${fullStamp(state.nextRunAt)} (in ${describeWait(Date.parse(state.nextRunAt) - now)})`;

  console.log('\nMuwaqqit');
  console.log(`  next run      ${next}`);
  console.log(`  last run      ${state.lastRun ? describeRun(state.lastRun) : 'never'}`);
  console.log(`  last success  ${fullStamp(state.lastSuccessAt)}`);
  console.log(`  calendar id   ${process.env.GOOGLE_CALENDAR_ID || 'not set (run npm run auth)'}`);
  console.log(`  today's log   ${CONFIG.logs.dir}/${dateStamp()}.log\n`);
}

/** Prints the resolved window as a table. Needs no Google credentials. */
async function printTimes(): Promise<number> {
  const today = localDate(new Date());
  const days = CONFIG.sync.windowDays;
  const window = await loadWindow(today, days);
  const prayers = CONFIG.events.prayers;

  console.log(`\n${CONFIG.source.label} prayer times, ${today} to ${addDays(today, days - 1)} (${CONFIG.timezone} clock)\n`);
  console.log(['date      ', ...prayers.map((p) => PRAYER_NAMES[p.key].padEnd(8))].join('  '));
  for (const date of window.dates) {
    const day = window.resolution.days.get(date);
    if (!day) {
      const why = window.resolution.errors.get(date) ?? (window.failedMonth ? 'calendar not available' : 'no data');
      console.log(`${date}  ${why}`);
      continue;
    }
    const cells = prayers.map((p) => {
      const t = day.find((d) => d.prayer === p.key);
      return t ? `${localClock(t.at)}${t.note ? '*' : ''}`.padEnd(8) : '-'.padEnd(8);
    });
    console.log([date, ...cells].join('  '));
  }
  if (window.failedMonth) {
    console.log(`\n${monthLabel(window.failedMonth.year, window.failedMonth.month)}: ${window.failedMonth.error}`);
  }
  if (window.resolution.notices.length > 0) {
    console.log('\n* differs from the printed calendar:');
    for (const n of window.resolution.notices) console.log(`  - ${n}`);
  }
  console.log('');
  return window.failedMonth ? 1 : 0;
}

/** Preflight: credentials, calendar access and the source, without writing anything. */
async function check(): Promise<number> {
  let failures = 0;
  const line = (label: string, text: string) => console.log(`  ${label.padEnd(9)} ${text}`);
  console.log('');

  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID'].filter(
    (k) => !process.env[k],
  );
  if (missing.length > 0) {
    failures++;
    line('env', `MISSING ${missing.join(', ')} (see README.md)`);
  } else {
    line('env', 'ok');
  }

  try {
    const today = localDate(new Date());
    const window = await loadWindow(today, CONFIG.sync.windowDays);
    const covered = window.dates.filter((d) => window.resolution.days.has(d)).length;
    const text = `${covered}/${window.dates.length} days resolved` +
      (window.resolution.notices.length ? `, ${window.resolution.notices.length} correction(s) (see npm run times)` : '');
    if (window.failedMonth) {
      failures++;
      line('source', `${text}. ${monthLabel(window.failedMonth.year, window.failedMonth.month)}: ${window.failedMonth.error}`);
    } else {
      line('source', `ok, ${text}`);
    }
  } catch (err) {
    failures++;
    line('source', `FAIL ${message(err)}`);
  }

  if (missing.length === 0) {
    try {
      await getAccessToken();
      const calendar = await getCalendar(process.env.GOOGLE_CALENDAR_ID as string);
      if (calendar) {
        line('google', `ok, calendar "${calendar.summary ?? '?'}" (${calendar.timeZone ?? '?'})`);
      } else {
        failures++;
        line('google', 'FAIL calendar not found, or not created by this app. Run npm run auth to create one.');
      }
    } catch (err) {
      failures++;
      line('google', `FAIL ${message(err)}`);
    }
  }

  const state = loadState();
  line('schedule', state.nextRunAt ? `next run ${fullStamp(state.nextRunAt)}` : 'no run yet');
  console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} problem(s) found.\n`);
  return failures > 0 ? 1 : 0;
}

function printHelp(): void {
  console.log(`
Muwaqqit - keeps Beirut prayer times in a Google Calendar, with reminders.

  npm start          cron entry: runs a sync only when one is due, otherwise exits silently
  npm run sync       sync now, whatever the schedule (with the usual retry and rescheduling)
  npm run dry        sync now but write nothing: log what would change
  npm run times      print the next ${CONFIG.sync.windowDays} days of times (no Google access needed)
  npm run status     show the schedule and the last run
  npm run check      verify credentials, calendar access and the calendar source
  npm run auth       one-time Google sign-in; prints the refresh token and calendar id
  npm run selftest   offline checks of parsing, time handling and scheduling

Flags: --now  --dry-run  --times  --status  --check  --help
`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  loadEnv();

  if (args.includes('--status')) {
    printStatus(loadState());
    return 0;
  }
  if (args.includes('--times')) return printTimes();
  if (args.includes('--check')) return check();

  const dryRun = args.includes('--dry-run');
  const now = args.includes('--now') || dryRun;

  // The hourly cron check. Silent when nothing is due, which is almost always.
  if (!now && !isDue(loadState().nextRunAt, new Date())) return 0;

  if (!acquireLock()) {
    console.log('Another run is in progress (see .run.lock). Nothing to do.');
    return 0;
  }
  try {
    return await run(dryRun);
  } finally {
    releaseLock();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('muwaqqit: fatal', err);
    process.exit(1);
  });
