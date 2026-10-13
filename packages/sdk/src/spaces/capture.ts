import { errorFromResponse, SpaceContextError } from '../errors.js';
import {
  DEFAULT_BASE_URL,
  type CaptureProfile,
  type CaptureProfileList,
  type KeyLocationKind,
  type ReportLanguage,
  type SpaceCoverageCheck,
  type SpaceType,
  type SpaceVerification,
} from '../client/client.js';

/**
 * Guided capture and verified evidence, without a key or a round trip:
 * - the capture profiles (what to film for each type of space) are public, so
 *   `fetchCaptureProfiles` and `fetchCaptureProfile` read them with no key, for an
 *   app or a CLI that shows the checklist before anyone signs in;
 * - `summarizeCoverage` and `summarizeVerification` read a Space Document already
 *   fetched: which key locations the recording showed, which are missing, and how
 *   many records were confirmed on their own photo.
 */

export interface PublicRequestOptions {
  /** Defaults to `SPACECONTEXT_BASE_URL`, then the production API. */
  baseUrl?: string;
  /** A custom `fetch`, for tests or proxies. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Default 15 s. */
  timeoutMs?: number;
}

function environment(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return value && value.trim() ? value.trim() : undefined;
}

function publicUrl(path: string, query: Record<string, string | undefined>, baseUrl: string | undefined): string {
  const base = (baseUrl ?? environment('SPACECONTEXT_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const parsed = new URL(base);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !local) throw new SpaceContextError('baseUrl must use https', 0, 'INVALID_BASE_URL', null);
  const url = new URL(`${base}${path}`);
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value);
  return url.toString();
}

async function getPublic<T>(path: string, query: Record<string, string | undefined>, options: PublicRequestOptions): Promise<T> {
  const url = publicUrl(path, query, options.baseUrl);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const signals = [options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)].filter((signal): signal is AbortSignal => signal !== undefined);
  const failed = (error: unknown, reading: boolean): never => {
    if (options.signal?.aborted) throw options.signal.reason;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (timedOut) throw new SpaceContextError(reading ? 'The answer timed out while it was being read' : 'The request timed out', 0, 'TIMEOUT', null);
    throw new SpaceContextError(reading ? 'The answer could not be read' : 'The request failed', 0, 'NETWORK_ERROR', null);
  };
  let response: Response;
  try {
    // No Authorization header: these routes are public, and no key is needed.
    response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.any(signals), redirect: 'manual' });
  } catch (error) {
    return failed(error, false);
  }
  if (!response.ok) throw await errorFromResponse(response);
  // Read within the same timeout: a body cut short, too slow or not JSON is a failed answer, not a crash.
  try {
    return (await response.json()) as T;
  } catch (error) {
    return failed(error, true);
  }
}

/** What to film for every type of space, with labels and hints in `language` (default `en`). No key needed. */
export function fetchCaptureProfiles(params: { language?: ReportLanguage } & PublicRequestOptions = {}): Promise<CaptureProfileList> {
  return getPublic<CaptureProfileList>('/capture-profiles', { language: params.language }, params);
}

/** What to film for one type of space. No key needed. */
export function fetchCaptureProfile(spaceType: SpaceType, params: { language?: ReportLanguage } & PublicRequestOptions = {}): Promise<CaptureProfile> {
  return getPublic<CaptureProfile>(`/capture-profiles/${encodeURIComponent(spaceType)}`, { language: params.language }, params);
}

export interface CoverageSummary {
  /** False when the scan's frames were not checked (the document has no checklist): nothing below is known. */
  checked: boolean;
  /**
   * True when the profile given matches the document's checklist (every kind of the
   * checklist is in it): only then are the missing ones split by `expected`. A document
   * checked before capture profiles, or against another type, gets one list.
   */
  byProfile: boolean;
  /** Key locations at least one frame shows. */
  seen: KeyLocationKind[];
  /** Every key location no frame shows. */
  missing: KeyLocationKind[];
  /** Missing and usually there (`expected` in the profile): worth filming next time. Empty when `byProfile` is false. */
  missingExpected: KeyLocationKind[];
  /** Missing and only "if there is one" in the profile; when `byProfile` is false, every missing one. */
  missingOptional: KeyLocationKind[];
}

/**
 * Which key locations the recording showed, from the document's
 * `coverage.checklist` (the key locations every frame was checked for). With the
 * capture profile of the space's type, and only when it matches the checklist,
 * the missing ones are split into those usually there and those only "if there
 * is one".
 */
export function summarizeCoverage(
  document: { coverage?: { checklist?: SpaceCoverageCheck[] | null } | null },
  profile?: Pick<CaptureProfile, 'key_locations'> | null
): CoverageSummary {
  const checklist = document.coverage?.checklist ?? [];
  const seen = checklist.filter((check) => check.seen).map((check) => check.kind);
  const missing = checklist.filter((check) => !check.seen).map((check) => check.kind);
  const known = new Set(profile?.key_locations.map((entry) => entry.kind) ?? []);
  const byProfile = Boolean(profile) && checklist.length > 0 && checklist.every((check) => known.has(check.kind));
  const expected = new Set(byProfile ? profile!.key_locations.filter((entry) => entry.expected).map((entry) => entry.kind) : []);
  return {
    checked: checklist.length > 0,
    byProfile,
    seen,
    missing,
    missingExpected: missing.filter((kind) => expected.has(kind)),
    missingOptional: missing.filter((kind) => !expected.has(kind)),
  };
}

export interface VerificationSummary {
  /** Items, issues and key locations. */
  total: number;
  /** A photo it cites clearly shows it. */
  verified: number;
  /** Its photos were checked and none clearly shows it: treat it as uncertain. */
  unconfirmed: number;
  /** Nothing a photo could confirm: from the narration only, or a fault or an absence. */
  notVisual: number;
  /** Not checked (an older document, the base level, a check that could not run). */
  unchecked: number;
}

type Verifiable = { verification?: SpaceVerification | null };

/** How many records of a document were confirmed on their own photo. */
export function summarizeVerification(document: { items?: Verifiable[] | null; issues?: Verifiable[] | null; key_locations?: Verifiable[] | null }): VerificationSummary {
  const records = [...(document.items ?? []), ...(document.issues ?? []), ...(document.key_locations ?? [])];
  const count = (status: SpaceVerification['status']) => records.filter((record) => record.verification?.status === status).length;
  const verified = count('verified');
  const unconfirmed = count('unconfirmed');
  const notVisual = count('not_visual');
  return { total: records.length, verified, unconfirmed, notVisual, unchecked: records.length - verified - unconfirmed - notVisual };
}
