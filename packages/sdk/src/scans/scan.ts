import {
  VIDEO_CONTENT_TYPES,
  type FrameContentType,
  type ReportLanguage,
  type Scan,
  type ScanInput,
  type ScanLimits,
  type SkillBundle,
  type SpaceContext,
  type SpaceDocument,
  type SpaceType,
  type UploadBody,
  type VideoContentType,
} from '../client/client.js';
import { byteLength, fileBody, formatSize, nodeFs, type NodeFs } from '../client/body.js';
import { SpaceContextError } from '../errors.js';

/**
 * `sc.scan(source, options)`: one call from a video (or photos) to the space's
 * document, with what happens reported as it happens. Everything it chains is
 * also available one step at a time on `sc.spaces` and `sc.scans`.
 */

/** What to scan. */
export type ScanSource =
  /** A path (Node only): a video file (.mp4 .mov .m4v .3gp .webm .mkv), an image, or a folder of images (one frame each, sorted by name). */
  | string
  /** A video or an image, with its type in `blob.type` (a `File` from an input element has it). */
  | Blob
  /** A video as bytes, with its type. */
  | { video: UploadBody; contentType: VideoContentType }
  /** Frames: images with their type, in order; `timestampMs` says when each was taken. */
  | { frames: Array<Blob | ScanFrame> };

export type ScanFrame = { data: UploadBody; contentType: FrameContentType; timestampMs?: number | null };

/** What `onProgress` receives, in order. */
export type ScanProgress =
  | { type: 'space_created'; spaceId: string }
  | { type: 'uploading'; part: number; parts: number; bytes: number }
  | { type: 'uploaded'; scan: Scan }
  | { type: 'started'; scan: Scan }
  /** Every change of the scan's status or stage while it runs. */
  | { type: 'scan'; scan: Scan; stage: ScanStage; label: string }
  | { type: 'complete'; scan: Scan };

export type ScanStage =
  | 'awaiting_upload'
  | 'queued'
  | 'ingesting'
  | 'screening'
  | 'observing'
  | 'fusing'
  | 'enriching'
  | 'saving'
  | 'verifying'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled';

/** The stage of a scan as a short label for a progress line. */
export function describeScan(scan: Pick<Scan, 'status' | 'stage'>): { stage: ScanStage; label: string } {
  const stage = (scan.status === 'processing' && scan.stage ? scan.stage : scan.status) as ScanStage;
  const labels: Record<ScanStage, string> = {
    awaiting_upload: 'Waiting for the upload',
    queued: 'Queued',
    ingesting: 'Reading the video',
    screening: 'Checking the frames',
    observing: 'Looking at the frames',
    fusing: 'Writing the report',
    enriching: 'Extracting the context',
    saving: 'Saving',
    verifying: 'Verifying the evidence',
    processing: 'Processing',
    complete: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return { stage, label: labels[stage] ?? stage };
}

export type ScanFormat = 'document' | 'markdown' | 'skill';

export interface ScanOptions<Format extends ScanFormat = 'document'> {
  /** Scan into this space (a new scan of it, checked against the previous one). Either `space` or `name`. */
  space?: string;
  /** Create a space with this name for the scan. */
  name?: string;
  /** With `name`: the kind of space. */
  type?: SpaceType;
  /** With `name`: your own id for the space; the same id returns the same space. */
  externalId?: string;
  /** Language of the report, one of `REPORT_LANGUAGES` (en, it, es, fr, de, pt, nl); the narration can be in any language. Default `en`. */
  language?: ReportLanguage;
  /** A transcript you already have (with frames: the API transcribes videos itself). */
  transcript?: ScanInput['transcript'];
  /** When the video was recorded (ISO 8601). */
  recordedAt?: string;
  /** The device that recorded it. */
  device?: string;
  /** What to return besides the document: `markdown` (one page) or `skill` (an Agent Skill folder). Default `document`. */
  format?: Format;
  /** Called as the scan moves on: upload parts, then every stage. */
  onProgress?: (progress: ScanProgress) => void;
  /** Give up waiting after this long. Default 20 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ScanResult<Format extends ScanFormat = 'document'> = {
  spaceId: string;
  scan: Scan;
  /** The space's document after the scan. */
  document: SpaceDocument;
} & (Format extends 'markdown' ? { markdown: string } : Format extends 'skill' ? { skill: SkillBundle } : Record<never, never>);

/** The largest photo the API takes; the other limits are the deployment's own (`sc.limits()`). */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** The type of a video file from its extension: the containers the API takes. */
const VIDEO_TYPES: Record<string, VideoContentType> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.3gp': 'video/3gpp',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};
const VIDEO_EXTENSIONS = Object.keys(VIDEO_TYPES).join(' ');
const IMAGE_TYPES: Record<string, FrameContentType> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const IMAGE_CONTENT_TYPES = new Set<string>(Object.values(IMAGE_TYPES));

/** Read when called, never at load: client.js and this module import each other. */
function isVideoType(type: string): type is VideoContentType {
  return (VIDEO_CONTENT_TYPES as readonly string[]).includes(type);
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** `video/webm` from `video/webm;codecs=vp9,opus` (a MediaRecorder's Blob): the API takes the bare type. */
function mediaType(type: string): string {
  return type.split(';')[0]!.trim().toLowerCase();
}

function invalid(message: string): SpaceContextError {
  return new SpaceContextError(message, 0, 'VALIDATION_ERROR', null);
}

type Resolved = { kind: 'video'; data: UploadBody; contentType: VideoContentType } | { kind: 'frames'; frames: ScanFrame[] };

function frameOf(entry: Blob | ScanFrame, index: number): ScanFrame {
  if (entry instanceof Blob) {
    const type = entry.type || IMAGE_TYPES[extension((entry as File).name ?? '')] || '';
    if (!IMAGE_CONTENT_TYPES.has(type)) throw invalid(`Frame ${index}: give an image Blob with a type (image/jpeg, image/png or image/webp)`);
    return { data: entry, contentType: type as FrameContentType, timestampMs: null };
  }
  return entry;
}

/** The source as a video or frames; paths are read with Node's file system. */
async function resolveSource(source: ScanSource): Promise<Resolved> {
  if (typeof source === 'string') return resolvePath(source);
  if (source instanceof Blob) {
    const name = (source as File).name ?? '';
    const type = mediaType(source.type) || VIDEO_TYPES[extension(name)] || IMAGE_TYPES[extension(name)] || '';
    if (isVideoType(type)) return { kind: 'video', data: source, contentType: type };
    if (IMAGE_CONTENT_TYPES.has(type)) return { kind: 'frames', frames: [frameOf(source, 0)] };
    throw invalid(
      `The Blob's type (${source.type || 'none'}) is not a video the API takes (${VIDEO_CONTENT_TYPES.join(', ')}) nor an image: pass { video, contentType } or { frames } instead`
    );
  }
  if ('video' in source) {
    if (!isVideoType(source.contentType)) throw invalid(`contentType must be one of ${VIDEO_CONTENT_TYPES.join(', ')}`);
    return { kind: 'video', data: source.video, contentType: source.contentType };
  }
  if (source.frames.length === 0) throw invalid('At least one frame is required');
  return { kind: 'frames', frames: source.frames.map(frameOf) };
}

type NodePath = { join(...parts: string[]): string };

/**
 * A path as a video or frames. Files are read from disk while they are
 * uploaded, never into memory (`fileBody`): a video can be gigabytes.
 */
async function resolvePath(target: string): Promise<Resolved> {
  // Loaded only here, by name, so that bundlers for browsers leave them alone.
  const fs: NodeFs | null = await nodeFs();
  const pathName = 'node:path';
  const path = fs ? ((await import(pathName).catch(() => null)) as NodePath | null) : null;
  if (!fs || !path) throw invalid('A path can only be scanned in Node.js: pass a Blob, { video, contentType } or { frames } here');
  let info: { isDirectory(): boolean };
  try {
    info = await fs.promises.stat(target);
  } catch {
    throw invalid(`${target}: no such file or directory`);
  }
  if (info.isDirectory()) {
    // Regular files only, and no hidden ones: a symlink can point anywhere, and a
    // volume formatted on another system brings `._IMG_0001.jpg` files that are not photos.
    const names = (await fs.promises.readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && IMAGE_TYPES[extension(entry.name)])
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (names.length === 0) throw invalid(`${target}: no .jpg, .png or .webp image in the folder`);
    const frames: ScanFrame[] = [];
    for (const name of names) {
      frames.push({ data: await fileBody(path.join(target, name)), contentType: IMAGE_TYPES[extension(name)]!, timestampMs: null });
    }
    return { kind: 'frames', frames };
  }
  const video = VIDEO_TYPES[extension(target)];
  if (video) return { kind: 'video', data: await fileBody(target), contentType: video };
  const image = IMAGE_TYPES[extension(target)];
  if (image) return { kind: 'frames', frames: [{ data: await fileBody(target), contentType: image, timestampMs: null }] };
  throw invalid(`${target}: expected a video (${VIDEO_EXTENSIONS}), an image, or a folder of images`);
}

/**
 * What the API would refuse after the space is created, against this
 * deployment's limits: refused before, so that no space is left without a scan.
 * Unknown limits (the descriptor could not be read) check nothing: the API
 * decides when the scan is declared, rather than a guess refusing a video it takes.
 */
function checkLimits(resolved: Resolved, limits: ScanLimits | null): void {
  if (!limits) return;
  if (resolved.kind === 'video') {
    const size = byteLength(resolved.data);
    if (size > limits.maxVideoBytes) {
      throw invalid(
        `The video is ${formatSize(size)}, over the ${formatSize(limits.maxVideoBytes, true)} this API takes (${limits.maxVideoBytes} bytes): ` +
          'trim it, or compress it (the spacecontext CLI does it when ffmpeg is installed)'
      );
    }
    return;
  }
  if (resolved.frames.length > limits.maxPhotos) throw invalid(`${resolved.frames.length} frames: at most ${limits.maxPhotos} are accepted`);
  const oversized = resolved.frames.findIndex((frame) => byteLength(frame.data) > MAX_FRAME_BYTES);
  if (oversized !== -1) throw invalid(`Frame ${oversized} is larger than ${MAX_FRAME_BYTES / 1_048_576} MB`);
}

/** Runs the whole flow. Called by `SpaceContext.scan`. */
export async function runScan<Format extends ScanFormat = 'document'>(
  sc: SpaceContext,
  source: ScanSource,
  options: ScanOptions<Format> = {}
): Promise<ScanResult<Format>> {
  if (Boolean(options.space) === Boolean(options.name)) throw invalid('Pass either space (an existing space id) or name (a space to create)');
  const resolved = await resolveSource(source);
  const request = { signal: options.signal };
  // Read once an hour per client; unknown when the descriptor cannot be read (then the API decides).
  checkLimits(resolved, await sc.limits(request));
  const report = options.onProgress ?? (() => undefined);

  // What exists on the account so far, filled in as the flow goes.
  const made: Made = { spaceId: options.space ?? null, scanId: null };
  try {
    return await scanInto(sc, resolved, options, request, report, made);
  } catch (error) {
    // Past this point something may exist on the account (a space, a scan, a
    // charge): the error says which, so that the caller finds them instead of
    // scanning again and paying twice.
    throw withScanIds(error, made);
  }
}

type Made = { spaceId: string | null; scanId: string | null };

/** The same error, with the space and scan it concerns in `details` (`space_id`, `scan_id`). */
function withScanIds(error: unknown, made: Made): unknown {
  if (!(error instanceof SpaceContextError) || (made.spaceId === null && made.scanId === null)) return error;
  const details = {
    ...error.details,
    ...(made.spaceId !== null ? { space_id: made.spaceId } : {}),
    ...(made.scanId !== null ? { scan_id: made.scanId } : {}),
  };
  const copy = new SpaceContextError(error.message, error.status, error.code, error.requestId, details, error.retryAfter);
  copy.stack = error.stack;
  return copy;
}

async function scanInto<Format extends ScanFormat>(
  sc: SpaceContext,
  resolved: Resolved,
  options: ScanOptions<Format>,
  request: { signal: AbortSignal | undefined },
  report: (event: ScanProgress) => void,
  made: Made
): Promise<ScanResult<Format>> {
  let spaceId = options.space!;
  if (options.name) {
    const created = await sc.spaces.create(
      {
        name: options.name,
        ...(options.type ? { space_type: options.type } : {}),
        ...(options.externalId ? { external_id: options.externalId } : {}),
      },
      request
    );
    spaceId = created.id;
    made.spaceId = spaceId;
    report({ type: 'space_created', spaceId });
  }

  const common = {
    language: options.language ?? 'en',
    ...(options.recordedAt ? { recordedAt: options.recordedAt } : {}),
    ...(options.device ? { device: options.device } : {}),
  };
  let started: Scan;
  if (resolved.kind === 'video') {
    report({ type: 'uploading', part: 1, parts: 1, bytes: byteLength(resolved.data) });
    started = await sc.scans.fromVideo(
      spaceId,
      { data: resolved.data, contentType: resolved.contentType, ...common, onCreated: (scan) => (made.scanId = scan.id) },
      request
    );
  } else {
    const total = resolved.frames.reduce((sum, frame) => sum + byteLength(frame.data), 0);
    started = await sc.scans.fromFrames(
      spaceId,
      resolved.frames,
      {
        ...common,
        ...(options.transcript ? { transcript: options.transcript } : {}),
        onUpload: (index) => report({ type: 'uploading', part: index + 1, parts: resolved.frames.length, bytes: total }),
        onCreated: (scan) => (made.scanId = scan.id),
      },
      request
    );
  }
  report({ type: 'uploaded', scan: started });
  report({ type: 'started', scan: started });

  const finished = await sc.scans.wait(
    started.id,
    {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      onProgress: (scan) => report({ type: 'scan', scan, ...describeScan(scan) }),
    },
    request
  );
  if (finished.status !== 'complete') {
    throw new SpaceContextError(
      `Scan ${finished.status}: ${finished.error?.message ?? 'no detail'}${finished.charge.refunded ? ' (refunded)' : ''}`,
      0,
      finished.error?.code ?? (finished.status === 'cancelled' ? 'SCAN_CANCELLED' : 'SCAN_FAILED'),
      null,
      { scan: finished }
    );
  }
  report({ type: 'complete', scan: finished });

  const document = await sc.spaces.get(spaceId, { enrich: 'none' }, request);
  const result: Record<string, unknown> = { spaceId, scan: finished, document };
  if (options.format === 'markdown') result.markdown = await sc.spaces.markdown(spaceId, { enrich: 'none' }, request);
  if (options.format === 'skill') result.skill = await sc.spaces.skill(spaceId, { enrich: 'none' }, request);
  return result as ScanResult<Format>;
}
