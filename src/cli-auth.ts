import { rawRequest, ApiError } from './api.js';
import type { TokenResponse } from './credentials.js';
import type { ClientInfo } from './config.js';

/**
 * The unauthenticated half of the CLI auth flow: everything under
 * `POST /api/auth/cli` that runs before there is a token to present.
 *
 * WIRE FORMAT: camelCase, deliberately not RFC 8628 snake_case. The API says so
 * in a header comment on its DTOs and asks not to be "fixed" toward the RFC.
 * The single snake_case survivor is the `user_code` query parameter the API
 * builds into `verificationUriComplete`.
 */

export const SCOPES = ['full'] as const;

export interface LoopbackSession {
  sessionId: string;
  sessionSecret: string;
  approvalUrl: string;
  expiresIn: number;
}

export interface DeviceSession {
  sessionId: string;
  sessionSecret: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface ExchangeInput {
  sessionId: string;
  sessionSecret: string;
  codeVerifier: string;
  authorizationCode?: string;
}

/**
 * Every outcome of `POST /token` as one union.
 *
 * 200 tokens, 202 pending, 403 denied, 410 expired-or-used, 429 slow down.
 * 401 is the only status that throws, because it means the session id, the
 * secret, the code or the PKCE verifier is wrong and retrying cannot help.
 */
export type TokenExchangeResult =
  | { status: 'TOKENS'; tokens: TokenResponse }
  | { status: 'PENDING'; interval: number | null }
  | { status: 'SLOW_DOWN'; interval: number | null; retryAfterSeconds: number | null }
  | { status: 'DENIED' }
  | { status: 'EXPIRED' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOrNull(body: unknown, key: string): number | null {
  if (!isRecord(body)) return null;
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function messageFrom(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    const message = body['message'];
    if (typeof message === 'string' && message !== '') return message;
    if (Array.isArray(message)) {
      const joined = message.filter((part): part is string => typeof part === 'string').join(', ');
      if (joined !== '') return joined;
    }
  }
  return fallback;
}

function requireString(body: unknown, key: string): string {
  if (!isRecord(body) || typeof body[key] !== 'string' || body[key] === '') {
    throw new ApiError(0, `The API response was missing "${key}"`, body);
  }
  return body[key] as string;
}

/**
 * Creates a LOOPBACK session.
 *
 * `redirectUri` must already be a bound port. The API validates it once here
 * and never re-reads it from request input afterwards, which is what stops a
 * crafted approval link from steering the code somewhere else - so a rejection
 * at this step is a hard stop, not something to retry with a different value.
 */
export async function createLoopbackSession(
  baseUrl: string,
  input: ClientInfo & { redirectUri: string; state: string; codeChallenge: string },
): Promise<LoopbackSession> {
  const response = await rawRequest(baseUrl, '/auth/cli/session', {
    method: 'POST',
    body: {
      mode: 'LOOPBACK',
      redirectUri: input.redirectUri,
      state: input.state,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: 'S256',
      clientName: input.clientName,
      clientVersion: input.clientVersion,
      deviceLabel: input.deviceLabel,
      platform: input.platform,
      scopes: [...SCOPES],
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      response.status,
      messageFrom(response.body, 'Could not start a login'),
      response.body,
    );
  }

  return {
    sessionId: requireString(response.body, 'sessionId'),
    sessionSecret: requireString(response.body, 'sessionSecret'),
    approvalUrl: requireString(response.body, 'approvalUrl'),
    expiresIn: numberOrNull(response.body, 'expiresIn') ?? 600,
  };
}

export async function createDeviceSession(
  baseUrl: string,
  input: ClientInfo & { codeChallenge: string },
): Promise<DeviceSession> {
  const response = await rawRequest(baseUrl, '/auth/cli/session', {
    method: 'POST',
    body: {
      mode: 'DEVICE',
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: 'S256',
      clientName: input.clientName,
      clientVersion: input.clientVersion,
      deviceLabel: input.deviceLabel,
      platform: input.platform,
      scopes: [...SCOPES],
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      response.status,
      messageFrom(response.body, 'Could not start a login'),
      response.body,
    );
  }

  const userCode = requireString(response.body, 'userCode');
  const verificationUri = requireString(response.body, 'verificationUri');
  const complete = isRecord(response.body) ? response.body['verificationUriComplete'] : null;

  return {
    sessionId: requireString(response.body, 'sessionId'),
    sessionSecret: requireString(response.body, 'sessionSecret'),
    userCode,
    verificationUri,
    verificationUriComplete:
      typeof complete === 'string' && complete !== ''
        ? complete
        : `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expiresIn: numberOrNull(response.body, 'expiresIn') ?? 600,
    interval: numberOrNull(response.body, 'interval') ?? 5,
  };
}

/** Both the loopback exchange and the device poll hit this one endpoint. */
export async function exchangeToken(
  baseUrl: string,
  input: ExchangeInput,
): Promise<TokenExchangeResult> {
  const body: Record<string, unknown> = {
    sessionId: input.sessionId,
    sessionSecret: input.sessionSecret,
    codeVerifier: input.codeVerifier,
  };
  if (input.authorizationCode !== undefined) {
    body['authorizationCode'] = input.authorizationCode;
  }

  const response = await rawRequest(baseUrl, '/auth/cli/token', { method: 'POST', body });

  switch (response.status) {
    case 200:
      return { status: 'TOKENS', tokens: expectTokenResponse(response.body) };
    case 202:
      return { status: 'PENDING', interval: numberOrNull(response.body, 'interval') };
    case 403:
      return { status: 'DENIED' };
    case 410:
      return { status: 'EXPIRED' };
    case 429:
      return {
        status: 'SLOW_DOWN',
        interval: numberOrNull(response.body, 'interval'),
        retryAfterSeconds: retryAfterSeconds(response.headers),
      };
    default:
      throw new ApiError(
        response.status,
        messageFrom(response.body, 'Could not complete the login'),
        response.body,
      );
  }
}

/**
 * Rotates the refresh token.
 *
 * The old value is dead the moment this returns, and presenting it again makes
 * the API revoke the entire credential as a suspected replay. Callers must
 * persist the result before using the new access token for anything.
 */
export async function refreshCliToken(
  baseUrl: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await rawRequest(baseUrl, '/auth/cli/token/refresh', {
    method: 'POST',
    body: { refreshToken },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      response.status,
      messageFrom(response.body, 'Could not refresh the session'),
      response.body,
    );
  }

  return expectTokenResponse(response.body);
}

function expectTokenResponse(body: unknown): TokenResponse {
  const user = isRecord(body) ? body['user'] : null;
  if (!isRecord(user)) {
    throw new ApiError(0, 'The API response was missing "user"', body);
  }

  const scopes = isRecord(body) && Array.isArray(body['scopes'])
    ? (body['scopes'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : ['full'];

  const name = user['name'];

  return {
    tokenType: 'Bearer',
    accessToken: requireString(body, 'accessToken'),
    expiresIn: numberOrNull(body, 'expiresIn') ?? 3600,
    refreshToken: requireString(body, 'refreshToken'),
    refreshTokenExpiresAt: requireString(body, 'refreshTokenExpiresAt'),
    tokenId: requireString(body, 'tokenId'),
    scopes,
    user: {
      id: requireString(user, 'id'),
      email: requireString(user, 'email'),
      name: typeof name === 'string' ? name : null,
    },
  };
}
