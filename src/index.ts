#!/usr/bin/env node
import { ArgError, flag, parseArgs, type ArgSpec, type ParsedArgs } from './args.js';
import { ApiError, NotAuthenticatedError } from './api.js';
import { CLI_NAME, CLI_VERSION } from './version.js';
import { bold, cyan, dim, print, printError } from './output.js';
import type { Command, CommandContext } from './commands/types.js';
import { login, describeLoginError } from './commands/login.js';
import { logout } from './commands/logout.js';
import { whoami } from './commands/whoami.js';
import { tokens } from './commands/tokens.js';
import { mcp, mcpHelp } from './commands/mcp.js';
import { start } from './commands/start.js';
import { stop } from './commands/stop.js';
import { status } from './commands/status.js';
import { today } from './commands/today.js';

/**
 * Entry point and dispatch table.
 *
 * Flags are declared per command rather than globally, because parseArgs
 * rejects unknown options: a typo like `--devcie` on a login should be an
 * error, not a silent fall-through to the browser flow.
 */

interface CommandDefinition {
  run: Command;
  summary: string;
  spec: ArgSpec;
  help?: () => void;
}

/** Accepted everywhere, so they are merged into each command's own spec. */
const GLOBAL_SPEC: ArgSpec = {
  booleans: ['json', 'help', 'version'],
  aliases: { h: 'help', v: 'version' },
};

function withGlobals(spec: ArgSpec): ArgSpec {
  return {
    booleans: [...(GLOBAL_SPEC.booleans ?? []), ...(spec.booleans ?? [])],
    strings: [...(GLOBAL_SPEC.strings ?? []), ...(spec.strings ?? [])],
    aliases: { ...GLOBAL_SPEC.aliases, ...spec.aliases },
  };
}

const COMMANDS: Record<string, CommandDefinition> = {
  login: {
    run: login,
    summary: 'Log in through the browser, or with a device code',
    // --device forces the device flow, --no-device refuses the automatic
    // fallback, --force replaces an existing credential.
    spec: { booleans: ['device', 'force'] },
  },
  logout: {
    run: logout,
    summary: 'Revoke this device token and delete the local credential',
    spec: {},
  },
  whoami: {
    run: whoami,
    summary: 'Show the signed-in account',
    spec: {},
  },
  tokens: {
    run: tokens,
    summary: 'List, rename or revoke CLI tokens',
    spec: {},
  },
  mcp: {
    run: mcp,
    summary: 'Run the GoalSlot MCP server over stdio',
    spec: {},
    help: mcpHelp,
  },
  start: {
    run: start,
    summary: 'Start the timer',
    // --take-over replaces a running session, which DISCARDS its elapsed time,
    // so it is opt-in and never the default. `--note` is accepted as an alias
    // for `--notes` because both spellings are an easy thing to reach for.
    spec: {
      booleans: ['take-over'],
      strings: ['notes', 'goal'],
      aliases: { note: 'notes' },
    },
  },
  stop: {
    run: stop,
    summary: 'Stop the running timer',
    spec: {
      booleans: ['discard'],
      strings: ['notes'],
      aliases: { note: 'notes' },
    },
  },
  status: {
    run: status,
    summary: 'Show the running timer',
    spec: {},
  },
  today: {
    run: today,
    summary: "Show today's schedule and logged time",
    spec: {},
  },
};

function printUsage(): void {
  print(`${bold(CLI_NAME)} ${dim(CLI_VERSION)}`);
  print();
  print('Usage: goalslot <command> [options]');
  print();
  print('Commands:');
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  for (const [name, definition] of Object.entries(COMMANDS)) {
    print(`  ${name.padEnd(width)}  ${dim(definition.summary)}`);
  }
  print();
  print('Options:');
  print(`  --json      ${dim('Machine-readable output')}`);
  print(`  -h, --help  ${dim('Show help')}`);
  print(`  -v, --version`);
  print();
  print(`Start with ${cyan('goalslot login')}.`);
}

/**
 * Turns a thrown error into an exit code and one readable line.
 *
 * Stack traces are hidden unless GOALSLOT_DEBUG is set: a user who mistypes a
 * token id should get a sentence, not a trace through the HTTP client.
 */
function reportError(error: unknown, command: string | null): number {
  if (process.env['GOALSLOT_DEBUG'] && error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  }

  if (error instanceof NotAuthenticatedError) {
    printError(error.message);
    return 1;
  }

  if (command === 'login') {
    printError(describeLoginError(error));
    return 1;
  }

  if (error instanceof ApiError) {
    // Status 0 is this client's "could not reach the host" marker.
    if (error.status === 0) {
      printError(error.message);
      return 1;
    }
    if (error.status === 404) {
      printError('Not found.');
      return 1;
    }
    if (error.status === 429) {
      printError('Rate limited. Wait a moment and try again.');
      return 1;
    }
    printError(error.message);
    return 1;
  }

  printError(error instanceof Error ? error.message : 'Unknown error');
  return 1;
}

export async function run(argv: readonly string[]): Promise<number> {
  // Peek at the command before parsing, because the flag spec depends on it.
  const commandName = argv.find((arg) => !arg.startsWith('-')) ?? null;
  const definition = commandName === null ? null : COMMANDS[commandName];

  let args: ParsedArgs;
  try {
    args = parseArgs(argv, withGlobals(definition?.spec ?? {}));
  } catch (error) {
    if (error instanceof ArgError) {
      printError(error.message);
      print();
      printUsage();
      return 1;
    }
    throw error;
  }

  if (flag(args, 'version')) {
    print(CLI_VERSION);
    return 0;
  }

  if (args.command === null) {
    printUsage();
    return flag(args, 'help') ? 0 : 1;
  }

  if (definition === undefined || definition === null) {
    printError(`Unknown command: ${args.command}`);
    print();
    printUsage();
    return 1;
  }

  if (flag(args, 'help')) {
    if (definition.help) definition.help();
    else print(definition.summary);
    return 0;
  }

  const context: CommandContext = { args, json: flag(args, 'json') };

  try {
    return await definition.run(context);
  } catch (error) {
    return reportError(error, args.command);
  }
}

/**
 * Only runs when this file is the process entry point, so importing the
 * package (the tests do) does not execute the CLI.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href.replace(/\\/g, '/');

if (isEntryPoint || process.env['GOALSLOT_FORCE_ENTRY'] === '1') {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      printError(error instanceof Error ? error.message : 'Unknown error');
      process.exitCode = 1;
    });
}
