/**
 * The loopback redirect URI shape the API allowlists.
 *
 * This is a deliberate mirror of `src/modules/auth/cli/redirect-uri.ts` in the
 * API. It is duplicated rather than shared because the two ship separately, and
 * the point of having it here is to fail in the CLI with a readable message
 * instead of taking a bare `400 Invalid redirectUri` from the server (which
 * deliberately does not echo the value back, so a server-side rejection tells
 * you nothing about what was wrong).
 *
 * Any change to the server list has to be reflected here, and the tests pin
 * every rule so the drift is loud.
 */

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Below 1024 is privileged on POSIX and never something a CLI should bind. */
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

export const CALLBACK_PATH = '/callback';

export function isValidLoopbackRedirectUri(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // http only. There is no certificate a CLI could present for https on
  // loopback, and every other scheme is a way to hand the code to something
  // that is not a local listener.
  if (url.protocol !== 'http:') return false;

  // `hostname` is lowercased and has IPv6 brackets stripped by URL, so `::1`
  // cannot slip through this set. IPv6 loopback is intentionally unsupported.
  if (!ALLOWED_HOSTS.has(url.hostname)) return false;

  if (url.pathname !== CALLBACK_PATH) return false;

  // No query and no fragment: the API appends `code` and `state` itself.
  if (url.search !== '' || url.hash !== '') return false;

  // Userinfo makes a URL read as one host while resolving to another.
  if (url.username !== '' || url.password !== '') return false;

  // A blank port means 80, which is privileged and never what the CLI binds.
  if (!/^\d+$/.test(url.port)) return false;
  const port = Number(url.port);
  if (port < MIN_PORT || port > MAX_PORT) return false;

  return true;
}

export function isAllowedPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

export function buildLoopbackRedirectUri(port: number): string {
  if (!isAllowedPort(port)) {
    throw new Error(`Loopback port ${port} is outside ${MIN_PORT}-${MAX_PORT}`);
  }
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}
