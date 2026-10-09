import { hostname } from 'node:os';
import { deviceSignIn, type DeviceToken } from '@spacecontext/sdk';
import type { Io } from './cli.js';
import { configDirectory, setting, writeConfig } from './config.js';
import { openUrl } from './system.js';

/** Opens a URL unless the caller said never (`openBrowser: null`); undefined uses the system opener. */
export function openInBrowser(io: Io, url: string): void {
  if (io.openBrowser === null) return;
  (io.openBrowser ?? openUrl)(url);
}

/**
 * Device sign-in: a code to approve in the console; the key comes back to the
 * terminal, never through the browser, and is saved only in the CLI's config.
 * Everything is said on stderr: stdout stays for the command's result.
 */
export async function deviceLogin(
  io: Io,
  options: { mode: 'live' | 'test'; baseUrl?: string | undefined; openBrowser: boolean }
): Promise<{ signedIn: DeviceToken; file: string }> {
  // Only a base URL given explicitly is saved with the key (see `client` in cli.ts).
  const requestBase = options.baseUrl ?? setting(io.env, 'SPACECONTEXT_BASE_URL');
  const signedIn = await deviceSignIn({
    name: `CLI on ${hostname()}`,
    mode: options.mode,
    ...(requestBase ? { baseUrl: requestBase } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
    onCode: ({ userCode, verificationUrl, expiresIn }) => {
      io.stderr(`\nOpen ${verificationUrl}\nand enter this code:  ${userCode}\n\n(valid for ${Math.round(expiresIn / 60)} minutes; approve only a code you see here)\n`);
      // The console refuses a live key that can scan until the account has a card on file.
      if (options.mode === 'live') io.stderr('A live key that can scan needs a card on file (adding one charges nothing); the console tells you. Read-only keys need none.\n');
      if (options.openBrowser) openInBrowser(io, verificationUrl);
      io.stderr('Waiting for your approval…\n');
    },
  });
  const file = await writeConfig(configDirectory(io.env), { apiKey: signedIn.api_key, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) });
  return { signedIn, file };
}
