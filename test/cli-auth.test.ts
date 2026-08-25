import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeviceSession,
  createLoopbackSession,
  exchangeToken,
  refreshCliToken,
} from '../src/cli-auth.js';
import { ApiError } from '../src/api.js';

/**
 * Every documented outcome of the CLI auth endpoints.
 *
 * `fetch` is stubbed for the whole file. Nothing here touches the network, and
 * a test that forgot to stub would fail on the assertion that a call was
 * recorded rather than quietly hitting production.
 */

const BASE = 'https://api.example.test';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let calls: Recorded[] = [];

function stubFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>): void {
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const spec = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (spec === undefined) throw new Error('no stubbed response');

      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });

      const text = spec.body === undefined ? '' : JSON.stringify(spec.body);
      return new Response(text === '' ? null : text, {
        status: spec.status,
        headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) },
      });
    }),
  );
}

const CLIENT = {
  clientName: 'goalslot-cli',
  clientVersion: '0.1.0',
  deviceLabel: 'TEST-HOST',
  platform: 'linux-x64',
};

const TOKENS = {
  tokenType: 'Bearer',
  accessToken: 'jwt.access.token',
  expiresIn: 3600,
  refreshToken: 'gsl_rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  refreshTokenExpiresAt: '2026-11-23T10:00:00.000Z',
  tokenId: 'token-uuid',
  scopes: ['full'],
  user: { id: 'user-uuid', email: 'zeeshan@example.test', name: 'Zeeshan' },
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLoopbackSession', () => {
  it('sends the API wire format, camelCase and S256', async () => {
    stubFetch([
      {
        status: 201,
        body: {
          sessionId: 'session-uuid',
          sessionSecret: 'gsl_ss_secret',
          approvalUrl: 'https://www.goalslot.io/cli/authorize?session=session-uuid',
          expiresIn: 600,
        },
      },
    ]);

    const session = await createLoopbackSession(BASE, {
      ...CLIENT,
      redirectUri: 'http://127.0.0.1:53412/callback',
      state: 'state-value',
      codeChallenge: 'challenge',
    });

    expect(session.sessionId).toBe('session-uuid');
    expect(session.sessionSecret).toBe('gsl_ss_secret');

    const [call] = calls;
    expect(call?.url).toBe(`${BASE}/api/auth/cli/session`);
    expect(call?.method).toBe('POST');
    expect(call?.body).toMatchObject({
      mode: 'LOOPBACK',
      redirectUri: 'http://127.0.0.1:53412/callback',
      state: 'state-value',
      codeChallenge: 'challenge',
      // Plain PKCE is never offered; the API only accepts S256.
      codeChallengeMethod: 'S256',
      scopes: ['full'],
      clientName: 'goalslot-cli',
    });
  });

  it('turns a 400 into an ApiError carrying the API message', async () => {
    stubFetch([{ status: 400, body: { message: 'Invalid redirectUri' } }]);

    await expect(
      createLoopbackSession(BASE, {
        ...CLIENT,
        redirectUri: 'http://evil.com/callback',
        state: 's'.repeat(16),
        codeChallenge: 'challenge',
      }),
    ).rejects.toThrow('Invalid redirectUri');
  });

  it('surfaces the 429 throttle', async () => {
    stubFetch([{ status: 429, body: { message: 'ThrottlerException: Too Many Requests' } }]);

    const error = await createLoopbackSession(BASE, {
      ...CLIENT,
      redirectUri: 'http://127.0.0.1:53412/callback',
      state: 'state-value',
      codeChallenge: 'challenge',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
  });
});

describe('createDeviceSession', () => {
  it('does not send a redirectUri or state', async () => {
    stubFetch([
      {
        status: 201,
        body: {
          sessionId: 'session-uuid',
          sessionSecret: 'gsl_ss_secret',
          userCode: 'BXKQ-7TDM',
          verificationUri: 'https://www.goalslot.io/cli/authorize',
          verificationUriComplete:
            'https://www.goalslot.io/cli/authorize?user_code=BXKQ-7TDM',
          expiresIn: 600,
          interval: 5,
        },
      },
    ]);

    const session = await createDeviceSession(BASE, { ...CLIENT, codeChallenge: 'challenge' });

    expect(session.userCode).toBe('BXKQ-7TDM');
    expect(session.interval).toBe(5);
    expect(calls[0]?.body).toMatchObject({ mode: 'DEVICE' });
    expect(calls[0]?.body).not.toHaveProperty('redirectUri');
    expect(calls[0]?.body).not.toHaveProperty('state');
  });

  it('reconstructs verificationUriComplete when the API omits it', async () => {
    stubFetch([
      {
        status: 201,
        body: {
          sessionId: 'session-uuid',
          sessionSecret: 'gsl_ss_secret',
          userCode: 'BXKQ-7TDM',
          verificationUri: 'https://www.goalslot.io/cli/authorize',
          expiresIn: 600,
          interval: 5,
        },
      },
    ]);

    const session = await createDeviceSession(BASE, { ...CLIENT, codeChallenge: 'challenge' });
    // snake_case on purpose: it matches the API and it is a URL a human pastes.
    expect(session.verificationUriComplete).toBe(
      'https://www.goalslot.io/cli/authorize?user_code=BXKQ-7TDM',
    );
  });
});

describe('exchangeToken: every POST /token status code', () => {
  const input = {
    sessionId: 'session-uuid',
    sessionSecret: 'gsl_ss_secret',
    codeVerifier: 'verifier',
  };

  it('200 returns the tokens', async () => {
    stubFetch([{ status: 200, body: TOKENS }]);
    const result = await exchangeToken(BASE, { ...input, authorizationCode: 'gsl_ac_code' });

    expect(result.status).toBe('TOKENS');
    if (result.status !== 'TOKENS') throw new Error('unreachable');
    expect(result.tokens.refreshToken).toBe(TOKENS.refreshToken);
    expect(result.tokens.user.email).toBe('zeeshan@example.test');
  });

  it('202 is PENDING and is NOT an error', async () => {
    // The API returns 202 rather than RFC 8628's 400 authorization_pending
    // precisely so the normal case is not a 4xx. Treating it as one here would
    // undo that.
    stubFetch([{ status: 202, body: { status: 'PENDING', interval: 5 } }]);
    const result = await exchangeToken(BASE, input);

    expect(result).toEqual({ status: 'PENDING', interval: 5 });
  });

  it('403 is DENIED', async () => {
    stubFetch([{ status: 403, body: { status: 'DENIED', message: 'The authorization request was denied' } }]);
    expect(await exchangeToken(BASE, input)).toEqual({ status: 'DENIED' });
  });

  it('410 is EXPIRED', async () => {
    stubFetch([{ status: 410, body: { status: 'EXPIRED', message: 'This authorization request has expired' } }]);
    expect(await exchangeToken(BASE, input)).toEqual({ status: 'EXPIRED' });
  });

  it('410 also covers an already-consumed session', async () => {
    stubFetch([{ status: 410, body: { status: 'EXPIRED', message: 'already been used' } }]);
    expect(await exchangeToken(BASE, input)).toEqual({ status: 'EXPIRED' });
  });

  it('429 is SLOW_DOWN and carries Retry-After', async () => {
    stubFetch([
      {
        status: 429,
        body: { status: 'SLOW_DOWN', interval: 5 },
        headers: { 'retry-after': '5' },
      },
    ]);

    expect(await exchangeToken(BASE, input)).toEqual({
      status: 'SLOW_DOWN',
      interval: 5,
      retryAfterSeconds: 5,
    });
  });

  it('429 without a Retry-After header still parses', async () => {
    stubFetch([{ status: 429, body: { status: 'SLOW_DOWN', interval: 5 } }]);
    expect(await exchangeToken(BASE, input)).toEqual({
      status: 'SLOW_DOWN',
      interval: 5,
      retryAfterSeconds: null,
    });
  });

  it('401 throws, because no amount of retrying fixes a bad secret or PKCE', async () => {
    stubFetch([{ status: 401, body: { message: 'PKCE verification failed' } }]);

    const error = await exchangeToken(BASE, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('PKCE verification failed');
  });

  it('500 throws rather than being mistaken for a poll signal', async () => {
    stubFetch([{ status: 500, body: { message: 'Internal server error' } }]);
    await expect(exchangeToken(BASE, input)).rejects.toBeInstanceOf(ApiError);
  });

  it('omits authorizationCode entirely when polling in device mode', async () => {
    stubFetch([{ status: 202, body: { status: 'PENDING', interval: 5 } }]);
    await exchangeToken(BASE, input);

    expect(calls[0]?.body).not.toHaveProperty('authorizationCode');
    expect(calls[0]?.body).toMatchObject({
      sessionId: 'session-uuid',
      sessionSecret: 'gsl_ss_secret',
      codeVerifier: 'verifier',
    });
  });

  it('sends the authorization code on the loopback exchange', async () => {
    stubFetch([{ status: 200, body: TOKENS }]);
    await exchangeToken(BASE, { ...input, authorizationCode: 'gsl_ac_code' });
    expect(calls[0]?.body).toMatchObject({ authorizationCode: 'gsl_ac_code' });
  });

  it('never puts the session secret in the URL', async () => {
    stubFetch([{ status: 200, body: TOKENS }]);
    await exchangeToken(BASE, { ...input, authorizationCode: 'gsl_ac_code' });
    expect(calls[0]?.url).toBe(`${BASE}/api/auth/cli/token`);
    expect(calls[0]?.url).not.toContain('gsl_ss_');
  });
});

describe('refreshCliToken rotation', () => {
  it('returns a token pair whose refresh token differs from the one sent', async () => {
    const rotated = { ...TOKENS, refreshToken: 'gsl_rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    stubFetch([{ status: 200, body: rotated }]);

    const result = await refreshCliToken(BASE, TOKENS.refreshToken);

    expect(result.refreshToken).toBe(rotated.refreshToken);
    expect(result.refreshToken).not.toBe(TOKENS.refreshToken);
    expect(calls[0]?.url).toBe(`${BASE}/api/auth/cli/token/refresh`);
    expect(calls[0]?.body).toEqual({ refreshToken: TOKENS.refreshToken });
  });

  it('surfaces a revoked credential as a 401', async () => {
    // The API answers the same way for an explicitly revoked token and for one
    // it revoked itself after detecting a replay (REUSE_DETECTED). The user's
    // next step is identical, so the CLI does not try to tell them apart.
    stubFetch([{ status: 401, body: { message: 'Token revoked' } }]);

    const error = await refreshCliToken(BASE, 'gsl_rt_replayed').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('Token revoked');
  });

  it('surfaces an expired credential as a 401', async () => {
    stubFetch([{ status: 401, body: { message: 'Token expired' } }]);
    await expect(refreshCliToken(BASE, 'gsl_rt_old')).rejects.toThrow('Token expired');
  });

  it('rejects a response missing the rotated refresh token', async () => {
    const { refreshToken: _dropped, ...withoutRefresh } = TOKENS;
    stubFetch([{ status: 200, body: withoutRefresh }]);

    // Better to fail loudly than to persist a credential with no refresh token
    // and discover it an hour later.
    await expect(refreshCliToken(BASE, TOKENS.refreshToken)).rejects.toThrow(/refreshToken/);
  });

  it('sends the refresh token in the body, never the URL or a header', async () => {
    stubFetch([{ status: 200, body: TOKENS }]);
    await refreshCliToken(BASE, TOKENS.refreshToken);

    expect(calls[0]?.url).not.toContain('gsl_rt_');
    expect(JSON.stringify(calls[0]?.headers ?? {})).not.toContain('gsl_rt_');
  });
});
