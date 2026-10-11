import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPORT_LANGUAGES, SpaceContext, SpaceContextError, VIDEO_CONTENT_TYPES, type Scan } from '../src/index.js';

const LIVE = 'sc_live_abcdefghijklmnop';
const TEST = 'sc_test_abcdefghijklmnop';
const BASE = 'https://api.example.test/v1';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: string | undefined };

/** A fetch that answers from `handler` and records every request. */
function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body,
      redirect: init.redirect,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json({ error: { code, message: `${code} message`, request_id: 'req_1', ...extra } }, status, headers);

function client(fetch: typeof globalThis.fetch, options: { apiKey?: string; maxRetries?: number } = {}) {
  return new SpaceContext({ apiKey: options.apiKey ?? LIVE, baseUrl: BASE, fetch, maxRetries: options.maxRetries });
}

function scan(overrides: Partial<Scan> = {}): Scan {
  return {
    object: 'scan',
    id: `scn_${'a'.repeat(32)}`,
    space_id: `spc_${'b'.repeat(32)}`,
    livemode: true,
    status: 'awaiting_upload',
    stage: null,
    input: { kind: 'video', language: 'en', frame_count: null, video: { content_type: 'video/mp4', content_length: 4 }, has_transcript: false },
    charge: { kind: null, price_cents: 100, refunded: false },
    error: null,
    upload: { kind: 'video', method: 'PUT', url: `${BASE}/scans/scn_${'a'.repeat(32)}/video`, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' }, max_bytes: 100 },
    created_at: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  } as Scan;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('SpaceContext client', () => {
  it('checks a frame with the image as the body, and nothing else', async () => {
    const answer = {
      object: 'frame_check',
      livemode: true,
      usable: true,
      quality: { score: 2.4, level: 'good' },
      shows_space: 0.99,
      key_locations: [{ kind: 'electrical_panel', probability: 0.91, seen: true }],
    };
    const { fetch, calls } = fakeFetch(() => json(answer));
    const image = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    const result = await client(fetch).frames.check(image, 'image/jpeg');
    expect(result.key_locations[0]!).toEqual({ kind: 'electrical_panel', probability: 0.91, seen: true });
    expect(calls[0]!).toMatchObject({ url: `${BASE}/frames/check`, method: 'POST', body: image });
    expect(calls[0]!.headers).toMatchObject({ 'content-type': 'image/jpeg', authorization: `Bearer ${LIVE}` });
  });

  it('needs a well-formed key, reads the environment, and refuses plain http', () => {
    expect(() => new SpaceContext({ apiKey: 'nope' })).toThrow(SpaceContextError);
    vi.stubEnv('SPACECONTEXT_API_KEY', '');
    expect(() => new SpaceContext()).toThrow(/API key/);
    vi.stubEnv('SPACECONTEXT_API_KEY', TEST);
    const fromEnv = new SpaceContext();
    expect(fromEnv.mode).toBe('test');
    expect(fromEnv.baseUrl).toBe('https://api.spacecontext.app/v1');
    expect(new SpaceContext({ apiKey: LIVE, baseUrl: `${BASE}/` }).baseUrl).toBe(BASE);
    expect(() => new SpaceContext({ apiKey: LIVE, baseUrl: 'http://api.example.test/v1' })).toThrow(/https/);
    expect(new SpaceContext({ apiKey: LIVE, baseUrl: 'http://localhost:8787/v1' }).baseUrl).toBe('http://localhost:8787/v1');
  });

  it('sends the key to the API only, with the query it was given', async () => {
    const { fetch, calls } = fakeFetch(() => json({ object: 'search_results', query: 'stopcock', data: [] }));
    const result = await client(fetch).search('stopcock', { spaceId: 'spc_1', limit: 5 });

    expect(result.object).toBe('search_results');
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'stopcock', space_id: 'spc_1', limit: '5' });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${LIVE}`);
    expect(calls[0]!.redirect).toBe('manual');
  });

  it('encodes path segments and leaves out unset parameters', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    await client(fetch).spaces.get('app_a/b', { include: 'transcript' });
    await client(fetch).spaces.diff('spc_1', { from: 'scn_1' });
    expect(calls[0]!.url).toBe(`${BASE}/spaces/app_a%2Fb?include=transcript`);
    expect(calls[1]!.url).toBe(`${BASE}/spaces/spc_1/diff?from=scn_1`);
  });

  it('turns the error envelope into a SpaceContextError with its code and details', async () => {
    const { fetch } = fakeFetch(() => apiError(409, 'ENRICHMENT_PENDING', { space_id: 'app_1' }));
    const error = await client(fetch).spaces.skill('app_1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpaceContextError);
    expect(error).toMatchObject({ status: 409, code: 'ENRICHMENT_PENDING', requestId: 'req_1', message: 'ENRICHMENT_PENDING message' });
    expect((error as SpaceContextError).details.space_id).toBe('app_1');

    const { fetch: html } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 500 }));
    await expect(client(html).me()).rejects.toMatchObject({ status: 500, code: 'HTTP_500', requestId: null });
  });

  it('retries what the API refused for load, and only what is safe to send twice', async () => {
    // 429 then success: retried, honouring Retry-After.
    const limited = fakeFetch((_call, index) => (index === 0 ? apiError(429, 'RATE_LIMIT_EXCEEDED', {}, { 'Retry-After': '0' }) : json({ id: 'spc_1' })));
    await expect(client(limited.fetch).spaces.create({ name: 'Flat' })).resolves.toEqual({ id: 'spc_1' });
    expect(limited.calls).toHaveLength(2);

    // 503 on a GET: retried.
    const flaky = fakeFetch((_call, index) => (index < 2 ? apiError(503, 'UNAVAILABLE', {}, { 'Retry-After': '0' }) : json({ user: {} })));
    await expect(client(flaky.fetch).me()).resolves.toEqual({ user: {} });
    expect(flaky.calls).toHaveLength(3);

    // 503 on creating a space: not retried, it may have been created.
    const unsafe = fakeFetch(() => apiError(503, 'UNAVAILABLE'));
    await expect(client(unsafe.fetch).spaces.create({ name: 'Flat' })).rejects.toMatchObject({ status: 503 });
    expect(unsafe.calls).toHaveLength(1);

    // A daily limit: waiting would not help.
    const daily = fakeFetch(() => apiError(429, 'RATE_LIMIT_EXCEEDED', { retry_after: 3600 }));
    await expect(client(daily.fetch).search('oven')).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(daily.calls).toHaveLength(1);

    // Ten scans running: not a rate limit, waiting a minute would not help either.
    const busy = fakeFetch(() => apiError(429, 'SCANS_IN_PROGRESS', { retry_after: 60 }));
    await expect(client(busy.fetch).scans.start('scn_1')).rejects.toMatchObject({ status: 429, code: 'SCANS_IN_PROGRESS' });
    expect(busy.calls).toHaveLength(1);

    // maxRetries bounds the attempts.
    const always = fakeFetch(() => apiError(429, 'RATE_LIMIT_EXCEEDED', {}, { 'Retry-After': '0' }));
    await expect(client(always.fetch, { maxRetries: 1 }).search('oven')).rejects.toMatchObject({ status: 429 });
    expect(always.calls).toHaveLength(2);
  });

  it('cancels a scan and deletes a space without expecting a body, and does not repeat them', async () => {
    const ok = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(client(ok.fetch).scans.cancel('scn_1')).resolves.toBeUndefined();
    await expect(client(ok.fetch).spaces.delete('spc_1')).resolves.toBeUndefined();
    expect(ok.calls.map((call) => call.method)).toEqual(['DELETE', 'DELETE']);

    const flaky = fakeFetch(() => apiError(503, 'UNAVAILABLE', {}, { 'Retry-After': '0' }));
    await expect(client(flaky.fetch).scans.cancel('scn_1')).rejects.toMatchObject({ status: 503 });
    expect(flaky.calls).toHaveLength(1);
  });

  it('gives up at once on a 429 that asks for a longer wait than allowed', async () => {
    const limited = fakeFetch(() => apiError(429, 'RATE_LIMIT_EXCEEDED', {}, { 'Retry-After': '60' }));
    const sc = new SpaceContext({ apiKey: LIVE, baseUrl: BASE, fetch: limited.fetch, maxRetryDelayMs: 5000 });
    await expect(sc.search('oven')).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', retryAfter: 60 });
    expect(limited.calls).toHaveLength(1);
  });

  it('never follows a redirect', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/v1/me' } }));
    await expect(client(fetch).me()).rejects.toMatchObject({ status: 302, code: 'HTTP_302' });
  });

  it('reports network failures with their own codes', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(client(down.fetch, { maxRetries: 0 }).me()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });

    const slow = fakeFetch(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    await expect(client(slow.fetch, { maxRetries: 0 }).me()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('creates scans with an idempotency key, reused on retry', async () => {
    const { fetch, calls } = fakeFetch((_call, index) => (index === 0 ? apiError(503, 'UNAVAILABLE', {}, { 'Retry-After': '0' }) : json(scan())));
    await client(fetch).scans.create('spc_1', { kind: 'frames', frames: [{ timestamp_ms: 0 }] });
    expect(calls).toHaveLength(2);
    const key = calls[0]!.headers['idempotency-key'];
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(calls[1]!.headers['idempotency-key']).toBe(key);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ input: { kind: 'frames', frames: [{ timestamp_ms: 0 }] } });

    await client(fetch).scans.create('spc_1', { kind: 'frames' }, { idempotencyKey: 'my-key-123' });
    expect(calls.at(-1)!.headers['idempotency-key']).toBe('my-key-123');
  });

  it('uploads a video straight to storage without the API key', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const direct = scan({ upload: { kind: 'video', method: 'PUT', url: 'https://bucket.r2.example/key?X-Amz-Signature=1', headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' } } as Scan['upload'] });
    await client(fetch).scans.uploadVideo(direct, new Uint8Array([1, 2, 3, 4]));
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://bucket.r2.example/key?X-Amz-Signature=1' });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers['content-type']).toBe('video/mp4');

    // Through the API: the key is needed and sent.
    await client(fetch).scans.uploadVideo(scan(), new Blob([new Uint8Array([1, 2, 3, 4])]));
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${LIVE}`);

    // A host that only looks like the API does not get the key.
    const lookalike = scan({ upload: { kind: 'video', method: 'PUT', url: 'https://api.example.test.evil.example/v1/scans/x/video' } as Scan['upload'] });
    await client(fetch).scans.uploadVideo(lookalike, new Uint8Array([1, 2, 3, 4]));
    expect(calls[2]!.headers.authorization).toBeUndefined();
  });

  it('checks the video against what the scan declared before sending it', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    await expect(client(fetch).scans.uploadVideo(scan(), new Uint8Array(5))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const small = scan({ input: { ...scan().input, video: { content_type: 'video/mp4', content_length: 200 } } });
    await expect(client(fetch).scans.uploadVideo(small, new Uint8Array(200))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(client(fetch).scans.uploadVideo(scan({ upload: null }), new Uint8Array(4))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(calls).toEqual([]);
  });

  it('chains create, upload and start for a scan from frames', async () => {
    const created = scan({ input: { kind: 'frames', language: 'it', frame_count: 2, video: null, has_transcript: false }, upload: null });
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith('/start') ? json({ ...created, status: 'queued' }, 202) : call.method === 'PUT' ? json({ object: 'scan_frame' }) : json(created, 201)
    );
    const started = await client(fetch).scans.fromFrames(
      'spc_1',
      [
        { data: new Uint8Array([1]), contentType: 'image/jpeg', timestampMs: 0 },
        { data: new Uint8Array([2]), contentType: 'image/png' },
      ],
      { language: 'it' }
    );
    expect(started.status).toBe('queued');
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /v1/spaces/spc_1/scans',
      `PUT /v1/scans/${created.id}/frames/0`,
      `PUT /v1/scans/${created.id}/frames/1`,
      `POST /v1/scans/${created.id}/start`,
    ]);
    expect(JSON.parse(String(calls[0]!.body)).input).toEqual({ kind: 'frames', language: 'it', frames: [{ timestamp_ms: 0 }, { timestamp_ms: null }] });
    expect(calls[2]!.headers['content-type']).toBe('image/png');
  });

  it('chains create, upload and start for a video, declaring its size', async () => {
    const { fetch, calls } = fakeFetch((call) => (call.url.endsWith('/start') ? json(scan({ status: 'queued', upload: null }), 202) : call.method === 'PUT' ? json({}) : json(scan(), 201)));
    await client(fetch).scans.fromVideo('spc_1', { data: new Uint8Array(4), contentType: 'video/mp4' });
    expect(JSON.parse(String(calls[0]!.body)).input).toEqual({ kind: 'video', language: 'en', video: { content_type: 'video/mp4', content_length: 4 } });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT', 'POST']);
  });

  it('lists the report languages of the contract, and sends the one asked for', async () => {
    const contract = JSON.parse(await readFile(new URL('../../../openapi/openapi.json', import.meta.url), 'utf8')) as {
      components: { schemas: Record<string, { properties: { input: { properties: { language: { enum: string[] } } } } }> };
    };
    expect([...REPORT_LANGUAGES]).toEqual(['en', 'it', 'es', 'fr', 'de', 'pt', 'nl']);
    expect(contract.components.schemas.ScanCreateRequest!.properties.input.properties.language.enum).toEqual([...REPORT_LANGUAGES]);
    expect(contract.components.schemas.Scan!.properties.input.properties.language.enum).toEqual([...REPORT_LANGUAGES]);

    const { fetch, calls } = fakeFetch((call) => (call.url.endsWith('/start') ? json(scan({ status: 'queued', upload: null }), 202) : call.method === 'PUT' ? json({}) : json(scan(), 201)));
    await client(fetch).scans.fromVideo('spc_1', { data: new Uint8Array(4), contentType: 'video/mp4', language: 'pt' });
    expect(JSON.parse(String(calls[0]!.body)).input).toMatchObject({ kind: 'video', language: 'pt' });
  });

  it('lists the video containers of the contract', async () => {
    const contract = JSON.parse(await readFile(new URL('../../../openapi/openapi.json', import.meta.url), 'utf8')) as {
      components: { schemas: Record<string, { properties: { input: { properties: { video: { properties: { content_type: { enum: string[] } } } } } } }> };
    };
    expect(contract.components.schemas.ScanCreateRequest!.properties.input.properties.video.properties.content_type.enum).toEqual([...VIDEO_CONTENT_TYPES]);
  });

  it('cancels a scan whose upload fails, and refuses oversized frames before sending them', async () => {
    const created = scan({ input: { kind: 'frames', language: 'en', frame_count: 2, video: null, has_transcript: false }, upload: { kind: 'frames', method: 'PUT', url_template: `${BASE}/scans/x/frames/{index}`, max_bytes: 4 } as Scan['upload'] });
    const big = fakeFetch((call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : json(created, 201)));
    await expect(
      client(big.fetch).scans.fromFrames('spc_1', [
        { data: new Uint8Array(4), contentType: 'image/jpeg' },
        { data: new Uint8Array(5), contentType: 'image/jpeg' },
      ])
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { index: 1 } });
    expect(big.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /v1/spaces/spc_1/scans', `DELETE /v1/scans/${created.id}`]);

    const failing = fakeFetch((call) =>
      call.method === 'POST' ? json(scan(), 201) : call.method === 'PUT' ? apiError(413, 'FILE_TOO_LARGE') : new Response(null, { status: 204 })
    );
    await expect(client(failing.fetch).scans.fromVideo('spc_1', { data: new Uint8Array(4), contentType: 'video/mp4' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(failing.calls.map((call) => call.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });

  it('cancels a scan whose start is refused, so that its files are not left waiting', async () => {
    const refused = fakeFetch((call) =>
      call.url.endsWith('/start')
        ? apiError(402, 'INSUFFICIENT_FUNDS')
        : call.method === 'PUT'
          ? json({})
          : call.method === 'DELETE'
            ? new Response(null, { status: 204 })
            : json(scan(), 201)
    );
    await expect(client(refused.fetch).scans.fromVideo('spc_1', { data: new Uint8Array(4), contentType: 'video/mp4' })).rejects.toMatchObject({ status: 402, code: 'INSUFFICIENT_FUNDS' });
    expect(refused.calls.map((call) => `${call.method} ${new URL(call.url).pathname.replace(/scn_a+/, 'scn')}`)).toEqual([
      'POST /v1/spaces/spc_1/scans',
      'PUT /v1/scans/scn/video',
      'POST /v1/scans/scn/start',
      'DELETE /v1/scans/scn',
    ]);
  });

  it('waits for a scan to finish, and gives up at the deadline', async () => {
    vi.useFakeTimers();
    const statuses: Scan['status'][] = ['queued', 'processing', 'complete'];
    // The API cannot stream here (a proxy answers JSON to the event request): the client polls.
    let polls = 0;
    const { fetch } = fakeFetch((call) =>
      call.url.endsWith('/events') ? json(scan({ status: 'queued', upload: null })) : json(scan({ status: statuses[Math.min(polls++, 2)]!, upload: null }))
    );
    const seen: string[] = [];
    const done = client(fetch).scans.wait('scn_1', { intervalMs: 1000, onProgress: (current) => seen.push(current.status) });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toMatchObject({ status: 'complete' });
    expect(seen).toEqual(['queued', 'processing', 'complete']);

    const stuck = fakeFetch(() => json(scan({ status: 'processing', upload: null })));
    const late = client(stuck.fetch).scans.wait('scn_1', { intervalMs: 1000, timeoutMs: 2500 }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await late).toMatchObject({ code: 'TIMEOUT' });
  });

  it('walks every page of spaces', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      new URL(call.url).searchParams.get('cursor') ? json({ data: [{ id: 'app_2' }], next_cursor: null }) : json({ data: [{ id: 'app_1' }], next_cursor: 'c1' })
    );
    const ids: string[] = [];
    for await (const space of client(fetch).spaces.iterate({ source: 'app' })) ids.push(space.id);
    expect(ids).toEqual(['app_1', 'app_2']);
    expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('c1');
  });

  it('downloads evidence frames from this API only, without the key', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(new Uint8Array([255, 216]), { headers: { 'Content-Type': 'image/jpeg' } }));
    const frame = await client(fetch).evidenceFrame(`${BASE}/media/frames/u/p/frame-0.jpg?token=t&expires=1`);
    expect(frame.contentType).toBe('image/jpeg');
    expect(new Uint8Array(frame.data)).toEqual(new Uint8Array([255, 216]));
    expect(calls[0]!.headers.authorization).toBeUndefined();
    await expect(client(fetch).evidenceFrame('https://elsewhere.example/v1/media/x')).rejects.toMatchObject({ code: 'INVALID_URL' });
    await expect(client(fetch).evidenceFrame('https://api.example.test/other/x')).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
});
