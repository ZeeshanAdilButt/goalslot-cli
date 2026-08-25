import { AuthenticatedClient } from '../api.js';
import { credentialsPath } from '../credentials.js';
import { bold, dim, print, printJson } from '../output.js';
import type { CommandContext } from './types.js';

interface Me {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
}

/**
 * Hits /auth/me rather than reading the file, so it answers "is this
 * credential still good" and not just "is there a file".
 */
export async function whoami(context: CommandContext): Promise<number> {
  const client = AuthenticatedClient.load();
  const me = (await client.get('/auth/me')) as Me;
  const stored = client.storedCredentials;

  if (context.json) {
    printJson({
      user: me,
      apiUrl: client.baseUrl,
      tokenId: stored?.tokenId ?? null,
      source: stored ? 'credentials-file' : 'GOALSLOT_TOKEN',
      credentialsPath: stored ? credentialsPath() : null,
      accessTokenExpiresAt: stored?.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: stored?.refreshTokenExpiresAt ?? null,
    });
    return 0;
  }

  print(bold(me.email));
  if (me.name) print(dim(me.name));
  print();
  print(`${dim('API')}    ${client.baseUrl}`);
  if (stored) {
    print(`${dim('Token')}  ${stored.tokenId}`);
    print(`${dim('File')}   ${credentialsPath()}`);
  } else {
    print(`${dim('Token')}  from GOALSLOT_TOKEN`);
  }
  return 0;
}
