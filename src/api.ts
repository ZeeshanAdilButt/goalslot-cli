/**
 * HTTP client for the GoalSlot API.
 *
 * The API sets a global prefix of `/api`, so every route here is
 * `<baseUrl>/api/<path>`. Base URL precedence: GOALSLOT_API_URL, then the
 * `apiUrl` recorded in the credential file at login, then production.
 */
import {
  DEFAULT_API_URL,
  accessTokenExpired,
  credentialsFromTokenResponse,
  readCredentials,
  writeCredentials,
  type StoredCredentials,
  type TokenResponse,
} from './credentials.js';
import { printWarning } from './output.js';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Thrown when there is nothing usable on disk, or the refresh path is closed. */
export class NotAuthenticatedError extends Error {
  constructor(message = 'You are not logged in. Run: goalslot login') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

export function resolveApiUrl(stored?: string | null): string {
  const raw = process.env.GOALSLOT_API_URL || stored || DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && typeof message[0] === 'string') {
      return message.join(', ');
    }
  }
  return fallback;
}

export interface RawResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

/**
 * One fetch, no auth, no retry. Everything else in this file is layered on
 * top so the unauthenticated login endpoints and the authenticated commands
 * share exactly one place that talks to the network.
 */
export async function rawRequest(
  baseUrl: string,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string | null;
    query?: Record<string, string | number | undefined>;
  } = {},
): Promise<RawResponse> {
  const url = new URL(`${baseUrl}/api${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw new ApiError(0, `Could not reach ${baseUrl}: ${detail}`, null);
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: response.status, body, headers: response.headers };
}

/** Same as rawRequest, but any non-2xx becomes an ApiError. */
export async function request(
  baseUrl: string,
  path: string,
  init: Parameters<typeof rawRequest>[2] = {},
): Promise<unknown> {
  const response = await rawRequest(baseUrl, path, init);
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      response.status,
      messageFromBody(response.body, `HTTP ${response.status}`),
      response.body,
    );
  }
  return response.body;
}

/**
 * An authenticated client bound to one credential.
 *
 * GOALSLOT_TOKEN short-circuits the whole thing: the token is used as-is, never
 * written to disk, and the refresh path is disabled. CI is expected to supply a
 * fresh token or fail loudly, not to silently rotate a shared secret.
 */
export class AuthenticatedClient {
  readonly baseUrl: string;
  private credentials: StoredCredentials | null;
  private readonly envToken: string | null;
  private refreshInFlight: Promise<void> | null = null;

  private constructor(
    baseUrl: string,
    credentials: StoredCredentials | null,
    envToken: string | null,
  ) {
    this.baseUrl = baseUrl;
    this.credentials = credentials;
    this.envToken = envToken;
  }

  static load(): AuthenticatedClient {
    const envToken = process.env.GOALSLOT_TOKEN || null;
    if (envToken) {
      return new AuthenticatedClient(resolveApiUrl(null), null, envToken);
    }

    const { credentials, permissionWarning } = readCredentials();
    if (permissionWarning) printWarning(permissionWarning);
    if (!credentials) throw new NotAuthenticatedError();

    return new AuthenticatedClient(
      resolveApiUrl(credentials.apiUrl),
      credentials,
      null,
    );
  }

  /** Null under GOALSLOT_TOKEN, where we know nothing about the caller. */
  get storedCredentials(): StoredCredentials | null {
    return this.credentials;
  }

  private get token(): string {
    if (this.envToken) return this.envToken;
    if (!this.credentials) throw new NotAuthenticatedError();
    return this.credentials.accessToken;
  }

  /**
   * Rotates the refresh token and persists the result. Serialised through
   * `refreshInFlight` because the CLI can have two requests in flight (today
   * fans out) and the API revokes the whole credential if a rotated-away
   * refresh token is presented a second time.
   */
  private async refresh(): Promise<void> {
    if (this.envToken) {
      throw new NotAuthenticatedError(
        'GOALSLOT_TOKEN is set but expired or rejected. Supply a fresh token.',
      );
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    const current = this.credentials;
    if (!current) throw new NotAuthenticatedError();

    this.refreshInFlight = (async () => {
      let response: unknown;
      try {
        response = await request(this.baseUrl, '/auth/cli/token/refresh', {
          method: 'POST',
          body: { refreshToken: current.refreshToken },
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          throw new NotAuthenticatedError(
            'Your CLI token is expired or was revoked. Run: goalslot login',
          );
        }
        throw error;
      }

      const next = credentialsFromTokenResponse(
        response as TokenResponse,
        this.baseUrl,
      );
      writeCredentials(next);
      this.credentials = next;
    })();

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  async call(
    path: string,
    init: Omit<Parameters<typeof rawRequest>[2], 'token'> = {},
  ): Promise<unknown> {
    if (this.credentials && accessTokenExpired(this.credentials)) {
      await this.refresh();
    }

    const first = await rawRequest(this.baseUrl, path, {
      ...init,
      token: this.token,
    });
    if (first.status !== 401) {
      if (first.status < 200 || first.status >= 300) {
        throw new ApiError(
          first.status,
          messageFromBody(first.body, `HTTP ${first.status}`),
          first.body,
        );
      }
      return first.body;
    }

    // A 401 on a token we believed was live means it was revoked, or the
    // server clock disagrees with ours. One refresh, one retry, then give up.
    await this.refresh();
    const second = await rawRequest(this.baseUrl, path, {
      ...init,
      token: this.token,
    });
    if (second.status < 200 || second.status >= 300) {
      if (second.status === 401) {
        throw new NotAuthenticatedError(
          'Your CLI token is expired or was revoked. Run: goalslot login',
        );
      }
      throw new ApiError(
        second.status,
        messageFromBody(second.body, `HTTP ${second.status}`),
        second.body,
      );
    }
    return second.body;
  }

  get(path: string, query?: Record<string, string | number | undefined>) {
    return this.call(path, { method: 'GET', query });
  }

  post(path: string, body?: unknown) {
    return this.call(path, { method: 'POST', body: body ?? {} });
  }

  delete(path: string) {
    return this.call(path, { method: 'DELETE' });
  }
}
