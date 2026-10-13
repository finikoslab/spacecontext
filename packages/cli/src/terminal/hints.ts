import type { SpaceContextError } from '@spacecontext/sdk';
import { BILLING_URL, KEYS_URL, LIMITS_URL, RECORDING_TIPS_URL } from '../lib/links.js';

/** What the CLI knows when a request fails: enough to say what to do next. */
export type ErrorContext = {
  command: string;
  /** Where the key came from. */
  keySource?: 'flag' | 'env' | 'saved';
  keyMode?: 'live' | 'test';
  /** The API's base URL, when it is not the default one. */
  baseUrl?: string;
  /** A scan that started: it goes on even if the CLI stops following it. */
  scanId?: string;
};

function signInAgain(context: ErrorContext): string[] {
  if (context.keySource === 'env') {
    return ['The key comes from SPACECONTEXT_API_KEY, which wins over the saved one:\nfix or unset it, then run `spacecontext login`'];
  }
  if (context.keySource === 'flag') return ['Check the key given with --api-key, or run `spacecontext login`'];
  return ['Sign in again: `spacecontext login` (or `spacecontext login --test` for a free test key)'];
}

function wait(error: SpaceContextError): string {
  const seconds = error.retryAfter ?? (typeof error.details.retry_after === 'number' ? error.details.retry_after : null);
  return seconds !== null ? `${seconds} s` : 'a minute';
}

/** Lines that say what to do next after an error of the API, most useful first. */
export function hints(error: SpaceContextError, context: ErrorContext): string[] {
  const follow = context.scanId ? [`The scan goes on without the terminal: \`spacecontext scan-status ${context.scanId} --follow\``] : [];
  switch (error.code) {
    case 'MISSING_AUTH_HEADER':
    case 'INVALID_TOKEN':
    case 'USER_NOT_FOUND':
      return signInAgain(context);
    case 'INSUFFICIENT_SCOPE': {
      const required = Array.isArray(error.details.required_scopes) ? error.details.required_scopes.map(String) : [];
      if (required.includes('scans:write')) {
        return [`This key cannot scan: run \`spacecontext login\` and approve a key that can scan,\nor create one in the console: ${KEYS_URL}`];
      }
      if (required.includes('spaces:sensitive')) {
        return [`--transcript and sensitive values need a key with spaces:sensitive:\ncreate one in the console: ${KEYS_URL}`];
      }
      return [`This key lacks ${required.length > 0 ? required.join(', ') : 'a scope'}: create a key with it in the console: ${KEYS_URL}`];
    }
    case 'PAYMENT_METHOD_REQUIRED':
      return [`Add a card in the console (nothing is charged), then run it again:\n${BILLING_URL}`, 'Or scan for free with a test key: `spacecontext login --test`'];
    case 'INSUFFICIENT_FUNDS':
      return [`Top up the balance in the console: ${BILLING_URL}`, '`spacecontext wallet` shows the balance and the price of a scan'];
    case 'SPENDING_CAP_REACHED':
      return [`This key reached its monthly spending cap: raise it in the console: ${KEYS_URL}`];
    case 'PAYMENTS_UNAVAILABLE':
    case 'PAYMENT_FAILED':
      return ['Card payments are not available right now: try again in a few minutes'];
    case 'RATE_LIMIT_EXCEEDED':
      if (error.details.daily_limit !== undefined) return [`A daily limit: it resets at midnight UTC (${LIMITS_URL})`];
      return [`Too many requests: try again in ${wait(error)}`];
    case 'SCANS_IN_PROGRESS':
      // At creation: too many scans created and never started (an upload stopped half way leaves one).
      if (typeof error.details.max_open_scans === 'number') {
        return [
          `${error.details.max_open_scans} scans of the account were created and never started: cancel them\n(\`spacecontext cancel <scan-id>\`), or wait: they are removed a day after they were created`,
        ];
      }
      return ['Ten scans of the account are already running: start again when one finishes'];
    case 'NOT_FOUND':
      // A capture profile is public: no key is involved, only the API's version.
      if (context.command === 'checklist') return ['The API does not know this type of space: it may be older than this CLI (`spacecontext checklist` lists the types it knows)'];
      if (context.keyMode === 'test') return ['A test key sees only the demo (spc_demo) and its own test spaces: `spacecontext spaces`'];
      if (['scan-status', 'cancel'].includes(context.command)) return ['Check the scan id: `spacecontext scans <space-id>` lists the scans of a space'];
      return ['`spacecontext spaces` lists the spaces this key can read (test and live keys see different ones)'];
    case 'ENRICHMENT_PENDING':
      return ['The space is being screened for sensitive values: try again in a minute'];
    case 'PRO_REQUIRED':
      return ['Spaces scanned with the app need Space Context Pro on this deployment'];
    case 'INVALID_STATE':
      return context.command === 'cancel' ? ['Only a scan that has not started can be cancelled; a scan that fails is refunded'] : [];
    case 'FILE_TOO_LARGE':
    case 'PAYLOAD_TOO_LARGE':
      // Through the API itself, not to storage: the API gave no storage link for this scan.
      return [
        'The API itself takes uploads of at most 95 MB (a photo 2 MB): a bigger video\ngoes only to the storage link the API gives when the scan is declared, and\nthis API gave none',
        'With ffmpeg installed, `spacecontext scan --compress` makes the video smaller',
      ];
    case 'INVALID_CONTENT_TYPE':
    case 'EMPTY_FILE':
      return ['Videos: .mp4 .mov .m4v .3gp .webm .mkv, up to 10 minutes; photos: .jpg\n.png .webp, up to 2 MB each'];
    case 'VALIDATION_ERROR':
      // A video over the API's limit, declared because the limit could not be read first.
      return /content_length/.test(error.message)
        ? ['The API takes a smaller video (its limit is above): run the scan again, and\nwith ffmpeg installed the CLI compresses it to fit the limit the API states', ...follow]
        : follow;
    case 'FOOTAGE_UNUSABLE':
      return [`Film again in good light, slowly, showing whole rooms: ${RECORDING_TIPS_URL}`, '`spacecontext check <photos-dir>` tells usable photos before a scan'];
    case 'ANALYSIS_EMPTY':
      return [`No space was recognised: film whole rooms rather than close-ups (${RECORDING_TIPS_URL})`];
    case 'VIDEO_TOO_LONG':
      return ['A video can last up to 10 minutes: trim it, or scan it in two parts'];
    case 'VIDEO_UNREADABLE':
      return [
        'Check that the video plays, or export it again as .mp4',
        'A WebM recorded in a browser states no duration: an API without its own\nffmpeg cannot read it: remux it first (`ffmpeg -i in.webm -c copy out.webm`)',
      ];
    case 'AI_ANALYSIS_FAILED':
    case 'AI_OVERLOADED':
    case 'PROCESSING_TIMEOUT':
      return ['Run the scan again in a few minutes'];
    case 'ACCESS_DENIED':
      return ['The code was denied in the console: run `spacecontext login` to start again'];
    case 'DEVICE_CODE_EXPIRED':
    case 'DEVICE_CODE_INVALID':
      return ['The code expired: run `spacecontext login` again and approve the new code within 10 minutes'];
    case 'SEARCH_UNAVAILABLE':
    case 'FRAME_CHECK_UNAVAILABLE':
      return ['Temporarily unavailable: try again in a minute'];
    case 'NETWORK_ERROR':
      return [`Could not reach ${context.baseUrl ?? 'the API'}: check your connection${context.baseUrl ? ' and --base-url / SPACECONTEXT_BASE_URL' : ''}`, ...follow];
    case 'TIMEOUT':
      return context.scanId ? follow : ['The request timed out: try again'];
    case 'INVALID_BASE_URL':
      return ['--base-url and SPACECONTEXT_BASE_URL must use https (http only for localhost)'];
    default:
      if (error.status >= 500) return ['Try again in a minute; if it keeps failing, contact support with the request id', ...follow];
      return follow;
  }
}
