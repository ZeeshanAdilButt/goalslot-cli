import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { readFileSync } from 'node:fs';
import { readCredentials, resolveConfigDir } from '../credentials.js';
import { cyan, print, printError } from '../output.js';
import type { CommandContext } from './types.js';

/**
 * `goalslot mcp` - launch the GoalSlot MCP server over stdio.
 *
 * This is a LAUNCHER AND NOTHING ELSE. The tool surface lives in its own
 * package, maintained separately; nothing in this file knows what tools exist
 * or what they do. Its whole job is: confirm there is a credential, find the
 * server, hand it the environment it needs, and get out of the way.
 *
 * It exists so that `claude mcp add goalslot -- goalslot mcp` works without the
 * user having to know a second package name or wire a token by hand.
 *
 * WHY IT PASSES GOALSLOT_CONFIG_DIR AND NOT AN ACCESS TOKEN
 *
 * The obvious design is to refresh a token here and pass it as
 * GOALSLOT_ACCESS_TOKEN. That is a trap. CLI access tokens live one hour, and
 * an env-supplied token is by contract non-refreshable (it is the CI escape
 * hatch, where rotating a shared secret behind the caller's back would be
 * wrong). An MCP server started that way works beautifully for an hour and
 * then dies with no way back, in the middle of a session. Passing the config
 * directory instead lets the server read the same credential file this CLI
 * wrote and rotate it for itself, for as long as the refresh token lives.
 */

/**
 * Tried in order. The package was briefed as `@goalslot/mcp` and later settled
 * as unscoped `goalslot-mcp`; trying both means the launcher keeps working
 * whichever name it is finally published under, rather than failing with a
 * misleading "not installed".
 */
const CANDIDATE_PACKAGES = ['goalslot-mcp', '@goalslot/mcp'] as const;

interface ResolvedServer {
  packageName: string;
  /** Absolute path to the server's executable entry point. */
  binPath: string;
}

interface McpManifest {
  bin?: unknown;
  main?: unknown;
  name?: unknown;
}

/**
 * Resolves the server package's bin from its own package.json rather than
 * importing it. Spawning the documented entry point keeps this launcher
 * independent of the server's export shape, which is a module boundary we do
 * not control and should not guess at.
 */
function resolveServer(): ResolvedServer | null {
  const require = createRequire(import.meta.url);

  for (const packageName of CANDIDATE_PACKAGES) {
    let manifestPath: string;
    try {
      manifestPath = require.resolve(`${packageName}/package.json`);
    } catch {
      continue;
    }

    let manifest: McpManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as McpManifest;
    } catch {
      continue;
    }

    const packageDir = dirname(manifestPath);
    const relative = pickBin(manifest);
    if (relative === null) continue;

    return { packageName, binPath: resolvePath(join(packageDir, relative)) };
  }

  return null;
}

/** `bin` may be a string or a map; `main` is the fallback for a library-only build. */
function pickBin(manifest: McpManifest): string | null {
  const { bin, main } = manifest;

  if (typeof bin === 'string' && bin !== '') return bin;

  if (bin !== null && typeof bin === 'object') {
    const entries = Object.entries(bin as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    );
    if (entries.length > 0) {
      // Prefer a bin actually named for the server, otherwise take the first.
      const preferred =
        entries.find(([name]) => name === 'goalslot-mcp') ??
        entries.find(([name]) => name.includes('mcp')) ??
        entries[0];
      return preferred === undefined ? null : preferred[1];
    }
  }

  if (typeof main === 'string' && main !== '') return main;
  return null;
}

const NOT_INSTALLED = [
  'The GoalSlot MCP server is not installed.',
  '',
  'Install it, then run this again:',
  '  npm install -g goalslot-mcp',
  '',
  'Once installed, register it with Claude Code:',
  '  claude mcp add goalslot -- goalslot mcp',
].join('\n');

export async function mcp(context: CommandContext): Promise<number> {
  // Everything this command says goes to stderr. stdout is the MCP transport
  // and a single stray line on it corrupts the JSON-RPC stream.
  const { credentials, permissionWarning } = readCredentials();

  if (permissionWarning) {
    process.stderr.write(`${permissionWarning}\n`);
  }

  if (!credentials && !process.env['GOALSLOT_TOKEN']) {
    printError('Not logged in. Run `goalslot login` first.');
    return 1;
  }

  const server = resolveServer();
  if (server === null) {
    if (context.json) {
      process.stderr.write(`${JSON.stringify({ status: 'error', reason: 'not-installed' })}\n`);
    } else {
      process.stderr.write(`${NOT_INSTALLED}\n`);
    }
    return 1;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The server reads and refreshes the same credential file this CLI writes.
    GOALSLOT_CONFIG_DIR: resolveConfigDir(),
  };
  if (credentials) {
    env['GOALSLOT_API_URL'] = process.env['GOALSLOT_API_URL'] ?? credentials.apiUrl;
  }

  return new Promise<number>((resolvePromise) => {
    // stdio inherit: the MCP client on the other end of our stdin/stdout is
    // talking to the server directly. We are only the process that started it.
    const child = spawn(process.execPath, [server.binPath], {
      stdio: 'inherit',
      env,
    });

    child.on('error', (error: Error) => {
      printError(`Could not start ${server.packageName}: ${error.message}`);
      resolvePromise(1);
    });

    // Forward the signals a supervisor would send, so Ctrl+C and a clean
    // shutdown reach the server rather than orphaning it.
    const forward = (signal: NodeJS.Signals) => () => {
      if (!child.killed) child.kill(signal);
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      // 128 + signal number is the shell convention for "killed by a signal".
      if (signal !== null) {
        resolvePromise(signal === 'SIGINT' ? 130 : 143);
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

/** `goalslot mcp --help` and the README both point at this line. */
export function mcpHelp(): void {
  print('Launch the GoalSlot MCP server over stdio.');
  print();
  print('Register it with Claude Code:');
  print(`  ${cyan('claude mcp add goalslot -- goalslot mcp')}`);
  print();
  print('The server authenticates with the credential written by `goalslot login`.');
}
