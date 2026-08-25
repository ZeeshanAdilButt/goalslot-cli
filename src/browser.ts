import { spawn } from 'node:child_process';

/**
 * Opening the user's browser.
 *
 * Hand-rolled rather than pulling in `open`, because the whole job is three
 * platform branches and this package ships with zero runtime dependencies. The
 * caller must always print the URL as well: a failure here is common (headless
 * boxes, locked-down desktops, WSL) and is never fatal on its own.
 */

export interface OpenResult {
  opened: boolean;
  reason?: string;
}

/**
 * Windows `start` is a cmd builtin, not an executable, so it has to go through
 * `cmd /c`. The empty `""` argument is the window title: without it, `start`
 * treats a quoted URL as the title and opens nothing. `&` is the cmd command
 * separator and has to be caret-escaped even inside quotes.
 */
function windowsArgs(url: string): { command: string; args: string[] } {
  return {
    command: 'cmd.exe',
    args: ['/c', 'start', '""', url.replace(/&/g, '^&')],
  };
}

export async function openBrowser(
  url: string,
  platform: string = process.platform,
): Promise<OpenResult> {
  // Only ever hand a real http(s) URL to a shell. Everything downstream of
  // here is a process launch, so a `file:` or custom scheme sneaking in would
  // be a way to make the CLI open something it was never asked to.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { opened: false, reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { opened: false, reason: `refusing to open a ${parsed.protocol} URL` };
  }

  const { command, args } =
    platform === 'win32'
      ? windowsArgs(url)
      : platform === 'darwin'
        ? { command: 'open', args: [url] }
        : { command: 'xdg-open', args: [url] };

  return new Promise<OpenResult>((resolve) => {
    let settled = false;
    const finish = (result: OpenResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(command, args, {
        stdio: 'ignore',
        detached: platform !== 'win32',
        windowsVerbatimArguments: platform === 'win32',
      });

      child.on('error', (error: Error) => finish({ opened: false, reason: error.message }));

      // Let the browser outlive this process. Without unref, a CLI that exits
      // right after a successful login can be held open by the child.
      child.unref();

      // The launcher exits almost immediately; the browser itself is a
      // grandchild we never see. Treat "the launcher started" as success and
      // let the printed URL cover the rest.
      setTimeout(() => finish({ opened: true }), 250);
    } catch (error) {
      finish({ opened: false, reason: error instanceof Error ? error.message : 'unknown error' });
    }
  });
}
