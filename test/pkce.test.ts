import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkcePair, createState, randomToken, safeCompare } from '../src/pkce.js';

/**
 * The API validates the verifier and the challenge with DIFFERENT charsets and
 * derives the challenge itself, so these tests pin the exact shapes rather than
 * just "it returns a string".
 */

// From the API's ExchangeCliTokenDto.
const VERIFIER_CHARSET = /^[A-Za-z0-9._~-]+$/;
// From the API's CreateCliSessionDto. Note it does NOT allow "." or "~".
const CHALLENGE_CHARSET = /^[A-Za-z0-9_-]+$/;

describe('createPkcePair', () => {
  it('produces a verifier inside the API 43-128 length window', () => {
    const { codeVerifier } = createPkcePair();
    expect(codeVerifier.length).toBe(43);
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
  });

  it('produces a verifier the API charset accepts', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(createPkcePair().codeVerifier).toMatch(VERIFIER_CHARSET);
    }
  });

  it('produces a challenge the API charset accepts', () => {
    // base64url never emits "." or "~", so the narrower challenge charset holds.
    for (let i = 0; i < 50; i += 1) {
      expect(createPkcePair().codeChallenge).toMatch(CHALLENGE_CHARSET);
    }
  });

  it('derives the challenge exactly as the server re-derives it', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const expected = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('always declares S256, never plain', () => {
    expect(createPkcePair().codeChallengeMethod).toBe('S256');
  });

  it('never emits base64 padding, which the charset would reject', () => {
    for (let i = 0; i < 50; i += 1) {
      const { codeVerifier, codeChallenge } = createPkcePair();
      expect(codeVerifier).not.toContain('=');
      expect(codeChallenge).not.toContain('=');
      // "+" and "/" are base64, not base64url, and would fail both charsets.
      expect(codeVerifier).not.toMatch(/[+/]/);
      expect(codeChallenge).not.toMatch(/[+/]/);
    }
  });

  it('does not repeat a verifier', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(createPkcePair().codeVerifier);
    expect(seen.size).toBe(200);
  });

  it('changes the challenge whenever the verifier changes', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe('createState', () => {
  it('fits the API 8-128 window and charset', () => {
    for (let i = 0; i < 50; i += 1) {
      const state = createState();
      expect(state.length).toBeGreaterThanOrEqual(8);
      expect(state.length).toBeLessThanOrEqual(128);
      expect(state).toMatch(VERIFIER_CHARSET);
    }
  });

  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(createState());
    expect(seen.size).toBe(200);
  });
});

describe('randomToken', () => {
  it('gives 43 characters for the default 32 bytes', () => {
    expect(randomToken().length).toBe(43);
  });

  it('scales with the byte count', () => {
    expect(randomToken(16).length).toBe(22);
  });
});

describe('safeCompare', () => {
  it('is true only for identical strings', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abd')).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws on unequal lengths; the guard must come first.
    expect(() => safeCompare('short', 'much longer value')).not.toThrow();
    expect(safeCompare('short', 'much longer value')).toBe(false);
  });

  it('handles the empty string', () => {
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('', 'x')).toBe(false);
  });
});
