import { describe, expect, it } from 'vitest';
import {
  advancePoll,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  SLOW_DOWN_INCREMENT_SECONDS,
  sleep,
} from '../src/poll.js';

/**
 * Device-flow backoff.
 *
 * The API enforces the interval itself (anything faster than `interval - 1s`
 * gets a 429 with Retry-After) and force-expires a session after 200 polls, so
 * a client that ignores SLOW_DOWN does not just get rate limited, it burns the
 * user's login attempt.
 */

describe('advancePoll on PENDING', () => {
  it('keeps the current interval when the server does not name one', () => {
    expect(advancePoll(5, { status: 'PENDING', interval: null })).toEqual({
      delaySeconds: 5,
      intervalSeconds: 5,
    });
  });

  it('adopts the server interval verbatim', () => {
    expect(advancePoll(5, { status: 'PENDING', interval: 8 })).toEqual({
      delaySeconds: 8,
      intervalSeconds: 8,
    });
  });

  it('adopts a SMALLER server interval, because the server owns its rate limit', () => {
    expect(advancePoll(10, { status: 'PENDING', interval: 3 })).toEqual({
      delaySeconds: 3,
      intervalSeconds: 3,
    });
  });

  it('does not creep upward while the server keeps saying PENDING', () => {
    let interval = DEFAULT_POLL_INTERVAL_SECONDS;
    for (let i = 0; i < 20; i += 1) {
      interval = advancePoll(interval, { status: 'PENDING', interval: 5 }).intervalSeconds;
    }
    // 20 polls at a steady 5s is the normal case: a human reading a code and
    // clicking Approve. It must not have backed off.
    expect(interval).toBe(5);
  });
});

describe('advancePoll on SLOW_DOWN', () => {
  it('adds the RFC 8628 increment', () => {
    const advice = advancePoll(5, { status: 'SLOW_DOWN', interval: null, retryAfterSeconds: null });
    expect(advice.intervalSeconds).toBe(5 + SLOW_DOWN_INCREMENT_SECONDS);
  });

  it('never lowers the interval, even when the server advertises a smaller one', () => {
    const advice = advancePoll(20, { status: 'SLOW_DOWN', interval: 5, retryAfterSeconds: null });
    expect(advice.intervalSeconds).toBe(25);
  });

  it('waits at least Retry-After', () => {
    const advice = advancePoll(5, { status: 'SLOW_DOWN', interval: 5, retryAfterSeconds: 30 });
    expect(advice.delaySeconds).toBeGreaterThanOrEqual(30);
  });

  it('sleeps the new interval when it is longer than Retry-After', () => {
    // Honouring Retry-After alone would leave the interval unchanged and walk
    // straight into the next 429.
    const advice = advancePoll(30, { status: 'SLOW_DOWN', interval: null, retryAfterSeconds: 2 });
    expect(advice.intervalSeconds).toBe(35);
    expect(advice.delaySeconds).toBe(35);
  });

  it('rounds a fractional Retry-After up, never down', () => {
    const advice = advancePoll(5, { status: 'SLOW_DOWN', interval: null, retryAfterSeconds: 12.2 });
    expect(advice.delaySeconds).toBe(13);
  });

  it('ignores a negative Retry-After', () => {
    const advice = advancePoll(5, { status: 'SLOW_DOWN', interval: null, retryAfterSeconds: -5 });
    expect(advice.delaySeconds).toBe(10);
  });

  it('backs off monotonically under repeated SLOW_DOWN', () => {
    const seen: number[] = [];
    let interval = 5;
    for (let i = 0; i < 6; i += 1) {
      interval = advancePoll(interval, {
        status: 'SLOW_DOWN',
        interval: null,
        retryAfterSeconds: null,
      }).intervalSeconds;
      seen.push(interval);
    }
    expect(seen).toEqual([10, 15, 20, 25, 30, 35]);
  });

  it('stops climbing at the ceiling instead of running away', () => {
    let interval = 5;
    for (let i = 0; i < 50; i += 1) {
      interval = advancePoll(interval, {
        status: 'SLOW_DOWN',
        interval: null,
        retryAfterSeconds: null,
      }).intervalSeconds;
    }
    expect(interval).toBe(MAX_POLL_INTERVAL_SECONDS);
  });
});

describe('advancePoll input hygiene', () => {
  it('clamps a nonsense current interval to the floor', () => {
    expect(advancePoll(0, { status: 'PENDING', interval: null }).intervalSeconds).toBe(
      MIN_POLL_INTERVAL_SECONDS,
    );
    expect(advancePoll(-10, { status: 'PENDING', interval: null }).intervalSeconds).toBe(
      MIN_POLL_INTERVAL_SECONDS,
    );
  });

  it('falls back to the default when the current interval is not a number', () => {
    expect(advancePoll(Number.NaN, { status: 'PENDING', interval: null }).intervalSeconds).toBe(
      DEFAULT_POLL_INTERVAL_SECONDS,
    );
  });

  it('clamps an absurd server interval to the ceiling', () => {
    expect(advancePoll(5, { status: 'PENDING', interval: 100_000 }).intervalSeconds).toBe(
      MAX_POLL_INTERVAL_SECONDS,
    );
  });

  it('never returns a delay below one second', () => {
    const advice = advancePoll(1, { status: 'PENDING', interval: 0 });
    expect(advice.delaySeconds).toBeGreaterThanOrEqual(MIN_POLL_INTERVAL_SECONDS);
  });

  it('stays inside the API session budget at the default interval', () => {
    // The API force-expires after 200 polls and the session lives 600s.
    // Polling every 5s is 120 polls, comfortably under.
    expect(600 / DEFAULT_POLL_INTERVAL_SECONDS).toBeLessThan(200);
  });
});

describe('sleep', () => {
  it('resolves', async () => {
    // Must NOT unref its timer: during a device login the sleep is often the
    // only thing on the event loop, and an unref'd timer would let the process
    // exit mid-poll.
    const started = Date.now();
    await sleep(10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });
});
