# CLAUDE.md

Context for Claude Code working on Prayer Times. Read this before changing behaviour.

## What this is

A personal automation that keeps Beirut's Sobh, Zuhr and Maghrib times in a Google Calendar,
each event with a 5 minute popup reminder, from Al-Manar's monthly calendar PDFs. Runs on the
same small Ubuntu 24 VPS as Sluice (a YouTube playlist tool) and a Python Discord bot, via an
hourly cron check. Resources are tight, so lightness is a hard requirement, not a preference.

Developed locally at `D:\Programming\VPS\Prayer Times`, pushed to GitHub, pulled on the VPS.
Same stack and conventions as its sibling `D:\Programming\VPS\Sluice`.

## Architecture

```
src/
  config.ts          all tunables; the only place to change behaviour
  main.ts            arg parsing, the cron gate, the run with its retry, --status/--times/--check
  core/
    types.ts         PrayerKey, column orders, CalendarRow, PrayerTime, State
    env.ts           minimal .env reader (no dotenv dependency)
    http.ts          fetch with timeout and bounded, idempotency-aware retries
    time.ts          Intl-based timezone helpers: local dates, zoned midnight, offsets
    pdf.ts           minimal PDF text extraction with positions (zlib only)
    calendar.ts      table reconstruction from positioned text, with strict validation
    prayers.ts       calendar clock detection (solar noon), instants, misprint repair
    source.ts        PDF download, months of a window
    events.ts        desired event body, diff against an existing event (pure)
    google.ts        OAuth token, Calendar API calls
    sync.ts          the day-by-day window sync
    schedule.ts      next-run rules (pure)
    state.ts         atomic state.json, run lock
    logger.ts        daily file logger in CONFIG.timezone, retention pruning
  scripts/           get-refresh-token (npm run auth), selftest
fixtures/            real calendar PDFs the selftest reads, each chosen for a quirk
```

## Design decisions, and why

**1. The monthly PDFs are the only source.** almanar.com.lb/salat renders today's times on the
server; there is no API, and query parameters are ignored. The PDFs are linked from that page:
`static/calendars/{year}/beirut-{month}.pdf`. Only Beirut is wanted.

**2. PDF text is read by coordinates, never by text lines.** Cells of one row are drawn up to
~2pt apart vertically, and `pdftotext -layout` shifts whole columns by a row because of it (seen
on March 2026 and many other months). `calendar.ts` anchors each row on its date cell, gives
each time to the nearest anchor, and assigns columns by x position. **Do not switch to a
line-based extractor.** The local Windows `pdftotext` is Xpdf, not Poppler, which was a second
reason not to shell out to it.

**3. Zero runtime dependencies, including for PDF.** `pdf.ts` is a small purpose-built reader
(object and object-stream parsing, FlateDecode, text operators, ToUnicode). pdf.js would add tens
of MB and a resident-memory spike for one monthly job. **Do not add runtime dependencies.**
If a future PDF needs something `pdf.ts` lacks (another filter, a predictor), extend it and add
the file to `fixtures/`.

**4. Cells arrive in pieces; rejoin them.** Dates as `1/10/` + `2026` or `2/9` + `/` + `2026`;
times as `19:0` + `0` or `2` + `2` + `:44` (Beirut, October 2025). `joinTimeFragments` and
`findAnchors` handle this. Some files print afternoon columns on a 12-hour clock (Saida 2025 Asr
`3:50`); Asr, Maghrib, Isha and Midnight are always PM in Lebanon, so values under 12:00 there
get 12 hours added.

**5. Validation fails loudly rather than guessing.** Wrong number of dated rows, rows out of
sequence, fewer than 10 complete rows, or time columns not strictly ordered in 80% of rows all
throw `CalendarFormatError`. A layout change must stop the sync, never produce plausible wrong
times.

**6. The calendar's clock is detected, not assumed.** Zuhr sits within about a minute of solar
noon (verified: -1.3 to +1.1 minutes over all of 2026). `round((zuhr - solarNoonUtc) / 60)` gives
the UTC offset the calendar used for each day. Times are converted with that offset into
instants, so an event is at the right moment even when the calendar's DST date differs from the
zone rules. Real case: the 2026 calendar leaves summer time on Wed 28 October; Lebanon's rule and
Google switch on Sun 25 October. **Do not "simplify" to sending wall-clock times with a timezone**:
that puts 25-27 October an hour late. A single day whose offset disagrees with both neighbours is
treated as a misprinted Zuhr, not a clock change.

**7. Misprints are repaired from the trend, with a cap.** In UTC each prayer moves at most ~2
minutes a day, so a value more than 4 minutes from its neighbours' median (up to 2 days each
side) is a misprint. It is replaced by that median of non-suspect neighbours, logged as a WARN,
and explained in the event description. The row's own chronological order is only a fallback
when there are too few neighbours: a misprint in another, unvalidated column would break it too.
More than 4 corrections for one prayer in one run throws: that is a broken column, not typos
(Tyre 2025's Asr column is a real example of such garbage). Real misprints found in 2026 across all
regions: Beirut Maghrib 28 Oct `18:09`, Tyre Maghrib 27 Oct `17:10`, Baalbek Zuhr 30 Mar `0:40`.
All are caught; there were no false positives over ~9,000 values.

**8. The sync is keyed, not remembered.** Events carry `extendedProperties.private`
`{app, date, prayer}`. Each run lists them and reconciles: create missing, patch any that differ
(time compared as an instant, plus duration, title, description, reminder), delete duplicates
and prayers no longer configured. No event ids are stored, so a lost `state.json` loses nothing.
Client-chosen event ids were rejected: a deleted event keeps its id reserved, so recreating it
would fail forever with 409.

**9. Inserts are never blindly retried.** A retry after a 5xx or a dropped connection could create
a duplicate. `http.ts` retries non-idempotent requests only when Google says it rejected them
unprocessed (429, or 403 with a rate-limit reason). A failed insert fails the run; the retry run
lists again and sees the event if it did land. PATCH and DELETE are idempotent and retried.

**10. Narrowest OAuth scope: `calendar.app.created`.** It can create calendars and manage events
in calendars it created, and nothing else. It cannot list calendars, which is why the calendar
is created by `npm run auth` and its id kept in `.env` (`GOOGLE_CALENDAR_ID`) rather than looked
up by name. The OAuth client is Sluice's, in the Sluice Cloud project, but the refresh token is
for the Gmail account that owns the calendar. The two tokens are independent.

**11. Cron check hourly, schedule in state, retry in process.** The required behaviour is: on
success, next run at local midnight 30 days later; on failure, retry after 5 minutes; if that
fails, next local midnight; repeat until success. `state.nextRunAt` holds the one next instant.
Cron runs `dist/main.js` every hour; when nothing is due it exits in milliseconds, silently. The
5 minute retry is a sleep inside the same process, so cron never needs minute resolution. Before
any work, a run writes the double-failure schedule (next midnight) as a lease, so a run killed
mid-way still leaves a sane schedule. A resident daemon was rejected for the same reason as in
Sluice: it would hold RAM for a job that runs a dozen times a year.

**12. One run at a time via `.run.lock`**, holding the pid; a lock from a dead process is taken
over. Unlike Sluice this is application-level, because a manual `npm run sync` can overlap a cron
run that is waiting out its 5 minute retry.

**13. Human-facing times use `CONFIG.timezone`; state stays UTC.** Same rule as Sluice. Logs and
`--status` go through `fullStamp()`, which prints the offset. `state.json` holds UTC ISO strings.
Never log a bare `toISOString()`.

**14. The window includes today.** A midnight run makes all of today's events upcoming. A manual
run later in the day creates today's past events too, which is harmless.

## Invariants

- Only events tagged `app=prayer-times` in the configured calendar are ever read or written.
- Deletion only happens for duplicates of one date and prayer, and for prayers removed from
  `CONFIG.events.prayers`, and only within the window being synced.
- A day counts as synced only when all its configured prayers are in line. The run stops at the
  first day that fails; `daysSynced` is therefore a contiguous count from today.
- `run()` saves state after every attempt and writes the lease before the first.
- Dry runs never write to Google and never touch `state.json`.
- Logging failures are swallowed. Logging must never kill a run.
- The logger only appends. It never truncates.
- `dist/` is gitignored. A pull brings source only, so a rebuild is always needed; `deploy.sh`
  does it. `node_modules` is pruned after building: there are no runtime dependencies.

## Testing

`npm run selftest` covers everything that needs no network or credentials: extraction and
parsing of the three real PDFs in `fixtures/`, time fragments, clock detection, misprint repair
(real and synthetic), timezone helpers across both 2026 clock changes, scheduling rules, event
diffing, state, the lock and logging. 71 checks. `deploy.sh` runs it before touching cron.

`fixtures/` are real Al-Manar files, each kept for a quirk:
- `beirut-2026-10.pdf`: the Maghrib misprint on the 28th, the late clock change.
- `beirut-2026-03.pdf`: vertically offset cells that break line-based extraction; spring change.
- `saida-2026-09.pdf`: a date drawn as `2/9` + `/` + `2026`, a time as `19:0` + `0`.

`npm run times` is the quickest end-to-end check of the source side (network, no Google).
`npm run check` verifies credentials and calendar access. `npm run dry` is a full sync that
writes nothing.

## Environment notes

- Node 22 from NodeSource, as for Sluice (Ubuntu's apt Node is 18). `deploy.sh` writes the
  absolute node path into the cron line, so cron's minimal PATH does not matter.
- The whole-year PDFs appear in late December (24 December 2025 for 2026). December runs fail at
  1 January with HTTP 404 and retry nightly until then. Expected; do not "fix" it.
- Al-Manar's page showed Maghrib 18:48 on 25 September 2026 while the PDF says 18:50 (the PDF's
  trend is the smooth one). The page and the PDFs are not the same data; the PDFs are used.
- `.gitattributes` forces LF so `deploy.sh` runs on Linux when committed from Windows.
