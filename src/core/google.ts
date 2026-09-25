import { CONFIG } from '../config.js';
import { requireEnv } from './env.js';
import { HttpError, requestJson } from './http.js';

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * The only scope requested. It lets this tool create calendars and manage events on the
 * calendars it created, and nothing else: it cannot even see the rest of the account.
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

/** One token exchange per process. Access tokens last an hour; a run takes seconds. */
let cachedAccessToken: string | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;

  const body = new URLSearchParams({
    client_id: requireEnv('GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
    refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });

  try {
    const json = await requestJson<{ access_token: string }>(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    cachedAccessToken = json.access_token;
    return json.access_token;
  } catch (err) {
    if (err instanceof HttpError && err.body.includes('invalid_grant')) {
      throw new Error(
        'Refresh token rejected (invalid_grant): it was revoked, or the OAuth consent screen is in "Testing" ' +
          'mode where tokens expire after 7 days. Run `npm run auth` again (on a machine with a browser) and ' +
          'put the new GOOGLE_REFRESH_TOKEN in .env.',
      );
    }
    throw err;
  }
}

export function setAccessToken(token: string): void {
  cachedAccessToken = token;
}

async function authHeaders(json = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await getAccessToken()}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

/** Turns Google's most common failures into something actionable. */
function explain(err: unknown): never {
  if (err instanceof HttpError) {
    if (err.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used/.test(err.body)) {
      throw new Error(
        'The Google Calendar API is not enabled for this Google Cloud project. Enable it under ' +
          'APIs & Services -> Library -> "Google Calendar API", then try again.',
      );
    }
    if (err.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(err.body)) {
      throw new Error(
        'The refresh token does not carry the calendar scope. Run `npm run auth` again and update ' +
          'GOOGLE_REFRESH_TOKEN in .env.',
      );
    }
  }
  throw err;
}

export interface EventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface Reminder {
  method: string;
  minutes: number;
}

export interface ApiEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: EventTime;
  end?: EventTime;
  reminders?: { useDefault?: boolean; overrides?: Reminder[] };
  extendedProperties?: { private?: Record<string, string> };
}

export interface EventBody {
  summary: string;
  description: string;
  start: EventTime;
  end: EventTime;
  reminders: { useDefault: boolean; overrides: Reminder[] };
  extendedProperties?: { private: Record<string, string> };
  source?: { title: string; url: string };
}

export interface CalendarInfo {
  id: string;
  summary?: string;
  timeZone?: string;
}

/** null when the calendar does not exist or is not one this app created. */
export async function getCalendar(calendarId: string): Promise<CalendarInfo | null> {
  try {
    return await requestJson<CalendarInfo>(`${API}/calendars/${encodeURIComponent(calendarId)}`, {
      headers: await authHeaders(),
    });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return null;
    // With calendar.app.created, a calendar the app did not create reads as forbidden.
    if (err instanceof HttpError && err.status === 403 && !/accessNotConfigured|SERVICE_DISABLED/.test(err.body)) {
      return null;
    }
    return explain(err);
  }
}

export async function createCalendar(summary: string, description: string): Promise<CalendarInfo> {
  try {
    return await requestJson<CalendarInfo>(
      `${API}/calendars`,
      {
        method: 'POST',
        headers: await authHeaders(true),
        body: JSON.stringify({ summary, description, timeZone: CONFIG.timezone }),
      },
      { idempotent: false },
    );
  } catch (err) {
    return explain(err);
  }
}

/**
 * Every event this app created whose end is after `from`, by the private property it stamps
 * on them. Deleted events are excluded, so an event removed by hand is simply recreated.
 */
export async function listAppEvents(calendarId: string, from: Date): Promise<ApiEvent[]> {
  const out: ApiEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      privateExtendedProperty: `app=${CONFIG.events.appTag}`,
      timeMin: from.toISOString(),
      singleEvents: 'true',
      showDeleted: 'false',
      maxResults: '2500',
      timeZone: CONFIG.timezone,
    });
    if (pageToken) params.set('pageToken', pageToken);
    try {
      const json = await requestJson<{ items?: ApiEvent[]; nextPageToken?: string }>(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        { headers: await authHeaders() },
      );
      out.push(...(json.items ?? []));
      pageToken = json.nextPageToken;
    } catch (err) {
      return explain(err);
    }
  } while (pageToken);
  return out;
}

/** Never blindly retried: a retry after a lost response could create a duplicate. */
export async function insertEvent(calendarId: string, body: EventBody): Promise<ApiEvent> {
  try {
    return await requestJson<ApiEvent>(
      `${API}/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: 'POST', headers: await authHeaders(true), body: JSON.stringify(body) },
      { idempotent: false },
    );
  } catch (err) {
    return explain(err);
  }
}

export async function patchEvent(calendarId: string, eventId: string, body: Partial<EventBody>): Promise<ApiEvent> {
  try {
    return await requestJson<ApiEvent>(
      `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'PATCH', headers: await authHeaders(true), body: JSON.stringify(body) },
    );
  } catch (err) {
    return explain(err);
  }
}

/** Already gone counts as done. */
export async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  try {
    await requestJson(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
    explain(err);
  }
}
