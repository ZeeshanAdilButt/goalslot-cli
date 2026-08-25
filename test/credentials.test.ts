import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDENTIALS_VERSION,
  accessTokenExpired,
  clearCredentialsAt,
  credentialsFromTokenResponse,
  credentialsPath,
  parseCredentials,
  readCredentialsAt,
  resolveConfigDir,
  writeCredentialsAt,
  type StoredCredentials,
  type TokenResponse,
} from '../src/credentials.js';

const TOKEN_RESPONSE: TokenResponse = {
  tokenType: 'Bearer',
  accessToken: 'jwt.access.token',
  expiresIn: 3600,
  refreshToken: 'gsl_rt_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
  refreshTokenExpiresAt: '2026-11-23T10:00:00.000Z',
  tokenId: 'd4e5f6a7-0000-4000-8000-000000000001',
  scopes: ['full'],
  user: { id: 'u1', email: 'zeeshan@example.com', name: 'Zeeshan' },
};

function sample(): StoredCredentials {
  return credentialsFromTokenResponse(
    TOKEN_RESPONSE,
    'https://api.goalslot.io',
    new Date('2026-08-25T10:00:00.000Z'),
  );
}

describe('resolveConfigDir', () => {
  it('honours GOALSLOT_CONFIG_DIR above everything else', () => {
    const env = { GOALSLOT_CONFIG_DIR: '/custom/dir', APPDATA: 'C:\\AppData', HOME: '/home/z' };
    expect(resolveConfigDir(env, 'win32')).toBe('/custom/dir');
    expect(resolveConfigDir(env, 'linux')).toBe('/custom/dir');
    expect(resolveConfigDir(env, 'darwin')).toBe('/custom/dir');
  });

  it('uses %APPDATA% on Windows', () => {
    expect(resolveConfigDir({ APPDATA: 'C:\\Users\\z\\AppData\\Roaming' }, 'win32')).toBe(
      join('C:\\Users\\z\\AppData\\Roaming', 'goalslot'),
    );
  });

  it('falls back to USERPROFILE when APPDATA is missing on Windows', () => {
    expect(resolveConfigDir({ USERPROFILE: 'C:\\Users\\z' }, 'win32')).toBe(
      join('C:\\Users\\z', 'AppData', 'Roaming', 'goalslot'),
    );
  });

  it('uses XDG_CONFIG_HOME on Linux when set', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/z' }, 'linux')).toBe(
      join('/xdg', 'goalslot'),
    );
  });

  it('falls back to ~/.config on Linux', () => {
    expect(resolveConfigDir({ HOME: '/home/z' }, 'linux')).toBe(
      join('/home/z', '.config', 'goalslot'),
    );
  });

  it('uses ~/.config on macOS too, not Application Support', () => {
    expect(resolveConfigDir({ HOME: '/Users/z' }, 'darwin')).toBe(
      join('/Users/z', '.config', 'goalslot'),
    );
  });

  it('names the file credentials.json, which the MCP server also reads', () => {
    expect(credentialsPath({ GOALSLOT_CONFIG_DIR: '/c' }, 'linux')).toBe(
      join('/c', 'credentials.json'),
    );
  });
});

describe('credentialsFromTokenResponse', () => {
  it('turns expiresIn seconds into an absolute timestamp', () => {
    const credentials = sample();
    expect(credentials.accessTokenExpiresAt).toBe('2026-08-25T11:00:00.000Z');
  });

  it('writes the base URL under both apiUrl and apiBaseUrl', () => {
    // The CLI writes apiUrl, the MCP server writes apiBaseUrl. Writing both
    // means neither side falls back to production when reading the other's file.
    const credentials = sample();
    expect(credentials.apiUrl).toBe('https://api.goalslot.io');
    expect(credentials.apiBaseUrl).toBe('https://api.goalslot.io');
  });
});

describe('parseCredentials', () => {
  it('accepts a file written by this CLI', () => {
    expect(parseCredentials(JSON.stringify(sample()))?.tokenId).toBe(TOKEN_RESPONSE.tokenId);
  });

  it('accepts a file that only has apiBaseUrl, as the MCP server writes it', () => {
    const { apiUrl: _dropped, ...rest } = sample();
    const parsed = parseCredentials(JSON.stringify(rest));
    expect(parsed?.apiUrl).toBe('https://api.goalslot.io');
    expect(parsed?.apiBaseUrl).toBe('https://api.goalslot.io');
  });

  it('rejects a file with neither URL key', () => {
    const { apiUrl: _a, apiBaseUrl: _b, ...rest } = sample();
    expect(parseCredentials(JSON.stringify(rest))).toBeNull();
  });

  it('rejects malformed JSON instead of throwing', () => {
    expect(parseCredentials('{not json')).toBeNull();
  });

  it('rejects a credential from a future file format', () => {
    expect(parseCredentials(JSON.stringify({ ...sample(), version: 99 }))).toBeNull();
  });

  it('rejects a credential missing the refresh token', () => {
    expect(parseCredentials(JSON.stringify({ ...sample(), refreshToken: '' }))).toBeNull();
  });

  it('rejects a credential with no user', () => {
    const { user: _user, ...rest } = sample();
    expect(parseCredentials(JSON.stringify(rest))).toBeNull();
  });
});

describe('the credential file on disk', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goalslot-cli-test-'));
    path = join(dir, 'nested', 'credentials.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips through write and read', () => {
    writeCredentialsAt(path, sample());
    expect(readCredentialsAt(path).credentials?.accessToken).toBe(TOKEN_RESPONSE.accessToken);
  });

  it('creates the parent directory', () => {
    writeCredentialsAt(path, sample());
    expect(statSync(path).isFile()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('writes the file 0600', () => {
    writeCredentialsAt(path, sample());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('preserves keys written by the MCP server that the CLI does not model', () => {
    writeCredentialsAt(path, sample());
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      JSON.stringify({ ...onDisk, defaultTimezone: 'Asia/Karachi', weekStartsOn: 1 }),
    );

    // A second login must not wipe the other side's settings.
    writeCredentialsAt(path, { ...sample(), accessToken: 'jwt.rotated' });

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.defaultTimezone).toBe('Asia/Karachi');
    expect(after.weekStartsOn).toBe(1);
    expect(after.accessToken).toBe('jwt.rotated');
  });

  it('leaves no temp file behind', () => {
    writeCredentialsAt(path, sample());
    const leftovers = readFileSync(path, 'utf8');
    expect(leftovers.length).toBeGreaterThan(0);
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });

  it('reports a missing file as absent rather than throwing', () => {
    expect(readCredentialsAt(join(dir, 'nope.json')).credentials).toBeNull();
  });

  it('reports a corrupt file as absent rather than throwing', () => {
    writeCredentialsAt(path, sample());
    writeFileSync(path, 'garbage');
    expect(readCredentialsAt(path).credentials).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('warns when the file is group readable', () => {
    writeCredentialsAt(path, sample());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chmodSync } = require('node:fs') as typeof import('node:fs');
    chmodSync(path, 0o644);

    const result = readCredentialsAt(path);
    expect(result.credentials).not.toBeNull();
    expect(result.permissionWarning).toContain('chmod 600');
  });

  it('clears the credential', () => {
    writeCredentialsAt(path, sample());
    expect(clearCredentialsAt(path)).toBe(true);
    expect(readCredentialsAt(path).credentials).toBeNull();
  });

  it('treats clearing an absent file as success', () => {
    expect(clearCredentialsAt(join(dir, 'nope.json'))).toBe(true);
  });
});

describe('accessTokenExpired', () => {
  const credentials = sample(); // expires 2026-08-25T11:00:00Z

  it('is false well before expiry', () => {
    expect(accessTokenExpired(credentials, 60, new Date('2026-08-25T10:30:00.000Z'))).toBe(false);
  });

  it('is true after expiry', () => {
    expect(accessTokenExpired(credentials, 60, new Date('2026-08-25T11:30:00.000Z'))).toBe(true);
  });

  it('is true inside the skew window, so a request never races the clock', () => {
    expect(accessTokenExpired(credentials, 60, new Date('2026-08-25T10:59:30.000Z'))).toBe(true);
  });

  it('treats an unparseable timestamp as expired', () => {
    expect(accessTokenExpired({ ...credentials, accessTokenExpiresAt: 'nonsense' })).toBe(true);
  });

  it('version constant is 1, the value the MCP server checks', () => {
    expect(CREDENTIALS_VERSION).toBe(1);
  });
});
