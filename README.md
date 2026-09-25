# Muwaqqit

Keeps Beirut's prayer times in your Google Calendar. Every day gets three events, **Sobh**,
**Zuhr** and **Maghrib**, each with a popup reminder 5 minutes before, taken from
[Al-Manar's monthly prayer calendars](https://almanar.com.lb/salat/).

A *muwaqqit* (مُوَقِّت) was a mosque's timekeeper: the astronomer who worked out the prayer
times from the sun. This one reads the published timetable, checks it against the sun, fixes its
misprints, and keeps your calendar on time.

- **Takes no room.** Each event is a point in time with no duration: the reminder is the point.
- **Always 60 days ahead.** A run syncs today and the next 59 days, then schedules itself for
  local midnight 30 days later. There are always at least 30 days of events waiting.
- **Safe to re-run.** Events are matched by date and prayer: missing ones are created, ones moved
  or edited by hand are put back, duplicates are removed. Running it twice changes nothing.
- **Catches the calendar's own mistakes.** The published calendars contain misprints and switch
  to winter time on a different day than Lebanon does. Both are detected and handled (below),
  logged, and noted on the affected events.
- **No runtime dependencies.** Native `fetch` and a small built-in PDF reader. TypeScript is the
  only dev dependency. Cron starts a short-lived process; nothing stays in memory.

---

## How it works

### The source

Al-Manar's prayer page only shows today, and it is rendered on the server, so there is no API
to ask for other days. What the page does link is one PDF per month:

```
https://almanar.com.lb/static/calendars/{year}/beirut-{month}.pdf      (month without a leading zero)
```

Each is a Word-made table: date, weekday, and eight times (Imsak, Sobh, Sunrise, Zuhr, Asr,
Maghrib, Isha, Midnight). The whole year is published at once; the 2026 files appeared on
24 December 2025.

### Reading the PDFs

Ordinary text extraction (`pdftotext -layout`) misreads these tables: cells of one row sit up to
2pt apart vertically, which is enough to slide whole columns up or down a row. So the built-in
reader works from coordinates instead. It anchors each row on its date cell, gives every time to
the nearest row, and assigns columns by position. It also rejoins cells the PDF draws in pieces
(`1/10/` + `2026`, or even `2` + `2` + `:44`), and verifies the result: the right number of
dated rows in order, and every row's times in the right order, or the month is rejected with a
clear error rather than read wrongly.

This was validated against all 84 calendars of 2026 (every region, not just Beirut) and the
late-2025 ones.

### Which clock the calendar uses

Zuhr always sits within about a minute of solar noon, which is pure astronomy. Comparing the
two tells which UTC offset the calendar assumed on each day, independently of any DST rule.
Every time is then converted to an exact instant.

This matters: the 2026 calendar goes back to winter time on **Wednesday 28 October**, while
Lebanon's rule (and Google) switch on **Sunday 25 October**. Taking the printed times at face
value would put the 25th to 27th an hour late. Converted by the calendar's own offset, they land
at the right moment whichever date turns out to be right. For example Zuhr on 26 October, printed
12:22, appears at 11:22 on the Beirut clock. The log warns about the mismatch, and the affected
events say so in their description.

### Misprints

In absolute time, each prayer moves by at most about 2 minutes a day. A value far from its
neighbouring days is a misprint: it is replaced by the neighbouring days' trend, flagged with a
warning in the log, and explained on the event. For example 2026's Maghrib on 28 October is
printed `18:09` (an hour off; it is 17:09).

A blank cell is estimated the same way. If one prayer needs more than 4 corrections in a run,
something structural is wrong, and the run refuses to guess rather than invent a column.

### The sync

1. Download and read the months covering today to today + 59 days.
2. List the events this app created in its calendar. It only ever touches its own events: each
   carries a private tag, and it has no access to your other calendars at all.
3. Go day by day. For each prayer: create the event if missing; if it exists, compare the time,
   duration, title, description and reminder, and fix whatever differs. Stop at the first day that
   fails. A day counts as synced when all three of its events are right.

### Schedule and retries

| Situation | What happens next |
|---|---|
| Success | Next run at local midnight, 30 days later |
| A run fails | One retry, 5 minutes later |
| The retry fails too | Next try at the coming local midnight (with its own 5 minute retry) |
| The server was down when a run was due | It runs at the next hourly check |

The schedule lives in `state.json` as a single instant. Cron checks it every hour, and a check
that finds nothing due exits silently, so the schedule survives reboots and redeploys.

**Expect a December pause.** A run in December whose window reaches January finds the new
year's calendars missing until Al-Manar publishes them (24 December last time). It syncs
everything up to 31 December, stops at 1 January with "not published yet", and retries every
midnight until they appear. Nothing needs doing.

---

## Setup

### 1. Google Cloud: reuse the Sluice project

The Sluice project's OAuth client works as it is. The Google account that owns a Cloud project
does not need to be the account whose calendar is used: whoever signs in during `npm run auth`
is the account that gets the events.

In [console.cloud.google.com](https://console.cloud.google.com), with the Sluice project selected:

1. **APIs & Services -> Library -> "Google Calendar API" -> Enable.**
2. **Google Auth Platform -> Data Access -> Add or remove scopes**, tick
   `https://www.googleapis.com/auth/calendar.app.created` -> Update -> Save.
   If it is not in the list, paste it into "Manually add scopes".
3. **Audience:** confirm the publishing status is **In production**. It already is for Sluice.
   In *Testing*, refresh tokens die after 7 days.

That scope is the narrowest Google offers: it lets this tool create a calendar, then manage
events in the calendars it created. It cannot see or change anything else in the account. None of
this affects Sluice: its token keeps its own YouTube scope.

### 2. Authorize (on your own machine, it needs a browser)

```bash
npm install
cp .env.example .env      # paste GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, the same as Sluice's
npm run build
npm run auth
```

Sign in with **the Gmail account whose calendar should get the events**. You will see
*"Google hasn't verified this app"* (under the app name you gave the Sluice project). Click
**Advanced**, then **Go to ... (unsafe)**. That is expected for a personal app.

`npm run auth` creates a calendar named **Prayer Times** in that account, then saves the two
remaining values into `.env` itself, showing the token only masked:

```
Saved to .env:
  GOOGLE_REFRESH_TOKEN  1//0gA...x9Qw (103 characters)
  GOOGLE_CALENDAR_ID    ...@group.calendar.google.com
```

Then:

```bash
npm run check    # credentials, calendar access and the source, all verified
npm run times    # the next 60 days as they will be synced, with any corrections explained
npm run dry      # a full sync that writes nothing, logging what it would do
```

### 3. Deploy to the VPS

Node 22 is already installed there for Sluice. Then:

```bash
git clone https://github.com/IAtwi/Muwaqqit.git ~/muwaqqit && cd ~/muwaqqit
nano .env                 # the same four lines as your local .env
./deploy.sh
```

`deploy.sh` pulls, builds, runs the self test, installs the hourly cron entry, and on the first
deploy runs the first sync right away so you can watch it. The cron entry it adds is:

```cron
0 * * * * cd "/home/<you>/muwaqqit" && "/usr/bin/node" dist/main.js 2>&1 | /usr/bin/logger -t muwaqqit
```

Piping to `logger` sends the output to journald, which rotates itself. Without it cron tries to
email the output.

### 4. Notifications on your phone

The new calendar appears under **My calendars** in Google Calendar. In the Google Calendar app,
make sure **Prayer Times** is ticked in the calendar list (Android sometimes leaves new calendars
unsynced), and that the app is allowed to send notifications.

### Updating the server

```bash
cd ~/muwaqqit && ./deploy.sh
```

Cron never needs changing: it runs `dist/main.js`, which is rebuilt in place. `.env` and
`state.json` are gitignored, so a pull cannot overwrite them, and the schedule carries on.

---

## Logs

One file per local day, `logs/YYYY-MM-DD.log`, appended to by every run that day, plus the same
lines in journald. Files older than `logs.retentionDays` (400 days) are deleted automatically.
Times are shown in Beirut time with their UTC offset, whatever the server clock's timezone.

A typical scheduled run, 30 days after the previous one (shortened):

```
=== run started 2026-10-25 00:00:01 +02:00 | attempt 1 of 2 ===
00:00:01 INFO  window: 2026-10-25 to 2026-12-23 (60 days)
00:00:02 INFO  calendar October 2026: ok, 31 days
00:00:02 INFO  calendar November 2026: ok, 30 days
00:00:03 INFO  calendar December 2026: ok, 31 days
00:00:03 WARN  2026-10-25 to 2026-10-27: the calendar lists these days in UTC+03:00, but Asia/Beirut is on UTC+02:00 then. ...
00:00:03 WARN  2026-10-28 Maghrib: The calendar prints Maghrib as 18:09 on this day, far off the neighbouring days, ...
00:00:03 INFO  google calendar "Prayer Times": ok
00:00:04 INFO  found 93 existing event(s) from 2026-10-24 on
00:00:04 INFO  2026-11-24  created Sobh 05:01; created Zuhr 11:24; created Maghrib 16:50
   ... one line per day that changed ...
00:00:19 INFO  finished 2026-10-25 00:00:19 +02:00 in 18.2s: all good, 60/60 days synced (created 90, updated 0, unchanged 90, removed 0)
00:00:19 INFO  next run: 2026-11-24 00:00:00 +02:00 (in 30 days)
```

Days where nothing changed are not listed (set `logs.level` to `debug` to see them). A failed run
says where it stopped, why, and what happens next:

```
00:00:04 ERROR stopped at 2027-01-01: the January 2027 calendar is not published yet (HTTP 404 from https://...)
00:00:04 ERROR finished 2026-12-02 00:00:04 +02:00 in 3.2s: FAILED at 2027-01-01, 30/60 days synced (created 3, updated 0, unchanged 87, removed 0)
00:00:04 WARN  retrying in 5 minutes, at 00:05
```

Watching it:

```bash
npm run status                       # next run, last run, last success
journalctl -t muwaqqit -f           # live
less ~/muwaqqit/logs/$(date +%F).log
```

**Never open a log file in a text editor** while it may be written: an editor writes its whole
buffer back on save and silently drops anything appended since. Use `less`, `tail` or `journalctl`.

---

## Commands

| Command | Does |
|---|---|
| `npm start` | what cron runs: a sync only when one is due, otherwise exits silently |
| `npm run sync` | sync now, whatever the schedule, then reschedule as usual |
| `npm run dry` | a full sync that writes nothing and leaves the schedule alone |
| `npm run times` | print the next 60 days of times, with corrections explained (no Google access needed) |
| `npm run status` | next run, last run, last success |
| `npm run check` | verify credentials, calendar access and the source |
| `npm run auth` | one-time Google sign-in; prints the refresh token and creates the calendar |
| `npm run selftest` | offline checks against real calendars in `fixtures/` (73 checks) |
| `./deploy.sh` | the server install and update command |

Flags: `--now`, `--dry-run`, `--times`, `--status`, `--check`, `--help`.

## Configuration

Everything tunable is in **`src/config.ts`**: the prayers and their titles, event length,
reminder, window and rescheduling days, retry delay, timezone, source URL. Only the Google
credentials and the calendar id live in `.env`. Rebuild (`npm run build`, or `./deploy.sh` on the
server) after a change.

Adding a prayer (say Isha) is one line in `events.prayers`; the next run adds its events.
Removing one makes the next run delete its future events.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `invalid_grant` | The refresh token was revoked, or the consent screen is in *Testing*. Run `npm run auth` again and update `GOOGLE_REFRESH_TOKEN`. |
| "Google Calendar API is not enabled" | Step 1.1 of the setup. |
| "calendar ... was not found" | The Prayer Times calendar was deleted. Remove `GOOGLE_CALENDAR_ID` from `.env` and run `npm run auth` to create a new one. |
| "not published yet (HTTP 404)" in December | Expected, see *Expect a December pause*. |
| "The layout may have changed" | Al-Manar changed the PDF format. The reader refuses to guess. Look at the PDF, adjust `src/core/calendar.ts`, and add the file to `fixtures/` with a test. |
| "refusing to guess" | Many values of one prayer looked wrong in one run. Check `npm run times` against the PDF. |
| No phone notifications | The calendar is not enabled in the Google Calendar app, or its notifications are off. |
| "Another run is in progress" | A run (possibly waiting to retry) holds `.run.lock`. It clears itself; a lock left by a killed process is taken over automatically. |
| `node: command not found` in cron | The cron line uses the absolute path `deploy.sh` found. Re-run `./deploy.sh` after reinstalling Node, and fix the path with `crontab -e` if it moved. |
