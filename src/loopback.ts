import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { safeCompare } from './pkce.js';

/**
 * The loopback listener that catches the authorization code.
 *
 * Bound to 127.0.0.1 explicitly, never 0.0.0.0 and never ::, on an
 * OS-assigned port. The port is bound BEFORE the session is created and the
 * URL published, so no other local process can squat it after the fact.
 */

export interface LoopbackResult {
  code: string;
}

export class LoopbackError extends Error {
  readonly reason: 'denied' | 'timeout' | 'bad-request';

  constructor(reason: LoopbackError['reason'], message: string) {
    super(message);
    this.name = 'LoopbackError';
    this.reason = reason;
  }
}

export interface LoopbackListener {
  /** e.g. http://127.0.0.1:53412/callback */
  redirectUri: string;
  port: number;
  /** Resolves with the authorization code, or rejects with a LoopbackError. */
  waitForCode(timeoutMs: number): Promise<LoopbackResult>;
  close(): void;
}

const SUCCESS_PAGE = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<title>GoalSlot CLI</title>',
  '<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaed;',
  'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}',
  'div{text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}',
  'p{color:#9aa0a6;margin:0}</style></head><body><div>',
  '<h1>Authenticated</h1><p>You can close this window and return to your terminal.</p>',
  '</div></body></html>',
].join('');

function reply(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    Connection: 'close',
    // Nothing here should ever be cached, framed, or sniffed.
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

/**
 * Starts the listener. `state` is the value handed to the API at session
 * creation; the callback must echo it back or the request is rejected, which
 * is what stops an unrelated page on the machine from firing a callback at us.
 */
export function startLoopbackListener(state: string): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    let onResult: ((result: LoopbackResult) => void) | null = null;
    let onFailure: ((error: LoopbackError) => void) | null = null;
    let settledValue: LoopbackResult | null = null;
    let settledError: LoopbackError | null = null;

    const succeed = (result: LoopbackResult) => {
      if (settledValue || settledError) return;
      settledValue = result;
      onResult?.(result);
    };
    const fail = (error: LoopbackError) => {
      if (settledValue || settledError) return;
      settledError = error;
      onFailure?.(error);
    };

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Anything that is not the callback gets a bodiless 404. No directory
      // listing, no echo, nothing for a local scanner to learn from.
      if (req.method !== 'GET' || !req.url) {
        reply(res, 404, '', 'text/plain; charset=utf-8');
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(req.url, 'http://127.0.0.1');
      } catch {
        reply(res, 404, '', 'text/plain; charset=utf-8');
        return;
      }

      if (parsed.pathname !== '/callback') {
        reply(res, 404, '', 'text/plain; charset=utf-8');
        return;
      }

      const returnedState = parsed.searchParams.get('state') ?? '';
      if (!safeCompare(returnedState, state)) {
        reply(res, 400, 'Bad request.', 'text/plain; charset=utf-8');
        fail(new LoopbackError('bad-request', 'The browser callback did not match this login attempt.'));
        return;
      }

      const error = parsed.searchParams.get('error');
      if (error) {
        reply(res, 200, 'Request denied. You can close this window.', 'text/plain; charset=utf-8');
        fail(new LoopbackError('denied', 'The authorization request was denied.'));
        return;
      }

      const code = parsed.searchParams.get('code');
      if (!code) {
        reply(res, 400, 'Bad request.', 'text/plain; charset=utf-8');
        fail(new LoopbackError('bad-request', 'The browser callback carried no authorization code.'));
        return;
      }

      reply(res, 200, SUCCESS_PAGE, 'text/html; charset=utf-8');
      succeed({ code });
    });

    server.on('error', (error) => reject(error));

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine the loopback port.'));
        return;
      }

      const port = address.port;
      resolve({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        port,
        waitForCode(timeoutMs: number) {
          if (settledValue) return Promise.resolve(settledValue);
          if (settledError) return Promise.reject(settledError);

          return new Promise<LoopbackResult>((resolveWait, rejectWait) => {
            const timer = setTimeout(() => {
              rejectWait(
                new LoopbackError('timeout', 'Timed out waiting for the browser.'),
              );
            }, timeoutMs);
            timer.unref?.();

            onResult = (result) => {
              clearTimeout(timer);
              resolveWait(result);
            };
            onFailure = (error) => {
              clearTimeout(timer);
              rejectWait(error);
            };
          });
        },
        close() {
          // closeAllConnections so a browser holding the socket open cannot
          // keep the process alive after we have what we came for.
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}
