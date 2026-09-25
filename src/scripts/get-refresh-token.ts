import { createServer } from 'node:http';
import { CONFIG } from '../config.js';
import { requireEnv } from '../core/env.js';
import { CALENDAR_SCOPE, createCalendar, getCalendar, setAccessToken } from '../core/google.js';
import { message } from '../core/http.js';

/**
 * One-time local OAuth flow. Run this on your own machine (it needs a browser), not the VPS.
 * Prints GOOGLE_REFRESH_TOKEN, and GOOGLE_CALENDAR_ID for a calendar it creates.
 *
 * The calendar is created here rather than by the sync because the narrow scope used
 * (calendar.app.created) cannot list calendars, so there would be no way to find it again
 * after a lost state file. Its id lives in .env instead, next to the token.
 */
const PORT = 8888;
const REDIRECT_URI = `http://localhost:${PORT}`;

const clientId = requireEnv('GOOGLE_CLIENT_ID');
const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET');

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    // Both are required to be handed a refresh token rather than only an access token.
    access_type: 'offline',
    prompt: 'consent select_account',
  }).toString();

console.log('\n1. Open this URL and approve access:\n');
console.log(authUrl);
console.log('\n   Choose the Google account whose calendar should get the prayer events.');
console.log('   You will see a "Google hasn\'t verified this app" screen. Click Advanced, then');
console.log('   "Go to ... (unsafe)". That is expected for a personal app.');
console.log(`\n2. Waiting for the redirect on ${REDIRECT_URI} ...\n`);

async function calendarLines(accessToken: string): Promise<string[]> {
  setAccessToken(accessToken);
  const existing = process.env.GOOGLE_CALENDAR_ID;
  if (existing) {
    const found = await getCalendar(existing);
    if (found) {
      console.log(`Keeping the existing calendar "${found.summary ?? existing}" from .env.`);
      return [];
    }
    console.log(`GOOGLE_CALENDAR_ID in .env (${existing}) is not reachable with this account; creating a new calendar.`);
  }
  const created = await createCalendar(
    CONFIG.events.calendarName,
    `${CONFIG.source.label} prayer times from Al-Manar's monthly calendars, kept in sync automatically.`,
  );
  console.log(`Created the calendar "${created.summary ?? CONFIG.events.calendarName}".`);
  return [`GOOGLE_CALENDAR_ID=${created.id}`];
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', REDIRECT_URI);
    if (url.pathname === '/favicon.ico') {
      res.statusCode = 404;
      res.end();
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      res.end(`Muwaqqit: authorization failed (${error}). You can close this tab.`);
      console.error(`\nAuthorization failed: ${error}\n`);
      server.close();
      process.exitCode = 1;
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.statusCode = 400;
      res.end('Muwaqqit: no authorization code in the request.');
      return;
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });

      const json = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        scope?: string;
        error?: string;
      };

      if (!tokenRes.ok || !json.refresh_token || !json.access_token) {
        res.end('Muwaqqit: token exchange failed. Check the terminal.');
        console.error('\nToken exchange failed:', JSON.stringify(json, null, 2));
        console.error(
          '\nIf refresh_token is missing, remove the app at https://myaccount.google.com/permissions ' +
            'and run `npm run auth` again.\n',
        );
        process.exitCode = 1;
        return;
      }
      if (!json.scope?.split(' ').includes(CALENDAR_SCOPE)) {
        res.end('Muwaqqit: the calendar permission was not granted. Check the terminal.');
        console.error('\nThe calendar permission was not granted (was its checkbox left unticked?). Run `npm run auth` again.\n');
        process.exitCode = 1;
        return;
      }

      res.end('Muwaqqit: authorization complete. You can close this tab.');
      console.log('Authorized.');
      // The token first: if the calendar step fails, the token is still usable.
      const lines = [`GOOGLE_REFRESH_TOKEN=${json.refresh_token}`];
      try {
        lines.push(...(await calendarLines(json.access_token)));
      } catch (err) {
        console.error(`\nCould not set up the calendar: ${message(err)}`);
        console.error('Fix that, then run `npm run auth` again.');
        process.exitCode = 1;
      }
      console.log('\n=== add these lines to .env (replace any older values) ===\n');
      for (const l of lines) console.log(l);
      console.log('\nThen run `npm run check`.\n');
    } catch (err) {
      res.end('Muwaqqit: something failed. Check the terminal.');
      console.error('\nError:', message(err));
      process.exitCode = 1;
    } finally {
      server.close();
      setTimeout(() => process.exit(process.exitCode ?? 0), 250);
    }
  })();
});

server.listen(PORT);
