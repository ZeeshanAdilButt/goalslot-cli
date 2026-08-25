/**
 * The credential store.
 *
 * THIS FILE IS A SHARED CONTRACT. The GoalSlot MCP server reads the same file,
 * at the same path, in the same shape, so that `goalslot login` authenticates
 * both the CLI and the MCP server in one step. Do not change the path, the
 * filename, the `version` field or any key below without changing the MCP
 * server in the same breath.
 *
 *   Linux / macOS: ${XDG_CONFIG_HOME:-$HOME/.config}/goalslot/credentials.json
 *   Windows:       %APPDATA%\goalslot\credentials.json
 *   Override:      $GOALSLOT_CONFIG_DIR
 *
 * macOS uses ~/.config rather than ~/Library/Application Support on purpose:
 * developers look for CLI config there, and it keeps one code path.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_API_URL = 'https://api.goalslot.io';
export const CREDENTIALS_FILENAME = 'credentials.json';
export const CREDENTIALS_VERSION = 1;

export interface StoredUser {
  id: string;
  email: string;
  name?: string | null;
}

export interface StoredCredentials {
  version: number;
  /**
   * The API base URL, written twice under two names.
   *
   * The CLI historically wrote `apiUrl`; the MCP server writes `apiBaseUrl`.
   * Rather than pick a winner and strand whichever side upgrades second, both
   * are written with the same value and both are accepted on read. Drop
   * neither until both packages have agreed to.
   */
  apiUrl: string;
  apiBaseUrl: string;
  tokenId: string;
  accessToken: string;
  /** ISO 8601. */
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** ISO 8601. */
  refreshTokenExpiresAt: string;
  user: StoredUser;
  /**
   * Keys written by the MCP server that the CLI does not model
   * (`defaultTimezone`, `weekStartsOn`, and whatever comes next). They are
   * carried through a read-modify-write untouched, so logging in from the CLI
   * cannot silently drop the other side's settings.
   */
  [key: string]: unknown;
}

export interface Env {
  GOALSLOT_CONFIG_DIR?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
  APPDATA?: string | undefined;
  HOME?: string | undefined;
  USERPROFILE?: string | undefined;
}

/**
 * Pure, so it can be tested for every platform without touching a real home
 * directory. GOALSLOT_CONFIG_DIR wins everywhere, which is what CI and the
 * tests use.
 */
export function resolveConfigDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.GOALSLOT_CONFIG_DIR) return env.GOALSLOT_CONFIG_DIR;

  if (platform === 'win32') {
    const appData =
      env.APPDATA ||
      (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Roaming') : '');
    if (appData) return join(appData, 'goalslot');
    return join(homedir(), 'AppData', 'Roaming', 'goalslot');
  }

  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'goalslot');
  return join(env.HOME || homedir(), '.config', 'goalslot');
}

export function credentialsPath(env?: Env, platform?: NodeJS.Platform): string {
  return join(resolveConfigDir(env, platform), CREDENTIALS_FILENAME);
}

/**
 * Anything that is not a well-formed credential file is treated as absent
 * rather than fatal. A truncated or hand-edited file should send the user to
 * `goalslot login`, not to a stack trace.
 */
export function parseCredentials(raw: string): StoredCredentials | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;

  const c = value as Partial<StoredCredentials>;
  if (c.version !== CREDENTIALS_VERSION) return null;

  // Accept either spelling and normalise both, so a file last written by the
  // MCP server (apiBaseUrl only) does not silently fall back to production
  // when the CLI reads it, and vice versa.
  const base =
    (typeof c.apiUrl === 'string' && c.apiUrl) ||
    (typeof c.apiBaseUrl === 'string' && c.apiBaseUrl) ||
    '';
  if (base) {
    c.apiUrl = base;
    c.apiBaseUrl = base;
  }

  const required = [
    c.apiUrl,
    c.tokenId,
    c.accessToken,
    c.accessTokenExpiresAt,
    c.refreshToken,
    c.refreshTokenExpiresAt,
  ];
  if (required.some((field) => typeof field !== 'string' || field.length === 0)) {
    return null;
  }
  if (
    !c.user ||
    typeof c.user !== 'object' ||
    typeof c.user.id !== 'string' ||
    typeof c.user.email !== 'string'
  ) {
    return null;
  }

  return c as StoredCredentials;
}

export interface ReadResult {
  credentials: StoredCredentials | null;
  /** Set on POSIX when the file is group- or world-readable. */
  permissionWarning?: string;
}

export function readCredentialsAt(
  path: string,
  platform: NodeJS.Platform = process.platform,
): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { credentials: null };
  }

  const credentials = parseCredentials(raw);
  if (!credentials) return { credentials: null };

  if (platform !== 'win32') {
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) {
        const octal = mode.toString(8).padStart(3, '0');
        return {
          credentials,
          permissionWarning:
            `${path} is mode ${octal}, it should be 600. ` +
            `Fix it with: chmod 600 ${path}`,
        };
      }
    } catch {
      // A file we just read but cannot stat is not worth failing a command over.
    }
  }

  return { credentials };
}

export function readCredentials(env?: Env, platform?: NodeJS.Platform): ReadResult {
  return readCredentialsAt(
    credentialsPath(env, platform),
    platform ?? process.platform,
  );
}

/**
 * Written 0600 into a temp file in the same directory and then renamed, so a
 * crash mid-write cannot leave a half-parsed credential behind and the secret
 * is never briefly world-readable. Same directory keeps the rename on one
 * filesystem, which is what makes it atomic.
 *
 * On Windows the mode is a no-op. The real protection there is that %APPDATA%
 * is already ACL'd to the user. We do not pretend otherwise.
 */
/**
 * Every key currently in the file, or an empty object when there is no file or
 * it is not JSON. Deliberately does not validate: the point is to carry keys
 * we do not understand, and a file we cannot parse simply has none to carry.
 */
function readUnknownKeys(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeCredentialsAt(
  path: string,
  credentials: StoredCredentials,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  // Read-modify-write. Whatever the MCP server has added to this file that the
  // CLI does not model (defaultTimezone, weekStartsOn, and whatever comes
  // next) is carried over, so `goalslot login` cannot quietly wipe the other
  // side's settings. Our keys are spread last and always win.
  const merged = { ...readUnknownKeys(path), ...credentials };

  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }

  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // The write already carried the mode; a failure here is not fatal.
    }
  }
}

export function writeCredentials(
  credentials: StoredCredentials,
  env?: Env,
  platform?: NodeJS.Platform,
): string {
  const path = credentialsPath(env, platform);
  writeCredentialsAt(path, credentials);
  return path;
}

export function clearCredentialsAt(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function clearCredentials(env?: Env, platform?: NodeJS.Platform): boolean {
  return clearCredentialsAt(credentialsPath(env, platform));
}

/**
 * Token responses carry `expiresIn` seconds for the access token and an
 * absolute ISO timestamp for the refresh token. This converts one into the
 * other so that login and refresh cannot drift apart.
 */
export interface TokenResponse {
  tokenType: string;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenId: string;
  scopes: string[];
  user: StoredUser;
}

export function credentialsFromTokenResponse(
  response: TokenResponse,
  apiUrl: string,
  now: Date = new Date(),
): StoredCredentials {
  return {
    version: CREDENTIALS_VERSION,
    apiUrl,
    apiBaseUrl: apiUrl,
    scopes: response.scopes,
    tokenId: response.tokenId,
    accessToken: response.accessToken,
    accessTokenExpiresAt: new Date(
      now.getTime() + response.expiresIn * 1000,
    ).toISOString(),
    refreshToken: response.refreshToken,
    refreshTokenExpiresAt: new Date(
      response.refreshTokenExpiresAt,
    ).toISOString(),
    user: response.user,
  };
}

/** True when the access token is gone, or gone within `skewSeconds`. */
export function accessTokenExpired(
  credentials: StoredCredentials,
  skewSeconds = 60,
  now: Date = new Date(),
): boolean {
  const expiresAt = Date.parse(credentials.accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - skewSeconds * 1000 <= now.getTime();
}
