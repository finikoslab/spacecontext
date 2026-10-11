import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCAN_LIMITS, describeScan, fileBody, parseServerSentEvents, SpaceContext, SpaceContextError, type Scan, type ScanProgress } from '../src/index.js';

// `sc.scan()` in one call, the event stream under it, and the Markdown export.

const LIVE = 'sc_live_abcdefghijklmnop';
const BASE = 'https://api.example.test/v1';
const SCAN_ID = `scn_${'a'.repeat(32)}`;
const SPACE_ID = `spc_${'b'.repeat(32)}`;

const MB = 1024 * 1024;
const GB = 1024 * MB;

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; duplex: unknown };

function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body,
      duplex: (init as { duplex?: unknown }).duplex,
    };
    calls.push(call);
    // A stream is never read here: closed, as a server that answers would.
    if (init.body instanceof ReadableStream) await init.body.cancel();
    return handler(call, calls.length - 1);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/** `GET /v1`, the API's descriptor; `limits` as a deployment with the server-side ingest says them. */
const descriptor = (limits: Record<string, unknown> | null = { max_video_bytes: 4 * GB, max_video_seconds: 600, max_photos: 120 }) =>
  json({ name: 'space-context-api', version: 'v1', openapi: '/v1/openapi.json', ...(limits ? { limits } : {}) });

/** A video of `size` bytes that is never in memory. */
const sizedVideo = (size: number) => ({ video: { size, stream: () => new ReadableStream<Uint8Array>() }, contentType: 'video/mp4' as const });

/** A file of `size` bytes that takes no room on disk (sparse). */
async function sparseFile(directory: string, name: string, size: number): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, '');
  await truncate(file, size);
  return file;
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

/** `GET /spaces`, `GET ` for the descriptor (`GET /v1`), `PUT storage` for a signed storage link. */
const routeOf = (call: Call) => (call.url.startsWith(BASE) ? `${call.method} ${call.url.slice(BASE.length).split('?')[0]}` : `${call.method} storage`);

describe('scan() in one call', () => {
  function flow(
    options: {
      fail?: boolean;
      markdown?: string;
      streamsBusy?: boolean;
      /** What `GET /v1` answers: the descriptor (default: one without `limits`, as before the field), or a failure. */
      descriptor?: () => Response;
      /** The upload instructions of the scan created. */
      upload?: Scan['upload'];
    } = {}
  ) {
    let polls = 0;
    return fakeFetch((call) => {
      const route = routeOf(call);
      switch (route) {
        case 'GET ':
          return options.descriptor ? options.descriptor() : descriptor(null);
        case 'POST /spaces':
          return json({ object: 'space', id: SPACE_ID, name: 'Flat' }, 201);
        case `POST /spaces/${SPACE_ID}/scans`: {
          // The scan as declared: a video's own type and length.
          const input = JSON.parse(call.body as string).input as { kind: string; video?: { content_type: string; content_length: number } };
          const declared = input.kind === 'video' ? scan({ input: { ...scan().input, video: input.video! } }) : scan();
          return json(options.upload !== undefined ? { ...declared, upload: options.upload } : declared, 201);
        }
        case `DELETE /scans/${SCAN_ID}`:
          return new Response(null, { status: 204 });
        case 'PUT storage':
          return new Response(null, { status: 200 });
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
    expect(calls.map(routeOf)).toEqual([
      // The deployment's limits first: `/v1` itself (the API redirects `/v1/`), without the key.
      'GET ',
      'POST /spaces',
      `POST /spaces/${SPACE_ID}/scans`,
      `PUT /scans/${SCAN_ID}/video`,
      `POST /scans/${SCAN_ID}/start`,
      `GET /scans/${SCAN_ID}/events`,
      `GET /spaces/${SPACE_ID}`,
      `GET /spaces/${SPACE_ID}/markdown`,
    ]);
    expect(calls[0]!.url).toBe(BASE);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[1]!.body as string)).toEqual({ name: 'Flat', space_type: 'apartment' });
    expect(calls[7]!.headers.accept).toBe('text/markdown');
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

  it('takes every container the API reads, by the file extension or the Blob type, and refuses the others before the API', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sc-video-'));
    try {
      const declared = async (source: Parameters<SpaceContext['scan']>[0]) => {
        const { fetch, calls } = flow();
        await client(fetch).scan(source, { space: SPACE_ID });
        return JSON.parse(calls.find((call) => call.url.endsWith('/scans'))!.body as string).input.video;
      };
      for (const [name, type] of [
        ['tour.mp4', 'video/mp4'],
        ['tour.MOV', 'video/quicktime'],
        ['tour.m4v', 'video/x-m4v'],
        ['tour.3gp', 'video/3gpp'],
        ['tour.webm', 'video/webm'],
        ['tour.mkv', 'video/x-matroska'],
      ] as const) {
        await writeFile(path.join(directory, name), new Uint8Array([1, 2, 3, 4]));
        expect(await declared(path.join(directory, name)), name).toEqual({ content_type: type, content_length: 4 });
      }
      // A MediaRecorder's Blob names its codecs: the bare type is declared.
      expect(await declared(new Blob([new Uint8Array(4)], { type: 'video/webm;codecs=vp9,opus' }))).toEqual({ content_type: 'video/webm', content_length: 4 });
      // A File without a type, by its name.
      expect(await declared(new File([new Uint8Array(4)], 'clip.3gp'))).toEqual({ content_type: 'video/3gpp', content_length: 4 });
      expect(await declared({ video: new Uint8Array(4), contentType: 'video/matroska' })).toEqual({ content_type: 'video/matroska', content_length: 4 });

      const { fetch, calls } = flow();
      const sc = client(fetch);
      await writeFile(path.join(directory, 'tour.avi'), new Uint8Array([1, 2, 3, 4]));
      await expect(sc.scan(path.join(directory, 'tour.avi'), { space: SPACE_ID })).rejects.toThrow('expected a video (.mp4 .mov .m4v .3gp .webm .mkv)');
      await expect(sc.scan(new Blob([new Uint8Array(4)], { type: 'video/x-msvideo' }), { space: SPACE_ID })).rejects.toThrow(
        "The Blob's type (video/x-msvideo) is not a video the API takes"
      );
      await expect(sc.scan({ video: new Uint8Array(4), contentType: 'video/ogg' as 'video/mp4' }, { space: SPACE_ID })).rejects.toThrow(
        'contentType must be one of video/mp4, video/quicktime, video/x-m4v, video/3gpp, video/webm, video/x-matroska, video/matroska'
      );
      expect(calls).toHaveLength(0);
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

  it('refuses what it cannot scan before creating anything', async () => {
    const { fetch, calls } = flow();
    const sc = client(fetch);
    await expect(sc.scan(new Blob([new Uint8Array([1])]), { name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sc.scan({ frames: [] }, { name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sc.scan({ video: new Uint8Array(4), contentType: 'video/mp4' }, {})).rejects.toThrow(/space.*name/);
    await expect(sc.scan({ video: new Uint8Array(4), contentType: 'video/mp4' }, { space: SPACE_ID, name: 'x' })).rejects.toThrow(/space.*name/);
    await expect(sc.scan(path.join(tmpdir(), 'sc-nope-' + crypto.randomUUID()), { name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sc.scan({ frames: [new Blob([new Uint8Array([1])])] }, { name: 'x' })).rejects.toThrow(/Frame 0/);
    expect(calls).toHaveLength(0);
    // The API's limits, before a space is created for a scan it would refuse: a
    // deployment that does not say its own takes 120 photos and 100 MB.
    const frame = { data: new Uint8Array([0xff, 0xd8]), contentType: 'image/jpeg' as const };
    await expect(sc.scan({ frames: Array.from({ length: 121 }, () => frame) }, { name: 'x' })).rejects.toThrow(/121 frames: at most 120/);
    await expect(sc.scan({ frames: [frame, { ...frame, data: new Uint8Array(2 * 1024 * 1024 + 1) }] }, { name: 'x' })).rejects.toThrow(/Frame 1 is larger than 2 MB/);
    await expect(sc.scan(sizedVideo(100 * MB + 1), { name: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'The video is 100.0 MB, over the 100 MB this API takes (104857600 bytes): trim it, or compress it (the spacecontext CLI does it when ffmpeg is installed)',
    });
    // Only the descriptor was read, once for the client.
    expect(calls.map(routeOf)).toEqual(['GET ']);
  });

  it("takes a video up to the deployment's limit: 150 MB where the API says 4 GB, read from disk and sent to the storage link", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sc-big-'));
    try {
      const storage = { kind: 'video', method: 'PUT', url: 'https://bucket.r2.example/key?X-Amz-Signature=1', headers: { 'Content-Type': 'video/mp4' } } as Scan['upload'];
      const { fetch, calls } = flow({ descriptor: () => descriptor(), upload: storage });
      const file = await sparseFile(directory, 'tour.mp4', 150 * MB);
      const result = await client(fetch).scan(file, { space: SPACE_ID });
      expect(result.scan.status).toBe('complete');
      expect(JSON.parse(calls.find((call) => call.url.endsWith('/scans'))!.body as string).input.video).toEqual({ content_type: 'video/mp4', content_length: 150 * MB });
      const put = calls.find((call) => call.method === 'PUT')!;
      expect(put.url).toBe('https://bucket.r2.example/key?X-Amz-Signature=1');
      expect(put.headers.authorization).toBeUndefined();
      // Read from disk while it is sent, never into memory.
      expect(put.body).toBeInstanceOf(Blob);
      expect((put.body as Blob).size).toBe(150 * MB);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a video over 100 MB before creating anything when the API does not say its limits (an older deployment)', async () => {
    const { fetch, calls } = flow();
    const error = await client(fetch).scan(sizedVideo(150 * MB), { name: 'Flat' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('The video is 150.0 MB, over the 100 MB this API takes (104857600 bytes)') });
    expect(calls.map(routeOf)).toEqual(['GET ']);
  });

  it('never fails a scan because the descriptor cannot be read: the limits of a deployment that does not say them', async () => {
    for (const failing of [() => apiError(500, 'INTERNAL_ERROR'), () => new Response('<html>gateway</html>', { status: 200 }), () => Promise.reject(new TypeError('fetch failed'))]) {
      const { fetch, calls } = flow({ descriptor: failing as () => Response });
      const sc = client(fetch);
      expect((await sc.scan(sizedVideo(4), { space: SPACE_ID })).scan.status).toBe('complete');
      await expect(sc.scan(sizedVideo(150 * MB), { space: SPACE_ID })).rejects.toThrow('over the 100 MB this API takes');
      // A read that failed is tried again by the next scan.
      expect(calls.filter((call) => routeOf(call) === 'GET ')).toHaveLength(2);
    }
  });

  it('refuses a video over upload.max_bytes before sending it to the API, which offers no storage link here, and cancels the scan', async () => {
    const throughApi = { kind: 'video', method: 'PUT', url: `${BASE}/scans/${SCAN_ID}/video`, headers: { 'Content-Type': 'video/mp4' }, max_bytes: 95 * MB } as Scan['upload'];
    const { fetch, calls } = flow({ descriptor: () => descriptor(), upload: throughApi });
    const error = await client(fetch).scan(sizedVideo(150 * MB), { space: SPACE_ID }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message:
        'The video is 150.0 MB, and this API takes at most 95 MB (99614720 bytes) through itself: it offers no direct upload link to storage, which a bigger video needs. Compress or trim the video',
      details: { max_bytes: 95 * MB },
    });
    expect(calls.map(routeOf)).toEqual(['GET ', `POST /spaces/${SPACE_ID}/scans`, `DELETE /scans/${SCAN_ID}`]);
  });

  it.skipIf(process.platform === 'win32')('sends a file of 4 GiB, whose size fs.openAsBlob gets wrong, as a stream of its exact length; refuses a bigger one by its real size', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sc-4g-'));
    try {
      const storage = { kind: 'video', method: 'PUT', url: 'https://bucket.r2.example/key?X-Amz-Signature=1', headers: { 'Content-Type': 'video/mp4' } } as Scan['upload'];
      const { fetch, calls } = flow({ descriptor: () => descriptor(), upload: storage });
      const sc = client(fetch);
      const exact = await sparseFile(directory, 'exact.mp4', 4 * GB);
      await sc.scan(exact, { space: SPACE_ID });
      expect(JSON.parse(calls.find((call) => call.url.endsWith('/scans'))!.body as string).input.video.content_length).toBe(4 * GB);
      const put = calls.find((call) => call.method === 'PUT')!;
      expect(put.body).toBeInstanceOf(ReadableStream);
      expect(put.headers['content-length']).toBe(String(4 * GB));
      expect(put.duplex).toBe('half');
      expect(put.headers.authorization).toBeUndefined();

      // One byte more: 1 byte for fs.openAsBlob, refused here by its real size.
      const over = await sparseFile(directory, 'over.mp4', 4 * GB + 1);
      await expect(sc.scan(over, { space: SPACE_ID })).rejects.toThrow('The video is 4.0 GB, over the 4 GB this API takes (4294967296 bytes)');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('describes every stage in words', () => {
    expect(describeScan({ status: 'processing', stage: 'enriching' })).toEqual({ stage: 'enriching', label: 'Extracting the context' });
    expect(describeScan({ status: 'processing', stage: null })).toEqual({ stage: 'processing', label: 'Processing' });
    expect(describeScan({ status: 'failed', stage: null })).toEqual({ stage: 'failed', label: 'Failed' });
  });
});

describe.skipIf(process.platform === 'win32')('fileBody', () => {
  it('reads a file of 4 GiB a megabyte at a time from disk, and fails rather than send less than announced', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sc-body-'));
    try {
      const small = path.join(directory, 'small.mp4');
      await writeFile(small, new Uint8Array([1, 2, 3]));
      const blob = await fileBody(small);
      expect(blob).toBeInstanceOf(Blob);
      expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

      const file = await sparseFile(directory, 'big.mp4', 4 * GB);
      const body = await fileBody(file);
      expect(body).not.toBeInstanceOf(Blob);
      expect(body.size).toBe(4 * GB);
      const reader = body.stream().getReader();
      const first = await reader.read();
      expect(first.value!.byteLength).toBe(MB);
      await reader.cancel();

      // Each attempt reads from the first byte; a file cut short fails the upload.
      await truncate(file, MB);
      const again = body.stream().getReader();
      expect((await again.read()).value!.byteLength).toBe(MB);
      await expect(again.read()).rejects.toThrow('got shorter while it was being uploaded');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('limits()', () => {
  it('reads the descriptor once, without the key, and keeps the default of a field missing or malformed', async () => {
    const { fetch, calls } = fakeFetch(() => descriptor({ max_video_bytes: 4 * GB, max_video_seconds: '600', max_photos: 0 }));
    const sc = client(fetch);
    expect(await sc.limits()).toEqual({ maxVideoBytes: 4 * GB, maxVideoSeconds: 600, maxPhotos: 120 });
    expect(await sc.limits()).toEqual({ maxVideoBytes: 4 * GB, maxVideoSeconds: 600, maxPhotos: 120 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: BASE, method: 'GET' });
    expect(calls[0]!.headers.authorization).toBeUndefined();

    const older = fakeFetch(() => descriptor(null));
    expect(await client(older.fetch).limits()).toEqual({ ...DEFAULT_SCAN_LIMITS });
    expect(DEFAULT_SCAN_LIMITS).toEqual({ maxVideoBytes: 100 * MB, maxVideoSeconds: 600, maxPhotos: 120 });
  });

  it('answers the defaults when the descriptor cannot be read, and throws only for the caller\'s own abort', async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await client(down.fetch).limits()).toEqual({ ...DEFAULT_SCAN_LIMITS });
    const redirected = fakeFetch(() => new Response(null, { status: 308, headers: { Location: '/v1' } }));
    expect(await client(redirected.fetch).limits()).toEqual({ ...DEFAULT_SCAN_LIMITS });

    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(client(down.fetch).limits({ signal: controller.signal })).rejects.toThrow('stopped');
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
