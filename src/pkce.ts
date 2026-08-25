import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * PKCE, S256 only. The API rejects every other method, and plain PKCE is not
 * worth supporting for a client we ship ourselves.
 *
 * 32 random bytes base64url is 43 characters, which is the low end of the
 * API's 43-128 length window and matches its `[A-Za-z0-9_-]` charset.
 */

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export function createPkcePair(): PkcePair {
  const codeVerifier = randomToken(32);
  const codeChallenge = base64url(
    createHash('sha256').update(codeVerifier).digest(),
  );
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/** The loopback anti-mixup value. Same charset constraints as the verifier. */
export function createState(): string {
  return randomToken(32);
}

/**
 * Constant-time string compare. Length is not secret here (both sides are
 * fixed-width base64url) but comparing unequal lengths would throw, so the
 * length check is explicit and the byte compare only runs when it can.
 */
export function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
