import type { components } from '../generated/schema.js';
import { errorFromResponse, SpaceContextError } from '../errors.js';
import { parseServerSentEvents, type ServerSentEvent } from './sse.js';
import { byteLength, FileReadError, formatSize, isUploadStream } from './body.js';
import { runScan, type ScanFormat, type ScanOptions, type ScanResult, type ScanSource } from '../scans/scan.js';

type Schemas = components['schemas'];
export type SpaceDocument = Schemas['SpaceDocument'];
export type SpaceSummary = Schemas['SpaceSummary'];
export type SpaceListResponse = Schemas['SpaceListResponse'];
export type ScanSummary = Schemas['ScanSummary'];
export type ScanListResponse = Schemas['ScanListResponse'];
export type SearchResults = Schemas['SearchResults'];
export type SearchResult = SearchResults['data'][number];
export type SpaceAnswer = Schemas['SpaceAnswer'];
export type SkillBundle = Schemas['SkillBundle'];
export type SpaceDiff = Schemas['SpaceDiff'];
export type ApiSpace = Schemas['ApiSpace'];
export type SpaceCreateRequest = Schemas['SpaceCreateRequest'];
export type Scan = Schemas['Scan'];
export type ScanInput = Schemas['ScanCreateRequest']['input'];
export type ScanUpload = Schemas['ScanUpload'];
export type Wallet = Schemas['Wallet'];
export type MeResponse = Schemas['MeResponse'];
export type FrameCheck = Schemas['FrameCheck'];
export type SpaceCoverageCheck = Schemas['SpaceCoverageCheck'];
export type SpaceType = NonNullable<SpaceCreateRequest['space_type']>;
/** The language a scan's report is written in; the narration can be in any language. */
export type ReportLanguage = NonNullable<ScanInput['language']>;

/**
 * The languages a report can be written in, with their own names: English,
 * Italiano, Español, Français, Deutsch, Português, Nederlands. The narration
 * can be in any language. Default `en`.
 */
export const REPORT_LANGUAGES = ['en', 'it', 'es', 'fr', 'de', 'pt', 'nl'] as const satisfies readonly ReportLanguage[];

export const DEFAULT_BASE_URL = 'https://api.spacecontext.app/v1';

/** How long the limits read from the API are kept: a long-running client sees a new deployment within the hour. */
const LIMITS_TTL_MS = 60 * 60_000;

/** Statuses after which a scan no longer changes. */
export const FINAL_SCAN_STATUSES: ReadonlySet<Scan['status']> = new Set(['complete', 'failed', 'cancelled']);

export type FrameContentType = 'image/jpeg' | 'image/png' | 'image/webp';
/** The container of a scan's video, as the API declares it (`input.video.content_type`). */
export type VideoContentType = NonNullable<ScanInput['video']>['content_type'];

/**
 * The video containers a scan takes: MP4, MOV, M4V, 3GP, WebM and Matroska
 * (both names of its type). Any other type is refused when the scan is
 * declared (400 `INVALID_CONTENT_TYPE`), before anything is charged.
 */
export const VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/3gpp',
  'video/webm',
  'video/x-matroska',
  'video/matroska',
] as const satisfies readonly VideoContentType[];
/**
 * Bytes read as a stream, with their exact length (sent as `Content-Length`,
 * which storage requires). `stream()` is called again for each attempt, so a
 * retry starts from the first byte. `fileBody(path)` returns one for a file of
 * 4 GiB or more. Node.js only: a browser does not let a streamed upload say
 * its length.
 */
export interface UploadStream {
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}
/**
 * Bytes to upload. A `Blob` is read lazily: in Node, `fileBody(path)` uploads a
 * video of gigabytes from disk without loading it in memory.
 */
export type UploadBody = Blob | ArrayBuffer | Uint8Array | UploadStream;

/** What a scan may be on this deployment of the API (`limits` of `GET /v1`). */
export interface ScanLimits {
  /** The largest video, in bytes: 4 GiB where the API reads videos with its own ffmpeg, 100 MiB elsewhere. */
  maxVideoBytes: number;
  /** The longest video, in seconds. */
  maxVideoSeconds: number;
  /** The most photos one scan takes. */
  maxPhotos: number;
}

/**
 * The limits of a deployment that does not say its own (the API before the
 * `limits` field): videos up to 100 MiB and 10 minutes, 120 photos.
 */
export const DEFAULT_SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({ maxVideoBytes: 100 * 1024 * 1024, maxVideoSeconds: 600, maxPhotos: 120 });

/** The limits in the API's descriptor; a field missing or malformed keeps its default. */
function scanLimits(descriptor: unknown): ScanLimits {
  const limits =
    typeof descriptor === 'object' && descriptor !== null && 'limits' in descriptor && typeof descriptor.limits === 'object' && descriptor.limits !== null
      ? (descriptor.limits as Record<string, unknown>)
      : {};
  const read = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback);
  return {
    maxVideoBytes: read(limits.max_video_bytes, DEFAULT_SCAN_LIMITS.maxVideoBytes),
    maxVideoSeconds: read(limits.max_video_seconds, DEFAULT_SCAN_LIMITS.maxVideoSeconds),
    maxPhotos: read(limits.max_photos, DEFAULT_SCAN_LIMITS.maxPhotos),
  };
}

export interface SpaceContextOptions {
  /** `sc_live_…` or `sc_test_…`. Defaults to the `SPACECONTEXT_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `SPACECONTEXT_BASE_URL`, then the production API. */
  baseUrl?: string;
  /** A custom `fetch`, for tests or proxies. */
  fetch?: typeof fetch;
  /** Retries of a request the API rejected for load (429 `RATE_LIMIT_EXCEEDED`, 502–504) or that failed on the network. Default 2. */
  maxRetries?: number;
  /** Per request, uploads excluded. Default 60 s. */
  timeoutMs?: number;
  /**
   * Longest wait before a retry. A 429 asking to wait longer is returned at once
   * as an error. Default 60 s; interactive callers (an MCP tool) want a few seconds.
   */
  maxRetryDelayMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

type Query = Record<string, string | number | undefined | null>;

type RequestSpec = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Query;
  json?: unknown;
  body?: UploadBody;
  headers?: Record<string, string>;
  /** Safe to send twice: a retry after a network error or a 5xx cannot do the work twice. */
  idempotent: boolean;
  /** Uploads can take minutes, or hours for gigabytes: no client timeout. */
  noTimeout?: boolean;
  /** This request's own timeout, instead of the client's. */
  timeoutMs?: number;
  /** False: a 429 is thrown at once, never waited out (the caller has another way). */
  retryRateLimit?: boolean;
  signal?: AbortSignal | undefined;
};

function environment(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return value && value.trim() ? value.trim() : undefined;
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

/** Gateway failures: retried for idempotent requests. A 429 has its own rule. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/** Longest pause between two polls of a scan that is not changing. */
const MAX_POLL_INTERVAL_MS = 15_000;

/** Worth asking again later: refused for load (429), a gateway failure, or no answer at all. */
function transient(error: unknown): error is SpaceContextError {
  return error instanceof SpaceContextError && (error.status === 0 || error.status === 429 || RETRYABLE_STATUSES.has(error.status));
}

/** Seconds the API asked to wait, from `Retry-After` or `retry_after`. */
function askedWait(error: SpaceContextError): number | null {
  return error.retryAfter ?? (typeof error.details.retry_after === 'number' ? error.details.retry_after : null);
}

function idempotencyKey(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** What failed, with its cause: `fetch failed (connect ECONNREFUSED 127.0.0.1:443)`. */
function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  return cause && cause !== message ? `${message} (${cause})` : message;
}

/**
 * The stream as sent, noting the error when reading it fails: then the body
 * (the file), not the network, made the request fail.
 */
function tracked(source: ReadableStream<Uint8Array>, failed: { error: unknown }): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          failed.error = error;
          throw error;
        }
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 }
  );
}

/** The body could not be read (a file changed or gone while uploading): sending it again would not help. */
function bodyFailure(error: unknown, failed: { error: unknown }): Error | null {
  if (failed.error !== null) return failed.error instanceof Error ? failed.error : new Error(String(failed.error));
  const cause = error instanceof Error ? error.cause : undefined;
  // A Blob read from a file that changed after fs.openAsBlob.
  return cause instanceof FileReadError || (cause instanceof Error && cause.name === 'NotReadableError') ? cause : null;
}

/**
 * The events of one stream, ending quietly when the connection drops mid-stream
 * (the read rejects): the caller opens the stream again. The caller's own abort
 * is not a drop and is thrown.
 */
async function* untilDropped(events: AsyncGenerator<ServerSentEvent>, signal: AbortSignal | undefined): AsyncGenerator<ServerSentEvent> {
  try {
    yield* events;
  } catch {
    if (signal?.aborted) throw signal.reason;
  }
}

/**
 * Client for the Space Context API (`/v1`). Every method maps to one documented
 * operation, except the helpers `scans.fromVideo`, `scans.fromFrames` and
 * `scans.wait`, which chain them.
 *
 * ```ts
 * const sc = new SpaceContext({ apiKey: process.env.SPACECONTEXT_API_KEY });
 * const { data } = await sc.search('where is the stopcock?');
 * ```
 */
export class SpaceContext {
  readonly baseUrl: string;
  readonly mode: 'live' | 'test';
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxRetryDelayMs: number;
  /** The deployment's limits once read, and when: read again after `LIMITS_TTL_MS`. */
  private knownLimits: { limits: ScanLimits; at: number } | null = null;

  constructor(options: SpaceContextOptions = {}) {
    const apiKey = options.apiKey ?? environment('SPACECONTEXT_API_KEY');
    if (!apiKey || !/^sc_(live|test)_[A-Za-z0-9_-]+$/.test(apiKey)) {
      throw new SpaceContextError(
        'An API key (sc_live_… or sc_test_…) is required: pass apiKey or set SPACECONTEXT_API_KEY',
        0,
        'MISSING_API_KEY',
        null
      );
    }
    this.apiKey = apiKey;
    this.mode = apiKey.startsWith('sc_test_') ? 'test' : 'live';
    const baseUrl = (options.baseUrl ?? environment('SPACECONTEXT_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const parsed = new URL(baseUrl);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !local) {
      throw new SpaceContextError('baseUrl must use https', 0, 'INVALID_BASE_URL', null);
    }
    this.baseUrl = baseUrl;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? 2, 5));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 60_000);
  }

  // ---------------------------------------------------------------- spaces

  readonly spaces = {
    /** One page of spaces. `source: 'api'` lists the spaces created through the API. */
    list: (params: { limit?: number; cursor?: string; source?: 'app' | 'api' } = {}, options: RequestOptions = {}) =>
      this.json<SpaceListResponse>({
        method: 'GET',
        path: '/spaces',
        query: { limit: params.limit, cursor: params.cursor, source: params.source },
        idempotent: true,
        signal: options.signal,
      }),

    /** Every space, page after page: `for await (const space of sc.spaces.iterate()) …`. */
    iterate: (params: { source?: 'app' | 'api'; pageSize?: number } = {}, options: RequestOptions = {}) =>
      this.iterateSpaces(params, options),

    /**
     * The current document of a space. A key without `spaces:sensitive` gets a
     * redacted document; `include: 'transcript'` requires the scope.
     */
    get: (id: string, params: { include?: 'transcript'; enrich?: 'auto' | 'none' } = {}, options: RequestOptions = {}) =>
      this.json<SpaceDocument>({
        method: 'GET',
        path: `/spaces/${encodeURIComponent(id)}`,
        query: { include: params.include, enrich: params.enrich },
        idempotent: true,
        signal: options.signal,
      }),

    create: (space: SpaceCreateRequest, options: RequestOptions = {}) =>
      this.json<ApiSpace>({ method: 'POST', path: '/spaces', json: space, idempotent: false, signal: options.signal }),

    /**
     * Deletes a space created through the API, with its scans and files. Not
     * retried after a network error: a repeat would answer 404 for a space
     * already deleted.
     */
    delete: (id: string, options: RequestOptions = {}) =>
      this.empty({ method: 'DELETE', path: `/spaces/${encodeURIComponent(id)}`, idempotent: false, signal: options.signal }),

    scans: (id: string, options: RequestOptions = {}) =>
      this.json<ScanListResponse>({
        method: 'GET',
        path: `/spaces/${encodeURIComponent(id)}/scans`,
        idempotent: true,
        signal: options.signal,
      }),

    /** One past scan as it was recorded. Spaces scanned with the app require `spaces:sensitive`. */
    scan: (id: string, scanId: string, params: { include?: 'transcript' } = {}, options: RequestOptions = {}) =>
      this.json<SpaceDocument>({
        method: 'GET',
        path: `/spaces/${encodeURIComponent(id)}/scans/${encodeURIComponent(scanId)}`,
        query: { include: params.include },
        idempotent: true,
        signal: options.signal,
      }),

    /** The space as a multi-file Agent Skill (`SKILL.md`, `space.json`, `references/…`). */
    skill: (id: string, params: { include?: 'transcript'; enrich?: 'auto' | 'none' } = {}, options: RequestOptions = {}) =>
      this.json<SkillBundle>({
        method: 'GET',
        path: `/spaces/${encodeURIComponent(id)}/skill`,
        query: { include: params.include, enrich: params.enrich },
        idempotent: true,
        signal: options.signal,
      }),

    /** The space as one readable Markdown page, built from exactly what this key may read. */
    markdown: (id: string, params: { include?: 'transcript'; enrich?: 'auto' | 'none' } = {}, options: RequestOptions = {}) =>
      this.text({
        method: 'GET',
        path: `/spaces/${encodeURIComponent(id)}/markdown`,
        query: { include: params.include, enrich: params.enrich },
        headers: { Accept: 'text/markdown' },
        idempotent: true,
        signal: options.signal,
      }),

    /** A short answer from the space's records, with citations and evidence frames. */
    ask: (id: string, question: string, options: RequestOptions = {}) =>
      this.json<SpaceAnswer>({
        method: 'POST',
        path: `/spaces/${encodeURIComponent(id)}/ask`,
        json: { question },
        // Answering twice costs a question of the daily allowance, never money.
        idempotent: true,
        signal: options.signal,
      }),

    /** What changed between two scans (`to` defaults to the current one). */
    diff: (id: string, params: { from: string; to?: string }, options: RequestOptions = {}) =>
      this.json<SpaceDiff>({
        method: 'GET',
        path: `/spaces/${encodeURIComponent(id)}/diff`,
        query: { from: params.from, to: params.to },
        idempotent: true,
        signal: options.signal,
      }),
  };

  // ---------------------------------------------------------------- search

  /** Records matching a question across every space this key can read, best first. */
  search(query: string, params: { spaceId?: string; limit?: number } = {}, options: RequestOptions = {}): Promise<SearchResults> {
    return this.json<SearchResults>({
      method: 'GET',
      path: '/search',
      query: { q: query, space_id: params.spaceId, limit: params.limit },
      idempotent: true,
      signal: options.signal,
    });
  }

  // ---------------------------------------------------------------- frames

  readonly frames = {
    /**
     * Checks one frame while a space is being filmed: is it usable, and which key
     * locations (fuse box, stopcock, boiler…) does it show. About half a second;
     * nothing is stored. Free within a daily allowance; needs `scans:write`.
     */
    check: (data: UploadBody, contentType: FrameContentType, options: RequestOptions = {}) =>
      this.json<FrameCheck>({
        method: 'POST',
        path: '/frames/check',
        body: data,
        headers: { 'Content-Type': contentType },
        idempotent: true,
        signal: options.signal,
      }),
  };

  // ---------------------------------------------------------------- scans

  readonly scans = {
    /**
     * Declares a scan. Retried safely: the same `idempotencyKey` (one is generated
     * when omitted) returns the scan already created.
     */
    create: (spaceId: string, input: ScanInput, options: RequestOptions & { idempotencyKey?: string } = {}) =>
      this.json<Scan>({
        method: 'POST',
        path: `/spaces/${encodeURIComponent(spaceId)}/scans`,
        json: { input },
        headers: { 'Idempotency-Key': options.idempotencyKey ?? idempotencyKey() },
        idempotent: true,
        signal: options.signal,
      }),

    get: (id: string, options: RequestOptions = {}) =>
      this.json<Scan>({ method: 'GET', path: `/scans/${encodeURIComponent(id)}`, idempotent: true, signal: options.signal }),

    /** Cancels a scan that has not started: nothing is charged and its uploads are deleted. */
    cancel: (id: string, options: RequestOptions = {}) =>
      this.empty({ method: 'DELETE', path: `/scans/${encodeURIComponent(id)}`, idempotent: false, signal: options.signal }),

    uploadFrame: (id: string, index: number, data: UploadBody, contentType: FrameContentType, options: RequestOptions = {}) =>
      this.json<ScanUpload>({
        method: 'PUT',
        path: `/scans/${encodeURIComponent(id)}/frames/${index}`,
        body: data,
        headers: { 'Content-Type': contentType },
        idempotent: true,
        noTimeout: true,
        signal: options.signal,
      }),

    /**
     * Uploads the video of a scan, following the scan's `upload` instructions:
     * straight to storage when the API offers a signed URL, otherwise through the
     * API, which takes at most `upload.max_bytes` (95 MiB): a bigger video is
     * refused before anything is sent. The API key is only ever sent to the API
     * itself. No timeout: a video of gigabytes takes as long as the connection needs.
     */
    uploadVideo: (scan: Scan, data: UploadBody, options: RequestOptions = {}) => this.uploadVideo(scan, data, options),

    /** Starts the analysis and charges the scan (the free scan first, then the wallet). */
    start: (id: string, options: RequestOptions = {}) =>
      this.json<Scan>({
        method: 'POST',
        path: `/scans/${encodeURIComponent(id)}/start`,
        json: {},
        // A second start answers 200 with the scan already started.
        idempotent: true,
        signal: options.signal,
      }),

    /**
     * The scan as it changes, as it changes: `for await (const scan of sc.scans.events(id)) …`.
     * Follows the API's event stream (reconnecting when it ends early or the
     * connection drops) and ends after the final state. Where the stream cannot be
     * had (a proxy that does not stream, the account's open streams all in use,
     * the stream failing) it polls `GET /scans/{id}` instead, from every `intervalMs`
     * up to every 15 s while nothing changes. Throws `TIMEOUT` (with the last state
     * in `details.scan`) at `timeoutMs`, default 20 minutes, even while the stream
     * only sends pings.
     */
    events: (id: string, params: { intervalMs?: number; timeoutMs?: number } = {}, options: RequestOptions = {}) =>
      this.scanEvents(id, params, options),

    /**
     * Waits until a scan is complete, failed or cancelled, calling `onProgress`
     * at every change. Follows the scan as `events` does, polling only where
     * streaming is not possible, and throws `TIMEOUT` at `timeoutMs`.
     */
    wait: (id: string, params: { intervalMs?: number; timeoutMs?: number; onProgress?: (scan: Scan) => void } = {}, options: RequestOptions = {}) =>
      this.waitForScan(id, params, options),

    /** Creates, uploads and starts a video scan; cancels it if the upload fails. Does not wait for the result. */
    fromVideo: (
      spaceId: string,
      video: { data: UploadBody; contentType: VideoContentType; language?: ReportLanguage; recordedAt?: string; device?: string },
      options: RequestOptions = {}
    ) => this.scanFromVideo(spaceId, video, options),

    /** Creates, uploads and starts a scan from still frames; cancels it if an upload fails. Does not wait for the result. */
    fromFrames: (
      spaceId: string,
      frames: Array<{ data: UploadBody; contentType: FrameContentType; timestampMs?: number | null }>,
      params: { language?: ReportLanguage; transcript?: ScanInput['transcript']; onUpload?: (index: number) => void } = {},
      options: RequestOptions = {}
    ) => this.scanFromFrames(spaceId, frames, params, options),
  };

  // ---------------------------------------------------------------- one call

  /**
   * From a video (or photos) to the space's document in one call: creates the
   * space (or scans into one), uploads, starts, follows the scan as it runs and
   * returns the document, with the Markdown page or the Agent Skill when asked.
   *
   * ```ts
   * const { document } = await sc.scan('./flat.mp4', { name: 'Seaside flat', onProgress: (p) => console.log(p.type) });
   * ```
   */
  scan<Format extends ScanFormat = 'document'>(source: ScanSource, options: ScanOptions<Format> = {}): Promise<ScanResult<Format>> {
    return runScan(this, source, options);
  }

  /**
   * What a scan may be on this deployment, from the API's descriptor (`GET /v1`,
   * public): the largest video (4 GiB where the API reads videos with its own
   * ffmpeg, 100 MiB without it, 95 MiB where it issues no direct upload link),
   * the longest, and the most photos. A deployment older than the `limits`
   * field gives `DEFAULT_SCAN_LIMITS`. Kept for an hour.
   *
   * `null` when the descriptor could not be read (no answer, an error, a page
   * that is not the descriptor): the limits are unknown, never guessed, and the
   * API decides when the scan is declared. It is read again at the next call.
   * `scan()` checks a source against known limits before creating anything.
   */
  async limits(options: RequestOptions = {}): Promise<ScanLimits | null> {
    if (this.knownLimits && Date.now() - this.knownLimits.at < LIMITS_TTL_MS) return { ...this.knownLimits.limits };
    let descriptor: unknown;
    try {
      // `/v1`, not `/v1/`: the API redirects the latter, and redirects are never followed.
      descriptor = await this.json<unknown>({
        method: 'GET',
        path: '',
        idempotent: true,
        retryRateLimit: false,
        timeoutMs: Math.min(this.timeoutMs, 15_000),
        signal: options.signal,
      });
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
      return null;
    }
    // A proxy's or a gateway's JSON is not the API saying anything.
    if (typeof descriptor !== 'object' || descriptor === null || (descriptor as { name?: unknown }).name !== 'space-context-api') return null;
    this.knownLimits = { limits: scanLimits(descriptor), at: Date.now() };
    return { ...this.knownLimits.limits };
  }

  // ---------------------------------------------------------------- account

  /** The key in use: its user, mode and scopes. */
  me(options: RequestOptions = {}): Promise<MeResponse> {
    return this.json<MeResponse>({ method: 'GET', path: '/me', idempotent: true, signal: options.signal });
  }

  /** Prepaid balance and spending of this key. */
  wallet(options: RequestOptions = {}): Promise<Wallet> {
    return this.json<Wallet>({ method: 'GET', path: '/wallet', idempotent: true, signal: options.signal });
  }

  /**
   * Downloads an evidence frame from the signed URL of a document. Only URLs of
   * this API are fetched: the frames of the demo space (test keys) are public
   * files on https://spacecontext.app/demo/brisbane/, not URLs of the API, and
   * are refused with `INVALID_URL`. Fetch those directly; they need no key.
   */
  async evidenceFrame(url: string, options: RequestOptions = {}): Promise<{ contentType: string; data: ArrayBuffer }> {
    if (!this.isApiUrl(url)) {
      throw new SpaceContextError('Not an evidence URL of this API', 0, 'INVALID_URL', null);
    }
    // The URL is signed: the key is not needed, so it is not sent.
    const response = await this.send(url, { method: 'GET', path: '', headers: {}, withAuth: false, idempotent: true, signal: options.signal });
    return { contentType: response.headers.get('Content-Type') ?? 'application/octet-stream', data: await response.arrayBuffer() };
  }

  // ---------------------------------------------------------------- internals

  private async *iterateSpaces(
    params: { source?: 'app' | 'api'; pageSize?: number },
    options: RequestOptions
  ): AsyncGenerator<SpaceSummary> {
    let cursor: string | undefined;
    do {
      const page = await this.spaces.list({ source: params.source, limit: params.pageSize ?? 50, cursor }, options);
      yield* page.data;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  private async uploadVideo(scan: Scan, data: UploadBody, options: RequestOptions): Promise<void> {
    const upload = scan.upload;
    if (!upload || upload.kind !== 'video' || !upload.url) {
      throw new SpaceContextError('This scan is not waiting for a video', 0, 'INVALID_STATE', null);
    }
    const size = byteLength(data);
    const declared = scan.input.video?.content_length;
    if (declared !== undefined && size !== declared) {
      throw new SpaceContextError(`The video is ${size} bytes but the scan declared ${declared}`, 0, 'VALIDATION_ERROR', null);
    }
    const toApi = this.isApiUrl(upload.url);
    if (typeof upload.max_bytes === 'number' && size > upload.max_bytes) {
      // Through the API a request is bounded (95 MiB): a bigger video needs the
      // signed link to storage, which this deployment did not give.
      throw new SpaceContextError(
        toApi
          ? `The video is ${formatSize(size)}, and this API takes at most ${formatSize(upload.max_bytes, true)} (${upload.max_bytes} bytes) through itself: ` +
              'it offers no direct upload link to storage, which a bigger video needs. Compress or trim the video'
          : `The video is larger than this upload accepts (${upload.max_bytes} bytes)`,
        413,
        'PAYLOAD_TOO_LARGE',
        null,
        { max_bytes: upload.max_bytes }
      );
    }
    const contentType = (upload.headers as Record<string, string> | undefined)?.['Content-Type'] ?? scan.input.video?.content_type;
    const headers: Record<string, string> = contentType ? { 'Content-Type': contentType } : {};
    const response = await this.send(upload.url, {
      method: 'PUT',
      path: '',
      body: data,
      headers,
      withAuth: toApi,
      idempotent: true,
      noTimeout: true,
      signal: options.signal,
    });
    // Storage answers with an empty body; the API with a ScanUpload.
    await response.arrayBuffer();
  }

  private async waitForScan(
    id: string,
    params: { intervalMs?: number; timeoutMs?: number; onProgress?: (scan: Scan) => void },
    options: RequestOptions
  ): Promise<Scan> {
    let last: Scan | null = null;
    for await (const scan of this.scanEvents(id, params, options)) {
      last = scan;
      params.onProgress?.(scan);
    }
    // The generator ends only after a final state.
    return last!;
  }

  /**
   * One event stream of the scan. Null when the API cannot stream to this
   * client (a proxy that answers without an event stream); throws what the API
   * refused (404, 403, 429…).
   */
  private async openEventStream(id: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    const response = await this.send(this.url(`/scans/${encodeURIComponent(id)}/events`), {
      method: 'GET',
      path: '',
      headers: { Accept: 'text/event-stream' },
      idempotent: true,
      noTimeout: true,
      // Refused for load (the account's open streams, the per-minute limit):
      // polling answers now, waiting for a stream would not.
      retryRateLimit: false,
      signal,
    });
    if (!response.body || !(response.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return response.body;
  }

  private async *scanEvents(
    id: string,
    params: { intervalMs?: number; timeoutMs?: number },
    options: RequestOptions
  ): AsyncGenerator<Scan> {
    const deadline = Date.now() + (params.timeoutMs ?? 20 * 60_000);
    const interval = Math.max(1000, params.intervalMs ?? 3000);
    let last: Scan | null = null;
    let fingerprint: string | null = null;
    const fresh = (scan: Scan): boolean => {
      const current = [scan.status, scan.stage ?? '', scan.error?.code ?? '', scan.completed_at ?? ''].join('|');
      if (current === fingerprint) return false;
      fingerprint = current;
      last = scan;
      return true;
    };
    const timeout = () => new SpaceContextError(`Scan ${id} is still ${last?.status ?? 'running'}`, 0, 'TIMEOUT', null, last ? { scan: last } : {});

    // Everything below (opening the stream, reading it, polling, pausing) stops at
    // the deadline, also while the stream only sends pings.
    const expiry = new AbortController();
    const timer = setTimeout(() => expiry.abort(), Math.max(0, deadline - Date.now()));
    // In Node, the deadline alone does not keep the process running.
    (timer as unknown as { unref?: () => void }).unref?.();
    const signal = options.signal ? AbortSignal.any([options.signal, expiry.signal]) : expiry.signal;

    try {
      // A stream that ends before the final state (its 30-minute cap, a dropped
      // connection) is opened again; the API sends the scan as it is now first.
      for (;;) {
        let body: ReadableStream<Uint8Array> | null;
        try {
          body = await this.openEventStream(id, signal);
        } catch (error) {
          if (signal.aborted || !(error instanceof SpaceContextError)) throw error;
          if (error.status === 0 && last !== null) {
            // Streamed before, the network is down for now: try again shortly.
            await sleep(1000, signal);
            continue;
          }
          // A refusal of the scan or the key (404, 403…) would be the same for a poll.
          if (error.status !== 0 && error.status !== 429 && error.status < 500) throw error;
          // Refused for load (429: the account's open streams are all in use, or
          // too many opened this minute), failing or not reached: poll instead.
          break;
        }
        // The API cannot stream to this client (a proxy): poll instead.
        if (body === null) break;
        for await (const event of untilDropped(parseServerSentEvents(body, signal), signal)) {
          if (event.event !== 'scan' || !event.data) continue;
          const scan = JSON.parse(event.data) as Scan;
          if (fresh(scan)) yield scan;
          if (FINAL_SCAN_STATUSES.has(scan.status)) return;
        }
        if (signal.aborted) throw signal.reason;
        await sleep(1000, signal);
      }

      // Polling: every `interval` after a change, then less and less often while
      // nothing changes; a poll refused for load or not answered is asked again
      // later (no sooner than the API says), until the deadline.
      const longest = Math.max(interval, MAX_POLL_INTERVAL_MS);
      let pause = interval;
      for (;;) {
        try {
          const scan = await this.scans.get(id, { signal });
          if (fresh(scan)) {
            yield scan;
            pause = interval;
          } else {
            pause = Math.min(Math.round(pause * 1.5), longest);
          }
          if (FINAL_SCAN_STATUSES.has(scan.status)) return;
        } catch (error) {
          if (signal.aborted || !transient(error)) throw error;
          pause = Math.max(Math.min(Math.round(pause * 1.5), longest), (askedWait(error) ?? 0) * 1000);
        }
        if (Date.now() + pause > deadline) throw timeout();
        await sleep(pause, signal);
      }
    } catch (error) {
      // The deadline, not the caller's abort: a TIMEOUT with the last state known.
      if (expiry.signal.aborted && !options.signal?.aborted) throw timeout();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async scanFromVideo(
    spaceId: string,
    video: { data: UploadBody; contentType: VideoContentType; language?: ReportLanguage; recordedAt?: string; device?: string },
    options: RequestOptions
  ): Promise<Scan> {
    const scan = await this.scans.create(
      spaceId,
      {
        kind: 'video',
        language: video.language ?? 'en',
        video: { content_type: video.contentType, content_length: byteLength(video.data) },
        ...(video.recordedAt ? { recorded_at: video.recordedAt } : {}),
        ...(video.device ? { device: video.device } : {}),
      },
      options
    );
    await this.uploadOrCancel(scan, () => this.uploadVideo(scan, video.data, options));
    return this.startOrCancel(scan, options);
  }

  /**
   * Starts the uploaded scan; when it is refused (no funds, spending cap, too many
   * scans running), the scan is cancelled so that its files are not left waiting,
   * then the error is rethrown. A scan that did start is not affected: only a scan
   * still waiting for its upload can be cancelled.
   */
  private async startOrCancel(scan: Scan, options: RequestOptions): Promise<Scan> {
    try {
      return await this.scans.start(scan.id, options);
    } catch (error) {
      await this.scans.cancel(scan.id).catch(() => undefined);
      throw error;
    }
  }

  /** Runs the upload; when it fails, the scan is cancelled so that nothing is left waiting, then the error is rethrown. */
  private async uploadOrCancel(scan: Scan, upload: () => Promise<void>): Promise<void> {
    try {
      await upload();
    } catch (error) {
      await this.scans.cancel(scan.id).catch(() => undefined);
      throw error;
    }
  }

  private async scanFromFrames(
    spaceId: string,
    frames: Array<{ data: UploadBody; contentType: FrameContentType; timestampMs?: number | null }>,
    params: { language?: ReportLanguage; transcript?: ScanInput['transcript']; onUpload?: (index: number) => void },
    options: RequestOptions
  ): Promise<Scan> {
    if (frames.length === 0) throw new SpaceContextError('At least one frame is required', 0, 'VALIDATION_ERROR', null);
    const scan = await this.scans.create(
      spaceId,
      {
        kind: 'frames',
        language: params.language ?? 'en',
        frames: frames.map((frame) => ({ timestamp_ms: frame.timestampMs ?? null })),
        ...(params.transcript ? { transcript: params.transcript } : {}),
      },
      options
    );
    await this.uploadOrCancel(scan, async () => {
      const maxBytes = scan.upload?.max_bytes;
      const oversized = frames.findIndex((frame) => typeof maxBytes === 'number' && byteLength(frame.data) > maxBytes);
      if (oversized !== -1) {
        throw new SpaceContextError(`Frame ${oversized} is larger than ${maxBytes} bytes`, 413, 'PAYLOAD_TOO_LARGE', null, { index: oversized });
      }
      for (const [index, frame] of frames.entries()) {
        params.onUpload?.(index);
        await this.scans.uploadFrame(scan.id, index, frame.data, frame.contentType, options);
      }
    });
    return this.startOrCancel(scan, options);
  }

  private isApiUrl(url: string): boolean {
    try {
      const target = new URL(url);
      const api = new URL(this.baseUrl);
      return target.origin === api.origin && target.pathname.startsWith(`${api.pathname.replace(/\/+$/, '')}/`);
    } catch {
      return false;
    }
  }

  private async json<T>(spec: RequestSpec): Promise<T> {
    const response = await this.send(this.url(spec.path, spec.query), spec);
    return (await response.json()) as T;
  }

  private async text(spec: RequestSpec): Promise<string> {
    const response = await this.send(this.url(spec.path, spec.query), spec);
    return response.text();
  }

  private async empty(spec: RequestSpec): Promise<void> {
    const response = await this.send(this.url(spec.path, spec.query), spec);
    await response.arrayBuffer();
  }

  private url(path: string, query?: Query): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    return url.toString();
  }

  private async send(url: string, spec: RequestSpec & { withAuth?: boolean }): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...spec.headers };
    if (spec.withAuth !== false && this.isApiUrl(url)) headers.Authorization = `Bearer ${this.apiKey}`;
    let body: BodyInit | undefined;
    // A stream is opened anew for each attempt, with its length said: storage
    // refuses an upload without one.
    const stream = spec.body !== undefined && isUploadStream(spec.body) ? spec.body : null;
    if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    } else if (stream) {
      headers['Content-Length'] = String(stream.size);
    } else if (spec.body !== undefined) {
      body = spec.body as BodyInit;
    }

    for (let attempt = 0; ; attempt++) {
      const signals = [spec.signal, spec.noTimeout ? undefined : AbortSignal.timeout(spec.timeoutMs ?? this.timeoutMs)].filter(
        (signal): signal is AbortSignal => signal !== undefined
      );
      const failed: { error: unknown } = { error: null };
      const sent = stream ? tracked(stream.stream(), failed) : body;
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: spec.method,
          headers,
          ...(sent !== undefined ? { body: sent } : {}),
          // Node's fetch sends a stream only when told it is sent while being read.
          ...(stream ? { duplex: 'half' } : {}),
          ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
          // Never followed: a redirect is answered as an error. ('error' is not supported by Workers.)
          redirect: 'manual',
        } as RequestInit);
      } catch (error) {
        if (sent instanceof ReadableStream) await sent.cancel().catch(() => undefined);
        if (spec.signal?.aborted) throw spec.signal.reason;
        const unreadable = bodyFailure(error, failed);
        if (unreadable) throw new SpaceContextError(`The upload could not be read: ${unreadable.message}`, 0, 'FILE_READ_ERROR', null);
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        if (spec.idempotent && attempt < this.maxRetries) {
          await sleep(this.backoff(attempt, null), spec.signal);
          continue;
        }
        throw new SpaceContextError(
          timedOut ? 'The request timed out' : `The request failed: ${failure(error)}`,
          0,
          timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
          null
        );
      }

      if (response.ok) return response;
      const error = await errorFromResponse(response);
      // A rate limit was refused before any work: always safe to retry, unless the
      // wait is long (a daily limit). Another 429 (`SCANS_IN_PROGRESS`: ten scans
      // running) lasts as long as the work behind it and is returned at once. A
      // 5xx only when the request is idempotent.
      const wait = askedWait(error);
      const rateLimited = response.status === 429 && error.code === 'RATE_LIMIT_EXCEEDED';
      const retryable =
        (rateLimited && spec.retryRateLimit !== false && (wait === null || wait * 1000 <= this.maxRetryDelayMs)) ||
        (spec.idempotent && RETRYABLE_STATUSES.has(response.status));
      if (retryable && attempt < this.maxRetries) {
        await sleep(this.backoff(attempt, wait), spec.signal);
        continue;
      }
      throw error;
    }
  }

  private backoff(attempt: number, retryAfter: number | null): number {
    const delay = retryAfter !== null ? retryAfter * 1000 : Math.round(500 * 2 ** attempt * (0.75 + Math.random() * 0.5));
    return Math.min(delay, this.maxRetryDelayMs);
  }
}
