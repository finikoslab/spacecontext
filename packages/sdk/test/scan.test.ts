import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeScan, parseServerSentEvents, SpaceContext, SpaceContextError, type Scan, type ScanProgress } from '../src/index.js';

// `sc.scan()` in one call, the event stream under it, and the Markdown export.

const LIVE = 'sc_live_abcdefghijklmnop';
const BASE = 'https://api.example.test/v1';
const SCAN_ID = `scn_${'a'.repeat(32)}`;
const SPACE_ID = `spc_${'b'.repeat(32)}`;

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string) => json({ error: { code, message: `${code} message`, request_id: 'req_1' } }, status);

function scan(overrides: Partial<Scan> = {}): Scan {
  return {
    object: 'scan',
    id: SCAN_ID,
    space_id: SPACE_ID,
    livemode: true,
    status: 'awaiting_upload',
    stage: null,
    input: { kind: 'video', language: 'en', frame_count: null, video: { content_type: 'video/mp4', content_length: 4 }, has_transcript: false },
    charge: { kind: null, price_cents: 100, refunded: false },
    error: null,
    upload: { kind: 'video', method: 'PUT', url: `${BASE}/scans/${SCAN_ID}/video`, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' }, max_bytes: 100 },
    created_at: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  } as Scan;
}

/** An event stream of these scans (`null` = a ping), closed at the end. */
function sse(events: Array<Scan | null>, options: { chunked?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const text = events
    .map((entry, index) => (entry === null ? 'event: ping\ndata: \n\n' : `event: scan\nid: ${index + 1}\ndata: ${JSON.stringify(entry)}\n\n`))
    .join('');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.chunked) {
        // Split in the middle of events: the parser must not care.
        for (let at = 0; at < text.length; at += 7) controller.enqueue(encoder.encode(text.slice(at, at + 7)));
      } else {
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
}

/**
 * A stream that sends the scan once, then only a ping every second and never
 * ends by itself, as the API does while a stage lasts. It ignores the request's
 * abort: only cancelling it stops it.
 */
function pinging(first: Scan, cancelled: { count: number }): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: scan\nid: 1\ndata: ${JSON.stringify(first)}\n\n`));
      const ping = () => {
        controller.enqueue(encoder.encode('event: ping\ndata: \n\n'));
        timer = setTimeout(ping, 1000);
      };
      timer = setTimeout(ping, 1000);
    },
    cancel() {
      clearTimeout(timer);
      cancelled.count += 1;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** The API's answer when the account already holds its 10 open event streams. */
function streamsBusy(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'At most 10 event streams of an account can be open at once: close one, or poll GET /v1/scans/{id}',
        request_id: 'req_1',
        retry_after: 30,
        max_streams: 10,
      },
    }),
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } }
  );
}

function client(fetch: typeof globalThis.fetch) {
  return new SpaceContext({ apiKey: LIVE, baseUrl: BASE, fetch, maxRetries: 0 });
}

const document = { object: 'space_document', space: { id: SPACE_ID, name: 'Flat' }, items: [] };

afterEach(() => {
  vi.useRealTimers();
});

describe('parseServerSentEvents', () => {
  it('reads events as they arrive, whatever the chunking and the line endings', async () => {
    const encoder = new TextEncoder();
    const chunks = ['event: scan\r\nid: 1\r\ndata: {"a":1}\r\n\r\n: a comment\n\ndata: first\ndata: second\n\n', 'event: pi', 'ng\ndata: \n\n', 'data: tail'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseServerSentEvents(body)) events.push(event);
    expect(events).toEqual([
      { event: 'scan', id: '1', data: '{"a":1}' },
      { event: 'message', id: null, data: 'first\nsecond' },
      { event: 'ping', id: null, data: '' },
      { event: 'message', id: null, data: 'tail' },
    ]);
  });
});

describe('scans.events and scans.wait', () => {
  it('yields each change from the stream and stops after the final state', async () => {
    const { fetch, calls } = fakeFetch(() =>
      sse([scan({ status: 'queued' }), null, scan({ status: 'processing', stage: 'observing' }), scan({ status: 'processing', stage: 'observing' }), scan({ status: 'complete' })], { chunked: true })
    );
    const seen: string[] = [];
    for await (const current of client(fetch).scans.events(SCAN_ID)) seen.push(current.stage ?? current.status);
    // The repeated event is not yielded twice; the ping is not a scan.
    expect(seen).toEqual(['queued', 'observing', 'complete']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toMatchObject({ url: `${BASE}/scans/${SCAN_ID}/events`, method: 'GET' });
    expect(calls[0]!.headers).toMatchObject({ accept: 'text/event-stream', authorization: `Bearer ${LIVE}` });
  });

  it('opens the stream again when it ends before the final state', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch((_call, index) => (index === 0 ? sse([scan({ status: 'queued' })]) : sse([scan({ status: 'queued' }), scan({ status: 'complete' })])));
    const stages: string[] = [];
    const done = client(fetch).scans.wait(SCAN_ID, { onProgress: (current) => stages.push(current.status) });
    await vi.advanceTimersByTimeAsync(1500);
    expect((await done).status).toBe('complete');
    expect(calls).toHaveLength(2);
    expect(stages).toEqual(['queued', 'complete']);
  });

  it('opens the stream again when the connection drops mid-stream, and while the network is down', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    // The first event arrives, then the read fails as a dropped connection does.
    const dropped = () => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.error(new TypeError('terminated'));
          sent = true;
          controller.enqueue(encoder.encode(`event: scan\nid: 1\ndata: ${JSON.stringify(scan({ status: 'queued' }))}\n\n`));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const { fetch, calls } = fakeFetch((_call, index) => {
      if (index === 0) return dropped();
      if (index === 1) throw new TypeError('fetch failed');
      return sse([scan({ status: 'processing', stage: 'observing' }), scan({ status: 'complete' })]);
    });
    const seen: string[] = [];
    const done = client(fetch).scans.wait(SCAN_ID, { onProgress: (current) => seen.push(current.stage ?? current.status) });
    await vi.advanceTimersByTimeAsync(2500);
    expect((await done).status).toBe('complete');
    expect(calls.map((call) => call.url)).toEqual(Array(3).fill(`${BASE}/scans/${SCAN_ID}/events`));
    expect(seen).toEqual(['queued', 'observing', 'complete']);
  });

  it("throws the caller's abort instead of opening the stream again", async () => {
    const controller = new AbortController();
    let opened = 0;
    const fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      opened += 1;
      const signal = init.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(`event: scan\ndata: ${JSON.stringify(scan({ status: 'queued' }))}\n\n`));
        },
        // Then nothing until the request is aborted, which errors the body as fetch does.
        pull(stream) {
          return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(stream.error(signal.reason)), { once: true }));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    const stop = new Error('stopped by the caller');
    const outcome = client(fetch)
      .scans.wait(SCAN_ID, { onProgress: () => controller.abort(stop) }, { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(await outcome).toBe(stop);
    expect(opened).toBe(1);
  });

  it('polls where the API cannot stream to this client, and reports the error of a refused scan', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch((call, index) => {
      if (call.url.endsWith('/events')) return json(scan({ status: 'queued' })); // a proxy answered JSON, not a stream
      return index === 1 ? json(scan({ status: 'queued' })) : json(scan({ status: 'failed', error: { code: 'FOOTAGE_UNUSABLE', message: 'Too dark' } }));
    });
    const waiting = client(fetch).scans.wait(SCAN_ID, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    const final = await waiting;
    expect(final.status).toBe('failed');
    expect(calls.map((call) => call.url.split('/v1')[1])).toEqual([`/scans/${SCAN_ID}/events`, `/scans/${SCAN_ID}`, `/scans/${SCAN_ID}`]);

    const { fetch: missing } = fakeFetch(() => apiError(404, 'NOT_FOUND'));
    await expect(client(missing).scans.wait(SCAN_ID)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('gives up at the deadline', async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch(() => sse([scan({ status: 'queued' })]));
    const waiting = client(fetch).scans.wait(SCAN_ID, { timeoutMs: 2500 });
    const outcome = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
  });

  it('gives up at the deadline while the stream only sends pings, and lets the stream go', async () => {
    vi.useFakeTimers();
    const cancelled = { count: 0 };
    const { fetch, calls } = fakeFetch(() => pinging(scan({ status: 'processing', stage: 'observing' }), cancelled));
    const outcome = client(fetch).scans.wait(SCAN_ID, { timeoutMs: 2000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1900);
    expect(cancelled.count).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    const error = await outcome;
    expect(error).toMatchObject({ code: 'TIMEOUT', status: 0 });
    // The last state known comes with the timeout.
    expect((error as SpaceContextError).details.scan).toMatchObject({ status: 'processing', stage: 'observing' });
    // One stream, closed at the deadline: it no longer holds one of the account's slots.
    expect(calls).toHaveLength(1);
    expect(cancelled.count).toBe(1);

    // The same for the iterator, and for a stream that does not even open.
    const hanging = ((_input: RequestInfo | URL, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))) as typeof globalThis.fetch;
    const iterated = (async () => {
      for await (const current of client(hanging).scans.events(SCAN_ID, { timeoutMs: 1500 })) void current;
    })().catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await iterated).toMatchObject({ code: 'TIMEOUT' });
  });

  it('polls when the account has all its event streams open (429), at once and less often while nothing changes', async () => {
    vi.useFakeTimers();
    const states = [scan({ status: 'processing', stage: 'observing' }), scan({ status: 'processing', stage: 'observing' }), scan({ status: 'complete' })];
    let polls = 0;
    const { fetch, calls } = fakeFetch((call) => (call.url.endsWith('/events') ? streamsBusy() : json(states[Math.min(polls++, states.length - 1)])));
    // Default retries: the stream's 429 is still not waited out.
    const sc = new SpaceContext({ apiKey: LIVE, baseUrl: BASE, fetch });
    const seen: string[] = [];
    const done = sc.scans.wait(SCAN_ID, { intervalMs: 1000, onProgress: (current) => seen.push(current.stage ?? current.status) });
    const routes = () => calls.map((call) => call.url.split('/v1')[1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(routes()).toEqual([`/scans/${SCAN_ID}/events`, `/scans/${SCAN_ID}`]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(3);
    // Unchanged: the next poll waits longer (1.5 s, not 1 s).
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(500);
    expect((await done).status).toBe('complete');
    expect(routes()).toEqual([`/scans/${SCAN_ID}/events`, `/scans/${SCAN_ID}`, `/scans/${SCAN_ID}`, `/scans/${SCAN_ID}`]);
    expect(seen).toEqual(['observing', 'complete']);
  });

  it('polls when the stream fails, and asks again no sooner than the API says when a poll is refused for load', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/events')) return apiError(500, 'INTERNAL_ERROR');
      polls += 1;
      if (polls === 1) return new Response(JSON.stringify({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests', request_id: 'req_1', retry_after: 5 } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } });
      return json(scan({ status: 'complete' }));
    });
    const done = client(fetch).scans.wait(SCAN_ID, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(4900);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect((await done).status).toBe('complete');
    expect(calls).toHaveLength(3);
  });
});

describe('scan() in one call', () => {
  function flow(options: { fail?: boolean; markdown?: string; streamsBusy?: boolean } = {}) {
    let polls = 0;
    return fakeFetch((call) => {
      const route = `${call.method} ${call.url.split('/v1')[1]!.split('?')[0]}`;
      switch (route) {
        case 'POST /spaces':
          return json({ object: 'space', id: SPACE_ID, name: 'Flat' }, 201);
        case `POST /spaces/${SPACE_ID}/scans`:
          return json(scan(), 201);
        case `PUT /scans/${SCAN_ID}/video`:
          return json({ object: 'scan_upload' });
        case `PUT /scans/${SCAN_ID}/frames/0`:
        case `PUT /scans/${SCAN_ID}/frames/1`:
          return json({ object: 'scan_frame' });
        case `POST /scans/${SCAN_ID}/start`:
          return json(scan({ status: 'queued', charge: { kind: 'free_scan', price_cents: 0, refunded: false } }));
        case `GET /scans/${SCAN_ID}`:
          return json(polls++ === 0 ? scan({ status: 'processing', stage: 'observing' }) : scan({ status: 'complete' }));
        case `GET /scans/${SCAN_ID}/events`:
          if (options.streamsBusy) return streamsBusy();
          return sse([
            scan({ status: 'queued' }),
            scan({ status: 'processing', stage: 'observing' }),
            options.fail
              ? scan({ status: 'failed', error: { code: 'ANALYSIS_EMPTY', message: 'No space was recognised' }, charge: { kind: 'free_scan', price_cents: 0, refunded: true } })
              : scan({ status: 'complete' }),
          ]);
        case `GET /spaces/${SPACE_ID}`:
          return json(document);
        case `GET /spaces/${SPACE_ID}/markdown`:
          return new Response(options.markdown ?? '# Flat\n', { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
        case `GET /spaces/${SPACE_ID}/skill`:
          return json({ name: 'space-flat', files: [] });
        default:
          return apiError(500, `UNEXPECTED ${route}`);
      }
    });
  }

  it('creates the space, uploads the video, follows the scan and returns the document with the Markdown page', async () => {
    const { fetch, calls } = flow({ markdown: '# Flat\n\nSummary\n' });
    const progress: ScanProgress[] = [];
    const video = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });

    const result = await client(fetch).scan(video, { name: 'Flat', type: 'apartment', format: 'markdown', onProgress: (event) => progress.push(event) });

    expect(result.spaceId).toBe(SPACE_ID);
    expect(result.scan.status).toBe('complete');
    expect(result.document).toEqual(document);
    expect(result.markdown).toBe('# Flat\n\nSummary\n');
    expect(progress.map((event) => (event.type === 'scan' ? `scan:${event.stage}` : event.type))).toEqual([
      'space_created',
      'uploading',
      'uploaded',
      'started',
      'scan:queued',
      'scan:observing',
      'scan:complete',
      'complete',
    ]);
    const labels = progress.flatMap((event) => (event.type === 'scan' ? [event.label] : []));
    expect(labels).toEqual(['Queued', 'Looking at the frames', 'Complete']);
    expect(calls.map((call) => `${call.method} ${call.url.split('/v1')[1]!.split('?')[0]}`)).toEqual([
      'POST /spaces',
      `POST /spaces/${SPACE_ID}/scans`,
      `PUT /scans/${SCAN_ID}/video`,
      `POST /scans/${SCAN_ID}/start`,
      `GET /scans/${SCAN_ID}/events`,
      `GET /spaces/${SPACE_ID}`,
      `GET /spaces/${SPACE_ID}/markdown`,
    ]);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ name: 'Flat', space_type: 'apartment' });
    expect(calls[6]!.headers.accept).toBe('text/markdown');
  });

  it('scans a folder of photos into an existing space, one frame per file in name order, and returns the Skill', async () => {
    const { fetch, calls } = flow();
    const directory = await mkdtemp(path.join(tmpdir(), 'sc-scan-'));
    try {
      await writeFile(path.join(directory, 'frame-10.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 1]));
      await writeFile(path.join(directory, 'frame-2.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      await writeFile(path.join(directory, 'notes.txt'), 'ignored');
      const progress: ScanProgress[] = [];
      const result = await client(fetch).scan(directory, { space: SPACE_ID, format: 'skill', language: 'it', onProgress: (event) => progress.push(event) });
      expect(result.skill).toEqual({ name: 'space-flat', files: [] });
      const created = JSON.parse(calls.find((call) => call.url.endsWith('/scans'))!.body as string);
      expect(created.input).toMatchObject({ kind: 'frames', language: 'it', frames: [{ timestamp_ms: null }, { timestamp_ms: null }] });
      // Natural order: frame-2 before frame-10; each sent with its own type.
      const uploads = calls.filter((call) => call.url.includes('/frames/'));
      expect(uploads.map((call) => call.headers['content-type'])).toEqual(['image/png', 'image/jpeg']);
      expect(progress.filter((event) => event.type === 'uploading')).toEqual([
        { type: 'uploading', part: 1, parts: 2, bytes: 8 },
        { type: 'uploading', part: 2, parts: 2, bytes: 8 },
      ]);
      expect(progress.some((event) => event.type === 'space_created')).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('follows the scan by polling when the account has all its event streams open, instead of failing a scan already charged', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = flow({ streamsBusy: true });
    const stages: string[] = [];
    const result = client(fetch).scan(
      { video: new Uint8Array([1, 2, 3, 4]), contentType: 'video/mp4' },
      { space: SPACE_ID, onProgress: (event) => (event.type === 'scan' ? stages.push(event.stage) : undefined) }
    );
    await vi.advanceTimersByTimeAsync(3500);
    const finished = await result;
    expect(finished.scan.status).toBe('complete');
    expect(finished.document).toEqual(document);
    expect(stages).toEqual(['observing', 'complete']);
    expect(calls.filter((call) => call.url.endsWith('/events'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith(`/scans/${SCAN_ID}`) && call.method === 'GET')).toHaveLength(2);
  });

  it('throws the scan error when the scan fails, with the scan attached', async () => {
    const { fetch } = flow({ fail: true });
    const error = await client(fetch)
      .scan({ video: new Uint8Array([1, 2, 3, 4]), contentType: 'video/mp4' }, { space: SPACE_ID })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpaceContextError);
    expect(error).toMatchObject({ code: 'ANALYSIS_EMPTY', message: 'Scan failed: No space was recognised (refunded)' });
    expect((error as SpaceContextError).details.scan).toMatchObject({ status: 'failed' });
  });

  it('refuses what it cannot scan before touching the API', async () => {
    const { fetch, calls } = flow();
    const sc = client(fetch);
    await expect(sc.scan(new Blob([new Uint8Array([1])]), { name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sc.scan({ frames: [] }, { name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sc.scan({ video: new Uint8Array(4), contentType: 'video/mp4' }, {})).rejects.toThrow(/space.*name/);
    await expect(sc.scan({ video: new Uint8Array(4), contentType: 'video/mp4' }, { space: SPACE_ID, name: 'x' })).rejects.toThrow(/space.*name/);
    await expect(sc.scan(path.join(tmpdir(), 'sc-nope-' + crypto.randomUUID()), { name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sc.scan({ frames: [new Blob([new Uint8Array([1])])] }, { name: 'x' })).rejects.toThrow(/Frame 0/);
    expect(calls).toHaveLength(0);
  });

  it('describes every stage in words', () => {
    expect(describeScan({ status: 'processing', stage: 'enriching' })).toEqual({ stage: 'enriching', label: 'Extracting the context' });
    expect(describeScan({ status: 'processing', stage: null })).toEqual({ stage: 'processing', label: 'Processing' });
    expect(describeScan({ status: 'failed', stage: null })).toEqual({ stage: 'failed', label: 'Failed' });
  });
});

describe('spaces.markdown', () => {
  it('asks for text/markdown and returns the page', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('# Flat\n', { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }));
    expect(await client(fetch).spaces.markdown(SPACE_ID, { include: 'transcript' })).toBe('# Flat\n');
    expect(calls[0]!.url).toBe(`${BASE}/spaces/${SPACE_ID}/markdown?include=transcript`);
    expect(calls[0]!.headers.accept).toBe('text/markdown');
  });
});
