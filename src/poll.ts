/**
 * Device-flow poll pacing.
 *
 * Pure on purpose: the loop that sleeps lives in the login command, and this
 * decides only how long to sleep next. The server enforces the interval itself
 * (`recordPoll` rejects anything faster than `interval - 1s` with a 429 and a
 * `Retry-After`), so being wrong here is not a security problem, but it is the
 * difference between a login that completes and one that spends its ten minutes
 * being told to slow down.
 */

/** What the API advertises today. Overridden by whatever the session returns. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export const MIN_POLL_INTERVAL_SECONDS = 1;
export const MAX_POLL_INTERVAL_SECONDS = 60;

/**
 * RFC 8628 section 3.5: on `slow_down` the client increases the interval by 5
 * seconds. The API is camelCase rather than RFC-shaped on the wire but the
 * backoff behaviour is the part worth keeping.
 */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

export interface PollAdvice {
  /** How long to wait before the next poll. */
  delaySeconds: number;
  /** The interval to carry into the next round. */
  intervalSeconds: number;
}

export type PollSignal =
  | { status: 'PENDING'; interval: number | null }
  | { status: 'SLOW_DOWN'; interval: number | null; retryAfterSeconds: number | null };

function clamp(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_POLL_INTERVAL_SECONDS;
  return Math.min(MAX_POLL_INTERVAL_SECONDS, Math.max(MIN_POLL_INTERVAL_SECONDS, Math.ceil(seconds)));
}

/**
 * Given the interval in force and what the server just said, decide the sleep
 * and the next interval.
 *
 * PENDING adopts a server-supplied interval verbatim, including a smaller one:
 * the server knows its own rate limit and lowering the interval is its call to
 * make, not ours.
 *
 * SLOW_DOWN never lowers the interval and always adds the RFC increment, then
 * sleeps for at least `Retry-After`. Honouring only `Retry-After` would leave
 * the interval unchanged and walk straight into another 429; honouring only the
 * increment would ignore an explicit instruction from the server.
 */
export function advancePoll(currentIntervalSeconds: number, signal: PollSignal): PollAdvice {
  const current = clamp(currentIntervalSeconds);

  if (signal.status === 'PENDING') {
    const interval = signal.interval === null ? current : clamp(signal.interval);
    return { delaySeconds: interval, intervalSeconds: interval };
  }

  const advertised = signal.interval === null ? current : clamp(signal.interval);
  const intervalSeconds = clamp(Math.max(current, advertised) + SLOW_DOWN_INCREMENT_SECONDS);
  const retryAfter = signal.retryAfterSeconds === null ? 0 : Math.max(0, Math.ceil(signal.retryAfterSeconds));

  return { delaySeconds: Math.max(intervalSeconds, retryAfter), intervalSeconds };
}

/**
 * Deliberately does not `unref` the timer. During a device-code login the sleep
 * is often the only thing on the event loop, and an unref'd timer would let the
 * process exit mid-poll with no output at all.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
