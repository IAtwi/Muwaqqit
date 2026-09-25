import { CONFIG } from '../config.js';
import type { ApiEvent, EventBody } from './google.js';
import { isoLocal, localClock } from './time.js';
import { PRAYER_NAMES, type PrayerKey, type PrayerTime } from './types.js';

/**
 * The event a prayer should have, and the comparison against what the calendar holds.
 * Pure functions, so the selftest covers them without touching Google.
 */

export const SOURCE_PAGE = 'https://almanar.com.lb/salat/';

function prayerConfig(key: PrayerKey): { title: string; arabic: string } {
  const found = CONFIG.events.prayers.find((p) => p.key === key);
  return found ?? { title: `${PRAYER_NAMES[key]} prayer time`, arabic: '' };
}

export function eventKey(date: string, prayer: string): string {
  return `${date}|${prayer}`;
}

export function desiredEvent(p: PrayerTime): EventBody {
  const { title, arabic } = prayerConfig(p.prayer);
  const end = new Date(p.at.getTime() + CONFIG.events.durationMinutes * 60_000);
  const lines = [
    `${arabic ? `${arabic} - ` : ''}${CONFIG.source.label}, ${p.date}`,
    `Source: Al-Manar monthly prayer calendar (${SOURCE_PAGE})`,
  ];
  if (p.note) lines.push('', `Note: ${p.note}`);
  return {
    summary: title,
    description: lines.join('\n'),
    start: { dateTime: isoLocal(p.at), timeZone: CONFIG.timezone },
    end: { dateTime: isoLocal(end), timeZone: CONFIG.timezone },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: CONFIG.events.reminderMinutes }] },
    extendedProperties: { private: { app: CONFIG.events.appTag, date: p.date, prayer: p.prayer } },
    source: { title: 'Al-Manar prayer times', url: SOURCE_PAGE },
  };
}

function instant(t: { dateTime?: string } | undefined): number {
  return t?.dateTime ? Date.parse(t.dateTime) : NaN;
}

export interface Difference {
  field: 'time' | 'duration' | 'title' | 'description' | 'reminder';
  /** Human readable, e.g. "time 18:09 -> 17:09". */
  text: string;
}

/**
 * What differs between an existing event and the desired one. Times compare as instants,
 * so "12:22+03:00" and "11:22+02:00" are rightly treated as the same moment.
 */
export function differences(existing: ApiEvent, desired: EventBody): Difference[] {
  const out: Difference[] = [];
  const startWas = instant(existing.start);
  const startNow = instant(desired.start);
  if (startWas !== startNow) {
    const was = Number.isNaN(startWas) ? 'none' : localClock(new Date(startWas));
    out.push({ field: 'time', text: `time ${was} -> ${localClock(new Date(startNow))}` });
  } else if (instant(existing.end) !== instant(desired.end)) {
    out.push({ field: 'duration', text: 'duration' });
  }
  if ((existing.summary ?? '') !== desired.summary) {
    out.push({ field: 'title', text: `title "${existing.summary ?? ''}" -> "${desired.summary}"` });
  }
  if ((existing.description ?? '') !== desired.description) {
    out.push({ field: 'description', text: 'description' });
  }
  const want = desired.reminders.overrides;
  const have = existing.reminders?.overrides ?? [];
  const sameReminders =
    existing.reminders?.useDefault === false &&
    have.length === want.length &&
    want.every((w) => have.some((h) => h.method === w.method && h.minutes === w.minutes));
  if (!sameReminders) out.push({ field: 'reminder', text: 'reminder' });
  return out;
}

/** The fields a PATCH sends to bring an event back in line. */
export function patchBody(desired: EventBody): Partial<EventBody> {
  const { summary, description, start, end, reminders, source } = desired;
  return { summary, description, start, end, reminders, ...(source ? { source } : {}) };
}
