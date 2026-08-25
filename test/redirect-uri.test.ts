import { describe, expect, it } from 'vitest';
import {
  buildLoopbackRedirectUri,
  isAllowedPort,
  isValidLoopbackRedirectUri,
  MAX_PORT,
  MIN_PORT,
} from '../src/redirect-uri.js';

/**
 * This mirrors the API's allowlist in src/modules/auth/cli/redirect-uri.ts.
 *
 * The API rejects a bad redirect URI with a bare `400 Invalid redirectUri` and
 * deliberately does NOT echo the submitted value back, so if these two ever
 * drift the failure in the wild is a login that dies with no explanation. That
 * is the whole reason for pinning every rule here.
 */

describe('isValidLoopbackRedirectUri', () => {
  it('accepts what the CLI actually builds', () => {
    expect(isValidLoopbackRedirectUri('http://127.0.0.1:53412/callback')).toBe(true);
  });

  it('accepts localhost as the documented compatibility fallback', () => {
    expect(isValidLoopbackRedirectUri('http://localhost:53412/callback')).toBe(true);
  });

  describe('scheme', () => {
    it('rejects https, which no CLI can present a certificate for', () => {
      expect(isValidLoopbackRedirectUri('https://127.0.0.1:53412/callback')).toBe(false);
    });

    it.each([
      'file:///callback',
      'ftp://127.0.0.1:53412/callback',
      'goalslot://127.0.0.1:53412/callback',
    ])('rejects %s', (value) => {
      expect(isValidLoopbackRedirectUri(value)).toBe(false);
    });

    it('rejects javascript:, which is a script sink not a listener', () => {
      expect(isValidLoopbackRedirectUri('javascript:alert(1)//127.0.0.1/callback')).toBe(false);
    });
  });

  describe('host', () => {
    it.each([
      'http://example.com:53412/callback',
      'http://127.0.0.2:53412/callback',
      'http://0.0.0.0:53412/callback',
      'http://127.0.0.1.evil.com:53412/callback',
      'http://localhost.evil.com:53412/callback',
    ])('rejects the off-machine host in %s', (value) => {
      expect(isValidLoopbackRedirectUri(value)).toBe(false);
    });

    it('rejects IPv6 loopback, which the API deliberately does not support', () => {
      expect(isValidLoopbackRedirectUri('http://[::1]:53412/callback')).toBe(false);
    });
  });

  describe('path', () => {
    it.each([
      'http://127.0.0.1:53412/',
      'http://127.0.0.1:53412',
      'http://127.0.0.1:53412/callbacks',
      'http://127.0.0.1:53412/callback/',
      'http://127.0.0.1:53412/callback/extra',
      'http://127.0.0.1:53412/CALLBACK',
    ])('rejects %s because the path is not exactly /callback', (value) => {
      expect(isValidLoopbackRedirectUri(value)).toBe(false);
    });
  });

  describe('query and fragment', () => {
    it('rejects a query, because the API appends code and state itself', () => {
      expect(isValidLoopbackRedirectUri('http://127.0.0.1:53412/callback?a=1')).toBe(false);
    });

    it('rejects a pre-set code parameter', () => {
      expect(isValidLoopbackRedirectUri('http://127.0.0.1:53412/callback?code=x')).toBe(false);
    });

    it('rejects a fragment', () => {
      expect(isValidLoopbackRedirectUri('http://127.0.0.1:53412/callback#frag')).toBe(false);
    });

    it('rejects an empty-but-present query string', () => {
      // "?" alone parses to search === "", so this one is genuinely allowed.
      expect(isValidLoopbackRedirectUri('http://127.0.0.1:53412/callback?')).toBe(true);
    });
  });

  describe('userinfo', () => {
    it.each([
      'http://user@127.0.0.1:53412/callback',
      'http://user:pass@127.0.0.1:53412/callback',
      'http://:pass@127.0.0.1:53412/callback',
      // The classic: reads as evil.com, resolves to 127.0.0.1.
      'http://evil.com@127.0.0.1:53412/callback',
    ])('rejects %s', (value) => {
      expect(isValidLoopbackRedirectUri(value)).toBe(false);
    });
  });

  describe('port', () => {
    it('rejects a missing port, which would mean privileged port 80', () => {
      expect(isValidLoopbackRedirectUri('http://127.0.0.1/callback')).toBe(false);
    });

    it.each([1, 80, 443, 1023])('rejects privileged port %i', (port) => {
      expect(isValidLoopbackRedirectUri(`http://127.0.0.1:${port}/callback`)).toBe(false);
    });

    it('accepts the boundaries', () => {
      expect(isValidLoopbackRedirectUri(`http://127.0.0.1:${MIN_PORT}/callback`)).toBe(true);
      expect(isValidLoopbackRedirectUri(`http://127.0.0.1:${MAX_PORT}/callback`)).toBe(true);
    });

    it('rejects a port above the maximum', () => {
      // URL itself refuses to parse 65536, so this fails at the parse step.
      expect(isValidLoopbackRedirectUri('http://127.0.0.1:65536/callback')).toBe(false);
    });
  });

  describe('input hygiene', () => {
    it.each([
      ['not a URL', 'not a url'],
      ['empty string', ''],
      ['whitespace', '   '],
    ])('rejects %s', (_label, value) => {
      expect(isValidLoopbackRedirectUri(value)).toBe(false);
    });

    it.each([null, undefined, 42, {}, [], true])('rejects the non-string %s', (value) => {
      expect(isValidLoopbackRedirectUri(value)).toBe(false);
    });

    it('rejects anything longer than the API 200 character cap', () => {
      const long = `http://127.0.0.1:53412/callback${'a'.repeat(200)}`;
      expect(long.length).toBeGreaterThan(200);
      expect(isValidLoopbackRedirectUri(long)).toBe(false);
    });
  });
});

describe('isAllowedPort', () => {
  it('accepts the range the API allows', () => {
    expect(isAllowedPort(MIN_PORT)).toBe(true);
    expect(isAllowedPort(53412)).toBe(true);
    expect(isAllowedPort(MAX_PORT)).toBe(true);
  });

  it('rejects outside the range', () => {
    expect(isAllowedPort(0)).toBe(false);
    expect(isAllowedPort(1023)).toBe(false);
    expect(isAllowedPort(65536)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isAllowedPort(3000.5)).toBe(false);
    expect(isAllowedPort(Number.NaN)).toBe(false);
  });
});

describe('buildLoopbackRedirectUri', () => {
  it('builds a URI that its own validator accepts', () => {
    const uri = buildLoopbackRedirectUri(53412);
    expect(uri).toBe('http://127.0.0.1:53412/callback');
    expect(isValidLoopbackRedirectUri(uri)).toBe(true);
  });

  it('uses the literal loopback address rather than the localhost name', () => {
    // A hosts-file entry can point "localhost" elsewhere; 127.0.0.1 cannot be
    // redirected that way, so it is what the CLI actually sends.
    expect(buildLoopbackRedirectUri(2000)).toContain('127.0.0.1');
  });

  it('refuses a port the API would reject, rather than sending it', () => {
    expect(() => buildLoopbackRedirectUri(80)).toThrow(/1024-65535/);
    expect(() => buildLoopbackRedirectUri(70000)).toThrow(/1024-65535/);
  });
});
