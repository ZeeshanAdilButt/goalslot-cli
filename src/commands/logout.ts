import { AuthenticatedClient, NotAuthenticatedError } from '../api.js';
import {
  clearCredentials,
  credentialsPath,
  readCredentials,
} from '../credentials.js';
import { dim, green, print, printJson, printWarning } from '../output.js';
import type { CommandContext } from './types.js';

const SETTINGS_URL = 'https://www.goalslot.io/dashboard/settings?tab=cli';

/**
 * Revoke server-side, then delete locally. The local delete happens even when
 * the API call fails, because leaving a credential on disk that the user
 * believes is gone is the worse of the two failures. When that happens we say
 * so plainly and point at the revoke page.
 */
export async function logout(context: CommandContext): Promise<number> {
  const path = credentialsPath();
  const { credentials } = readCredentials();

  if (!credentials) {
    if (context.json) {
      printJson({ status: 'ok', revoked: false, removed: false });
      return 0;
    }
    print('Not logged in.');
    return 0;
  }

  let revoked = false;
  let revokeError: string | null = null;

  try {
    const client = AuthenticatedClient.load();
    await client.delete(`/auth/cli/tokens/${credentials.tokenId}`);
    revoked = true;
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      // Already dead server-side. Nothing to revoke, so this is a success.
      revoked = true;
    } else {
      revokeError = error instanceof Error ? error.message : 'unknown error';
    }
  }

  const removed = clearCredentials();

  if (context.json) {
    printJson({ status: 'ok', revoked, removed, revokeError, credentialsPath: path });
    return revokeError ? 1 : 0;
  }

  if (revokeError) {
    printWarning(`Could not revoke the token on the server: ${revokeError}`);
    print(
      `Local credentials removed, but the token may still be active. ` +
        `Revoke it at ${SETTINGS_URL}`,
    );
    return 1;
  }

  print(`${green('Logged out')} ${dim(credentials.user.email)}`);
  print(dim(`Removed ${path}`));
  return 0;
}
