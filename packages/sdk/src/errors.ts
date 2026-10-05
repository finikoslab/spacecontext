/** An error answered by the Space Context API, or a request that could not reach it. */
export class SpaceContextError extends Error {
  override readonly name = 'SpaceContextError';

  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer (network, timeout). */
    readonly status: number,
    /**
     * Machine-readable code, stable across releases: `INSUFFICIENT_FUNDS`,
     * `ENRICHMENT_PENDING`, `RATE_LIMIT_EXCEEDED`, … Branch on this, not on the
     * message. `NETWORK_ERROR` and `TIMEOUT` are set by the client itself.
     */
    readonly code: string,
    /** Quote it when contacting support. Null when the API did not answer. */
    readonly requestId: string | null,
    /** Every field of the error object, including extras such as `space_id`. */
    readonly details: Record<string, unknown> = {},
    /** Seconds to wait before retrying, from `Retry-After`. */
    readonly retryAfter: number | null = null
  ) {
    super(message);
  }
}

/** Parses the API error envelope `{ error: { code, message, request_id } }`. */
export async function errorFromResponse(response: Response): Promise<SpaceContextError> {
  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfter = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON: an error page from a proxy, for example.
  }
  const error =
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null
      ? (body.error as Record<string, unknown>)
      : {};
  const code = typeof error.code === 'string' ? error.code : `HTTP_${response.status}`;
  const message = typeof error.message === 'string' ? error.message : `The API answered ${response.status}`;
  const requestId = typeof error.request_id === 'string' ? error.request_id : null;
  return new SpaceContextError(message, response.status, code, requestId, error, retryAfter);
}
