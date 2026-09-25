import { CONFIG } from '../config.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Options {
  /** Overrides CONFIG.http.retries. */
  retries?: number;
  /**
   * False for requests that must not run twice, like creating an event. Those are only
   * retried when the server says it rejected them unprocessed (429, or Google's 403 rate
   * limit), never after a 5xx or a network failure, where the first attempt may have landed.
   */
  idempotent?: boolean;
}

/** Google reports quota exhaustion as 403 with one of these reasons, not only as 429. */
function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  return status === 403 && /"reason"\s*:\s*"(rateLimitExceeded|userRateLimitExceeded)"/.test(body);
}

/**
 * fetch with a timeout and bounded retries. Retries only transient conditions
 * (network failure, 5xx, rate limits). Never retries any other 4xx.
 */
export async function request(url: string, init: RequestInit = {}, opts: Options = {}): Promise<Response> {
  const retries = opts.retries ?? CONFIG.http.retries;
  const idempotent = opts.idempotent ?? true;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(CONFIG.http.retryDelayMs * 2 ** (attempt - 1));

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(CONFIG.http.timeoutMs),
        headers: { 'User-Agent': CONFIG.http.userAgent, ...(init.headers ?? {}) },
      });
    } catch (err) {
      lastError = err;
      if (!idempotent) break;
      continue;
    }

    if (res.status >= 500 || res.status === 429 || res.status === 403) {
      const body = await res.text().catch(() => '');
      const limited = isRateLimited(res.status, body);
      if (res.status === 403 && !limited) {
        // An ordinary 403 (permission) is final. Hand the body back to the caller intact.
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      lastError = new HttpError(res.status, body, `HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`);
      if (!idempotent && !limited) break;
      continue;
    }
    return res;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function requestJson<T>(url: string, init: RequestInit = {}, opts: Options = {}): Promise<T> {
  const res = await request(url, init, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, text, `HTTP ${res.status} from ${url}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** A readable one-liner for any error, for logs. */
export function message(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    // fetch hides the useful part ("ENOTFOUND", "ECONNRESET") in the cause.
    if (cause instanceof Error && err.message === 'fetch failed') return `fetch failed: ${cause.message}`;
    if (err.name === 'TimeoutError') return `timed out after ${CONFIG.http.timeoutMs / 1000}s`;
    return err.message;
  }
  return String(err);
}
