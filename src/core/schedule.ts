import { CONFIG } from '../config.js';
import { addDays, localDate, localMidnight } from './time.js';

/**
 * The run schedule. Every run is at local midnight except the single quick retry, and all of
 * it is stored as one instant (state.nextRunAt) that cron checks hourly. So the schedule
 * survives reboots and redeploys, and a run missed while the server was down happens at the
 * next hourly check.
 */

/** After a successful run: local midnight, CONFIG.sync.rescheduleDays days from now. */
export function nextAfterSuccess(now: Date): Date {
  return localMidnight(addDays(localDate(now), CONFIG.sync.rescheduleDays));
}

/** After the retry has failed too: the coming local midnight. */
export function nextAfterFailure(now: Date): Date {
  return localMidnight(addDays(localDate(now), 1));
}

/** When the single retry of a failed run happens. */
export function retryAt(now: Date): Date {
  return new Date(now.getTime() + CONFIG.sync.retryMinutes * 60_000);
}

export function isDue(nextRunAt: string | undefined, now: Date): boolean {
  if (!nextRunAt) return true;
  const at = Date.parse(nextRunAt);
  return Number.isNaN(at) || now.getTime() >= at;
}
