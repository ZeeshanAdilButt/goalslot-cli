import { ApiError, resolveApiUrl } from '../api.js';
import {
  createDeviceSession,
  createLoopbackSession,
  exchangeToken,
  type TokenExchangeResult,
} from '../cli-auth.js';
import { clientInfo, looksHeadless } from '../config.js';
import {
  credentialsFromTokenResponse,
  readCredentials,
  writeCredentials,
} from '../credentials.js';
import { LoopbackError, startLoopbackListener } from '../loopback.js';
import { openBrowser } from '../browser.js';
import { createPkcePair, createState } from '../pkce.js';
import { isValidLoopbackRedirectUri } from '../redirect-uri.js';
import { advancePoll, DEFAULT_POLL_INTERVAL_SECONDS, sleep } from '../poll.js';
import { bold, cyan, dim, green, print, printWarning } from '../output.js';
import { flag } from '../args.js';
import type { CommandContext } from './types.js';

/**
 * `goalslot login`.
 *
 * Default is the loopback flow: bind a port, create a session, open a browser,
 * catch the code on the callback, exchange it. `--device` forces the device
 * code flow, which is also what a headless box falls back to automatically.
 *
 * Two secrets guard the exchange and neither ever touches disk or the browser:
 * the PKCE code verifier and the session secret. Both are required, so an
 * authorization code intercepted on the loopback port is worthless on its own.
 */

/** The API gives a session 10 minutes; there is no point waiting longer. */
const SESSION_WAIT_MS = 10 * 60 * 1000;

export async function login(context: CommandContext): Promise<number> {
  const { args } = context;
  const baseUrl = resolveApiUrl(null);
  const info = clientInfo();

  if (!flag(args, 'force') && readCredentials().credentials !== null) {
    print(`Already logged in. Run ${cyan('goalslot login --force')} to replace the stored credential.`);
    return 0;
  }

  const wantsDevice = flag(args, 'device');
  // `--no-device` is an explicit refusal to fall back, for scripts that would
  // rather fail than sit at a prompt nobody is watching.
  const allowFallback = args.booleans['device'] !== false;

  if (wantsDevice) {
    return deviceLogin(baseUrl, info);
  }

  if (allowFallback && looksHeadless()) {
    print(dim('No browser available here, using the device code flow.'));
    print();
    return deviceLogin(baseUrl, info);
  }

  return loopbackLogin(baseUrl, info, allowFallback);
}

async function loopbackLogin(
  baseUrl: string,
  info: ReturnType<typeof clientInfo>,
  allowFallback: boolean,
): Promise<number> {
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createState();

  // Bind BEFORE creating the session, so the port in the redirect URI is
  // already held by this process and nothing can squat it afterwards.
  const listener = await startLoopbackListener(state);

  try {
    // Check our own URI against the same allowlist the API applies. A server
    // side rejection is a bare 400 that deliberately does not echo the value,
    // so catching it here is the difference between a readable error and a
    // mystery.
    if (!isValidLoopbackRedirectUri(listener.redirectUri)) {
      throw new Error(
        `Bound an unusable loopback address (${listener.redirectUri}). Try: goalslot login --device`,
      );
    }

    const session = await createLoopbackSession(baseUrl, {
      ...info,
      redirectUri: listener.redirectUri,
      state,
      codeChallenge,
    });

    print(`Opening ${cyan(session.approvalUrl)}`);
    const opened = await openBrowser(session.approvalUrl);
    if (!opened.opened) {
      print();
      print('Could not open a browser automatically. Open this URL to continue:');
      print(`  ${bold(session.approvalUrl)}`);
    }
    print();
    print(dim('Waiting for approval in the browser...'));

    const { code } = await listener.waitForCode(SESSION_WAIT_MS);

    const result = await exchangeToken(baseUrl, {
      sessionId: session.sessionId,
      sessionSecret: session.sessionSecret,
      codeVerifier,
      authorizationCode: code,
    });

    // The loopback exchange only runs after the callback has fired, so the
    // session is already APPROVED and the server cannot answer PENDING or
    // SLOW_DOWN (SLOW_DOWN is device-only, PENDING needs an unapproved
    // session). The type does not know that, so it is narrowed explicitly
    // rather than cast: if the API ever does answer one of them here, that is
    // a real protocol change and the user gets told to retry instead of
    // reading a crash.
    if (result.status === 'PENDING' || result.status === 'SLOW_DOWN') {
      print();
      print('The login was not ready. Run `goalslot login` again.');
      return 1;
    }

    return finishExchange(result, baseUrl);
  } catch (error) {
    if (error instanceof LoopbackError && error.reason === 'timeout' && allowFallback) {
      print();
      printWarning('The browser did not come back in time.');
      print(`Falling back to the device code flow. ${dim('Press Ctrl+C to stop.')}`);
      print();
      return deviceLogin(baseUrl, info);
    }
    throw error;
  } finally {
    listener.close();
  }
}

async function deviceLogin(
  baseUrl: string,
  info: ReturnType<typeof clientInfo>,
): Promise<number> {
  const { codeVerifier, codeChallenge } = createPkcePair();
  const session = await createDeviceSession(baseUrl, { ...info, codeChallenge });

  print(`First copy your code: ${bold(session.userCode)}`);
  print(`Then open: ${cyan(session.verificationUri)}`);
  print();
  print(dim(`Or use the direct link: ${session.verificationUriComplete}`));
  print();

  // Best effort. On a headless box this does nothing and the printed code is
  // the real interface, which is why the code is printed first.
  await openBrowser(session.verificationUriComplete);

  print(dim('Waiting for approval...'));

  const deadline = Date.now() + session.expiresIn * 1000;
  let intervalSeconds = session.interval || DEFAULT_POLL_INTERVAL_SECONDS;

  // Poll the same endpoint the loopback flow exchanges against, minus the
  // authorization code. The server enforces the interval itself and answers a
  // caller that is early with 429 plus Retry-After.
  for (;;) {
    if (Date.now() >= deadline) {
      print();
      print('That code expired. Run `goalslot login` again.');
      return 1;
    }

    const result = await exchangeToken(baseUrl, {
      sessionId: session.sessionId,
      sessionSecret: session.sessionSecret,
      codeVerifier,
    });

    if (result.status === 'PENDING' || result.status === 'SLOW_DOWN') {
      const advice = advancePoll(intervalSeconds, result);
      intervalSeconds = advice.intervalSeconds;
      await sleep(advice.delaySeconds * 1000);
      continue;
    }

    return finishExchange(result, baseUrl);
  }
}

/**
 * Handles the terminal outcomes of the token endpoint. PENDING and SLOW_DOWN
 * never reach here - they are the poll loop's business.
 */
function finishExchange(
  result: Exclude<TokenExchangeResult, { status: 'PENDING' } | { status: 'SLOW_DOWN' }>,
  baseUrl: string,
): number {
  switch (result.status) {
    case 'DENIED':
      print();
      print('Request denied. Nothing was shared.');
      return 1;

    case 'EXPIRED':
      print();
      print('That request is no longer valid. Run `goalslot login` again.');
      return 1;

    case 'TOKENS': {
      // Persist BEFORE anything else uses the token. The API rotates refresh
      // tokens and treats a replayed one as theft, revoking the whole
      // credential, so a token used but never written is the worst outcome
      // available here.
      const credentials = credentialsFromTokenResponse(result.tokens, baseUrl);
      const path = writeCredentials(credentials);

      print();
      print(`${green('Logged in')} as ${bold(result.tokens.user.email)}`);
      print(dim(`Credential stored at ${path}`));
      if (process.platform === 'win32') {
        print(
          dim('On Windows the file mode is a no-op; it is protected by the per-user ACL on %APPDATA%.'),
        );
      }
      return 0;
    }
  }
}

/** Turns the API's error shapes into something worth reading in a terminal. */
export function describeLoginError(error: unknown): string {
  if (error instanceof LoopbackError) {
    switch (error.reason) {
      case 'timeout':
        return 'Timed out waiting for the browser. Run `goalslot login --device` instead.';
      case 'denied':
        return 'Request denied. Nothing was shared.';
      case 'bad-request':
        return `${error.message} Run \`goalslot login\` again.`;
    }
  }

  if (error instanceof ApiError) {
    if (error.status === 429) {
      return 'Too many login attempts from this network. Wait a few minutes and try again.';
    }
    if (error.status === 400) {
      return `${error.message}`;
    }
    if (error.status === 401) {
      return 'The login could not be verified. Run `goalslot login` again.';
    }
    return error.message;
  }

  return error instanceof Error ? error.message : 'Unknown error';
}
