import { DEFAULT_BASE_URL } from '../client/client.js';
import { errorFromResponse, SpaceContextError } from '../errors.js';
import type { components } from '../generated/schema.js';

/**
 * Device sign-in: how a terminal or a tool without a browser session gets an
 * API key. It asks the API for a code, shows the code and the console link to
 * the person, and polls until the person approves it in the console. No key
 * travels through the browser; the terminal never sees the console session.
 *
 * ```ts
 * const { api_key, user } = await deviceSignIn({
 *   name: 'CLI on MacBook',
 *   onCode: ({ userCode, verificationUrl }) => console.log(`Open ${verificationUrl} and enter ${userCode}`),
 * });
 * ```
 *
 * The code is never put in a link: the person types it in the console, so a
 * link forwarded by someone else cannot get that someone's terminal approved.
 */

type Schemas = components['schemas'];
export type DeviceStart = Schemas['DeviceStart'];
export type DeviceToken = Schemas['DeviceToken'];

export interface DeviceSignInOptions {
  /** What is asking, shown to the person: "CLI on MacBook". Cut to 60 characters, the most the API takes. */
  name?: string;
  /**
   * The mode of the key asked for; the person can change it. Default live. A
   * live key with `scans:write` needs a card on file: the console asks for one
   * before approving it (nothing is charged), or the person approves a key
   * without that scope.
   */
  mode?: 'live' | 'test';
  /** Defaults to `SPACECONTEXT_BASE_URL`, then the production API. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Called once with the code to show. */
  onCode: (code: { userCode: string; verificationUrl: string; expiresIn: number }) => void;
  /** Called at every poll that is still waiting. */
  onWaiting?: () => void;
  signal?: AbortSignal;
}

function environment(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return value && value.trim() ? value.trim() : undefined;
}

/** The longest name the API takes. */
const MAX_NAME_LENGTH = 60;

/**
 * The name on one line, as the API stores it, cut to what the API takes: a long
 * host name must not make the sign-in fail.
 */
function deviceName(name: string): string {
  const line = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (line.length <= MAX_NAME_LENGTH) return line;
  // One character is kept for the ellipsis, and a surrogate pair is never split.
  let end = MAX_NAME_LENGTH - 1;
  if (/[\ud800-\udbff]/.test(line[end - 1]!)) end -= 1;
  return `${line.slice(0, end).trimEnd()}…`;
}

/**
 * A request of the sign-in. No answer at all is a `NETWORK_ERROR`: every
 * failure is a SpaceContextError, as with the client. The caller's abort is
 * thrown as it is.
 */
async function post(fetcher: typeof fetch, url: string, body: unknown, signal: AbortSignal | undefined): Promise<Response> {
  try {
    return await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new SpaceContextError(`The request failed: ${error instanceof Error ? error.message : String(error)}`, 0, 'NETWORK_ERROR', null);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Starts a device sign-in: the codes, without waiting. */
export async function startDeviceSignIn(options: Omit<DeviceSignInOptions, 'onCode' | 'onWaiting'> = {}): Promise<DeviceStart> {
  const base = resolveBase(options.baseUrl);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const name = options.name ? deviceName(options.name) : '';
  const response = await post(fetcher, `${base}/auth/device`, { ...(name ? { name } : {}), ...(options.mode ? { mode: options.mode } : {}) }, options.signal);
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as DeviceStart;
}

/**
 * Polls a started sign-in until the person decides. Resolves with the key and
 * its account; rejects with `ACCESS_DENIED`, `DEVICE_CODE_EXPIRED` or
 * `DEVICE_CODE_INVALID` as the API answers them. A poll that gets no answer is
 * made again; `NETWORK_ERROR` only once the code has expired.
 */
export async function waitForDeviceSignIn(
  started: Pick<DeviceStart, 'device_code' | 'interval' | 'expires_in'>,
  options: Pick<DeviceSignInOptions, 'baseUrl' | 'fetch' | 'onWaiting' | 'signal'> = {}
): Promise<DeviceToken> {
  const base = resolveBase(options.baseUrl);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let interval = Math.min(60, Math.max(0, started.interval));
  const deadline = Date.now() + Math.max(1, started.expires_in) * 1000;
  for (;;) {
    await sleep(interval * 1000, options.signal);
    let response: Response;
    try {
      response = await post(fetcher, `${base}/auth/device/token`, { device_code: started.device_code }, options.signal);
    } catch (error) {
      // No answer (a dropped connection, offline for a moment): asked again at the
      // next interval, until the code expires. The person may be approving it now.
      if (!(error instanceof SpaceContextError) || error.code !== 'NETWORK_ERROR' || Date.now() >= deadline) throw error;
      continue;
    }
    if (response.ok) return (await response.json()) as DeviceToken;
    const error = await errorFromResponse(response);
    if (error.code === 'AUTHORIZATION_PENDING' || error.code === 'SLOW_DOWN') {
      if (error.code === 'SLOW_DOWN') interval = Math.min(60, interval + 5);
      options.onWaiting?.();
      if (Date.now() >= deadline) throw new SpaceContextError('The code expired before it was approved', 0, 'DEVICE_CODE_EXPIRED', null);
      continue;
    }
    throw error;
  }
}

/** The whole flow: start, show the code, wait for the key. */
export async function deviceSignIn(options: DeviceSignInOptions): Promise<DeviceToken> {
  const started = await startDeviceSignIn(options);
  options.onCode({ userCode: started.user_code, verificationUrl: started.verification_url, expiresIn: started.expires_in });
  return waitForDeviceSignIn(started, options);
}

function resolveBase(baseUrl: string | undefined): string {
  const base = (baseUrl ?? environment('SPACECONTEXT_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const parsed = new URL(base);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !local) throw new SpaceContextError('baseUrl must use https', 0, 'INVALID_BASE_URL', null);
  return base;
}
