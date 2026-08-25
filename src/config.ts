import { hostname } from 'node:os';
import { createRequire } from 'node:module';

/**
 * Static facts about this client.
 *
 * Path resolution deliberately does NOT live here - it is in credentials.ts,
 * which is the shared contract with the MCP server. Duplicating it would give
 * us two answers to "where is the credential file".
 */

/** Sent to POST /auth/cli/session and shown on the web approval card. */
export const CLIENT_NAME = 'goalslot-cli';

export interface Env {
  [key: string]: string | undefined;
}

interface PackageManifest {
  version?: unknown;
}

/**
 * Read from package.json rather than hardcoded, so the `clientVersion` on the
 * approval card can never drift from what is actually installed. Resolves the
 * same from `dist/` and from `src/` because both are one level under the root.
 */
export function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require('../package.json') as PackageManifest;
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface ClientInfo {
  clientName: string;
  clientVersion: string;
  deviceLabel: string;
  platform: string;
}

/**
 * What the approval page shows the user. `deviceLabel` is the hostname, which
 * is the one field that lets somebody looking at the card say "yes, that is
 * the machine I am sitting at" - so it is worth getting right and worth never
 * truncating below the API's 64 character limit.
 */
export function clientInfo(): ClientInfo {
  let label: string;
  try {
    label = hostname() || 'unknown-host';
  } catch {
    label = 'unknown-host';
  }
  return {
    clientName: CLIENT_NAME,
    clientVersion: readVersion(),
    deviceLabel: label.slice(0, 64),
    platform: `${process.platform}-${process.arch}`.slice(0, 32),
  };
}

/**
 * True when opening a browser is either impossible or pointless.
 *
 * Erring towards "there is a browser" is the worse failure: the user watches a
 * terminal say "waiting for approval" while nothing ever opens. Erring the
 * other way costs them typing eight characters, so the checks are deliberately
 * generous.
 */
export function looksHeadless(env: Env = process.env, platform: string = process.platform): boolean {
  if (env['SSH_TTY'] || env['SSH_CONNECTION'] || env['SSH_CLIENT']) return true;
  if (env['CI'] === 'true' || env['CI'] === '1') return true;
  if (platform === 'linux' && !env['DISPLAY'] && !env['WAYLAND_DISPLAY']) return true;
  return false;
}
