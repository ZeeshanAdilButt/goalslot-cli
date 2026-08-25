import { AuthenticatedClient } from '../api.js';
import { readCredentials } from '../credentials.js';
import {
  bold,
  cyan,
  dim,
  formatRelative,
  green,
  print,
  printJson,
  red,
  yellow,
} from '../output.js';
import type { CommandContext } from './types.js';

/**
 * `goalslot tokens list|rename|revoke|revoke-all`.
 *
 * These routes accept either a web JWT or a CLI access token, so the CLI can
 * manage its own credentials without sending the user to the dashboard.
 *
 * The API never returns token material here, hashed or otherwise. Everything
 * below is metadata, which is why it is safe to print.
 */

export interface CliTokenSummary {
  id: string;
  name: string;
  clientName: string;
  clientVersion: string;
  deviceLabel: string;
  platform: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

const USAGE = `Usage:
  goalslot tokens list
  goalslot tokens rename <id> <name>
  goalslot tokens revoke <id>
  goalslot tokens revoke-all`;

export async function tokens(context: CommandContext): Promise<number> {
  const [subcommand, ...rest] = context.args.positionals;

  switch (subcommand) {
    case undefined:
    case 'list':
      return listTokens(context);
    case 'rename':
      return renameToken(context, rest);
    case 'revoke':
      return revokeToken(context, rest);
    case 'revoke-all':
      return revokeAll(context);
    default:
      print(`Unknown subcommand: ${subcommand}`);
      print();
      print(USAGE);
      return 1;
  }
}

async function listTokens(context: CommandContext): Promise<number> {
  const client = AuthenticatedClient.load();
  const list = (await client.get('/auth/cli/tokens')) as CliTokenSummary[];

  if (context.json) {
    printJson(list);
    return 0;
  }

  if (list.length === 0) {
    print('No CLI tokens.');
    return 0;
  }

  // The credential this process is using, so the list can mark it. Null under
  // GOALSLOT_TOKEN, where we cannot know which row is ours.
  const currentId = readCredentials().credentials?.tokenId ?? null;

  for (const token of list) {
    const marker = token.id === currentId ? green(' (this device)') : '';
    const heading = token.revokedAt ? dim(token.name) : bold(token.name);
    print(`${heading}${marker}`);
    print(`  ${dim('id')}        ${token.id}`);
    print(`  ${dim('device')}    ${token.deviceLabel} ${dim(`(${token.platform})`)}`);
    print(`  ${dim('client')}    ${token.clientName} ${token.clientVersion}`);
    print(`  ${dim('scopes')}    ${token.scopes.join(', ')}`);
    print(`  ${dim('created')}   ${formatRelative(token.createdAt)}`);
    print(
      `  ${dim('last used')} ${
        token.lastUsedAt
          ? `${formatRelative(token.lastUsedAt)}${token.lastUsedIp ? dim(` from ${token.lastUsedIp}`) : ''}`
          : dim('never')
      }`,
    );

    if (token.revokedAt) {
      // REUSE_DETECTED is the one the user genuinely needs to see: it means the
      // API decided a refresh token was replayed and killed the credential.
      const reason = token.revokedReason ?? 'UNKNOWN';
      const rendered = reason === 'REUSE_DETECTED' ? red(reason) : yellow(reason);
      print(`  ${dim('revoked')}   ${formatRelative(token.revokedAt)} ${rendered}`);
    } else {
      print(`  ${dim('expires')}   ${formatRelative(token.expiresAt)}`);
    }
    print();
  }

  return 0;
}

async function renameToken(context: CommandContext, rest: string[]): Promise<number> {
  const [id, ...nameParts] = rest;
  const name = nameParts.join(' ').trim();

  if (!id || name === '') {
    print('Usage: goalslot tokens rename <id> <name>');
    return 1;
  }
  // The API caps this at 64 characters; failing here beats a 400.
  if (name.length > 64) {
    print('That name is too long. Keep it to 64 characters or fewer.');
    return 1;
  }

  const client = AuthenticatedClient.load();
  await client.call(`/auth/cli/tokens/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name },
  });

  if (context.json) {
    printJson({ status: 'ok', id, name });
    return 0;
  }
  print(`${green('Renamed')} ${dim(id)} to ${bold(name)}`);
  return 0;
}

async function revokeToken(context: CommandContext, rest: string[]): Promise<number> {
  const [id] = rest;
  if (!id) {
    print('Usage: goalslot tokens revoke <id>');
    return 1;
  }

  const current = readCredentials().credentials;
  const client = AuthenticatedClient.load();
  await client.delete(`/auth/cli/tokens/${encodeURIComponent(id)}`);

  if (context.json) {
    printJson({ status: 'ok', id, revoked: true });
    return 0;
  }

  print(`${green('Revoked')} ${dim(id)}`);
  if (current && current.tokenId === id) {
    // Revoking your own credential is legitimate, but the next command would
    // otherwise fail with a confusing 401.
    print(`That was this device's token. Run ${cyan('goalslot login')} to sign in again.`);
  }
  return 0;
}

async function revokeAll(context: CommandContext): Promise<number> {
  const client = AuthenticatedClient.load();
  const result = (await client.post('/auth/cli/tokens/revoke-all')) as { revoked?: number };
  const revoked = typeof result.revoked === 'number' ? result.revoked : 0;

  if (context.json) {
    printJson({ status: 'ok', revoked });
    return 0;
  }

  print(`${green('Revoked')} ${revoked} token${revoked === 1 ? '' : 's'}.`);
  print(`This device included. Run ${cyan('goalslot login')} to sign in again.`);
  return 0;
}
