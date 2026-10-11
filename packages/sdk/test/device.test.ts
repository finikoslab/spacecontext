import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceSignIn, SpaceContextError, startDeviceSignIn, waitForDeviceSignIn } from '../src/index.js';

// Device sign-in: start, show the code, poll until the person approves.

const BASE = 'https://api.example.test/v1';

type Call = { url: string; method: string; body: unknown };

function fakeFetch(handler: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) => json({ error: { code, message: `${code} message`, request_id: 'req_1', ...extra } }, status);

const started = { device_code: `scd_${'a'.repeat(43)}`, user_code: 'BCDF-2345', verification_url: 'https://spacecontext.example/developers/console/authorize/', expires_in: 600, interval: 0 };
const token = { api_key: 'sc_live_newkey0123456789', key: { id: 'key_1', name: 'CLI · CLI', mode: 'live', prefix: 'sc_live_newk', scopes: ['spaces:read'], monthly_cap_cents: null, created_at: '2026-10-09T10:00:00.000Z' }, user: { id: 'u1', email: 'dev@example.com', name: null, is_pro: false } };

afterEach(() => {
  vi.useRealTimers();
});

describe('device sign-in', () => {
  it('starts, shows the code, polls while pending and returns the key once approved', async () => {
    const { fetch, calls } = fakeFetch((call, index) => {
      if (call.url.endsWith('/auth/device')) return json(started, 201);
      return index < 3 ? apiError(400, 'AUTHORIZATION_PENDING', { interval: 0 }) : json(token);
    });
    const shown: unknown[] = [];
    let waited = 0;

    const result = await deviceSignIn({ baseUrl: BASE, fetch, name: 'CLI on MacBook', mode: 'test', onCode: (code) => shown.push(code), onWaiting: () => waited++ });

    expect(result).toEqual(token);
    expect(shown).toEqual([{ userCode: 'BCDF-2345', verificationUrl: started.verification_url, expiresIn: 600 }]);
    expect(waited).toBe(2);
    expect(calls[0]!).toMatchObject({ url: `${BASE}/auth/device`, method: 'POST', body: { name: 'CLI on MacBook', mode: 'test' } });
    expect(calls.slice(1).every((call) => call.url === `${BASE}/auth/device/token` && (call.body as { device_code: string }).device_code === started.device_code)).toBe(true);
    // The code is shown, never a link that carries it.
    expect(JSON.stringify(shown)).not.toContain('code=');
  });

  it('backs off on slow_down, and stops on denied, expired or an unknown code', async () => {
    vi.useFakeTimers();
    const slow = fakeFetch((call, index) => (call.url.endsWith('/auth/device') ? json({ ...started, interval: 1 }, 201) : index === 1 ? apiError(400, 'SLOW_DOWN', { interval: 1 }) : json(token)));
    const waiting = deviceSignIn({ baseUrl: BASE, fetch: slow.fetch, onCode: () => undefined });
    await vi.advanceTimersByTimeAsync(1000); // first poll after the interval
    await vi.advanceTimersByTimeAsync(6000); // slow_down: the interval grew by five seconds
    expect(await waiting).toEqual(token);
    expect(slow.calls).toHaveLength(3);
    vi.useRealTimers();

    for (const [status, code] of [[403, 'ACCESS_DENIED'], [400, 'DEVICE_CODE_EXPIRED'], [400, 'DEVICE_CODE_INVALID']] as const) {
      const { fetch } = fakeFetch(() => apiError(status, code));
      const error = await waitForDeviceSignIn(started, { baseUrl: BASE, fetch }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SpaceContextError);
      expect(error).toMatchObject({ status, code });
    }
  });

  it('cuts a long name to what the API takes, on one line', async () => {
    const { fetch, calls } = fakeFetch(() => json(started, 201));
    await startDeviceSignIn({ baseUrl: BASE, fetch, name: `CLI on ${'build-agent-'.repeat(8)}local` });
    const name = (calls[0]!.body as { name: string }).name;
    expect(name).toHaveLength(60);
    expect(name).toMatch(/^CLI on build-agent-build-agent-.*…$/);

    // An emoji across the cut is left out whole, never halved.
    await startDeviceSignIn({ baseUrl: BASE, fetch, name: `CLI on\n  ${'x'.repeat(51)}😀yz` });
    expect((calls[1]!.body as { name: string }).name).toBe(`CLI on ${'x'.repeat(51)}…`);
    await startDeviceSignIn({ baseUrl: BASE, fetch, name: 'CLI\ton  MacBook' });
    expect((calls[2]!.body as { name: string }).name).toBe('CLI on MacBook');
  });

  it('says NETWORK_ERROR when the API cannot be reached, and polls again after a poll that got no answer', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const error = await startDeviceSignIn({ baseUrl: BASE, fetch: down.fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpaceContextError);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });

    const flaky = fakeFetch((call, index) => {
      if (call.url.endsWith('/auth/device')) return json(started, 201);
      if (index === 1) throw new TypeError('fetch failed');
      return index === 2 ? apiError(400, 'AUTHORIZATION_PENDING') : json(token);
    });
    expect(await deviceSignIn({ baseUrl: BASE, fetch: flaky.fetch, onCode: () => undefined })).toEqual(token);
    expect(flaky.calls).toHaveLength(4);

    // Still no answer when the code expires: the network error, not a hang.
    const gone = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(waitForDeviceSignIn({ ...started, expires_in: 0 }, { baseUrl: BASE, fetch: gone.fetch })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('gives up when the code outlives its time, and refuses a plain-http API', async () => {
    const { fetch } = fakeFetch(() => apiError(400, 'AUTHORIZATION_PENDING'));
    await expect(waitForDeviceSignIn({ ...started, expires_in: 0 }, { baseUrl: BASE, fetch })).rejects.toMatchObject({ code: 'DEVICE_CODE_EXPIRED' });
    await expect(startDeviceSignIn({ baseUrl: 'http://api.example.test/v1', fetch })).rejects.toMatchObject({ code: 'INVALID_BASE_URL' });
    const refused = fakeFetch(() => apiError(429, 'RATE_LIMIT_EXCEEDED'));
    await expect(startDeviceSignIn({ baseUrl: BASE, fetch: refused.fetch })).rejects.toMatchObject({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
  });
});
