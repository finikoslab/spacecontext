import { hostname } from 'node:os';
import { deviceSignIn, type DeviceToken } from '@spacecontext/sdk';
import type { Io } from '../cli.js';
import { configDirectory, setting, signedInConfig, writeConfig } from '../lib/config.js';
import { openUrl } from '../lib/system.js';
import { Status, styleFor } from '../terminal/ui.js';

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
  // The API signed in to is saved with the key, which goes to no other (see `keyInUse` in cli.ts).
  const requestBase = options.baseUrl ?? setting(io.env, 'SPACECONTEXT_BASE_URL');
  const s = styleFor(io, 'stderr');
  const status = new Status(io);
  let signedIn: DeviceToken;
  try {
    signedIn = await deviceSignIn({
      name: `CLI on ${hostname()}`,
      mode: options.mode,
      ...(requestBase ? { baseUrl: requestBase } : {}),
      ...(io.fetch ? { fetch: io.fetch } : {}),
      onCode: ({ userCode, verificationUrl, expiresIn }) => {
        const lines = [
          '',
          `  ${s.dim('1. Open ')}  ${s.cyan(verificationUrl)}`,
          `  ${s.dim('2. Enter')}  ${s.bold(s.brand(userCode))}`,
          '',
          `  ${s.dim(`The code is valid for ${Math.round(expiresIn / 60)} minutes. Approve only a code you see here.`)}`,
        ];
        // The console refuses a live key that can scan until the account has a card on file.
        if (options.mode === 'live') {
          lines.push(`  ${s.dim('A live key that can scan needs a card on file (adding one charges nothing).')}`);
        }
        io.stderr(`${lines.join('\n')}\n\n`);
        if (options.openBrowser) openInBrowser(io, verificationUrl);
        status.step('Waiting for your approval in the console');
      },
    });
  } catch (error) {
    status.stop();
    throw error;
  }
  status.complete('Approved in the console');
  const file = await writeConfig(configDirectory(io.env), signedInConfig(signedIn.api_key, requestBase));
  return { signedIn, file };
}
