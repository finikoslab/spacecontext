import { SpaceContext } from '@spacecontext/sdk';
import type { Env } from './env.js';

/**
 * `fetch` towards the API: through the service binding when there is one, with
 * the end user's IP, so that the API's per-IP limits and sign-in protection
 * apply to that user and not to this Worker as a whole. Over the public
 * internet Cloudflare sets that header itself and ignores ours.
 */
export function backendFetch(env: Env, clientIp: string | null): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (clientIp) request.headers.set('CF-Connecting-IP', clientIp);
    return env.BACKEND ? env.BACKEND.fetch(request) : fetch(request);
  }) as typeof fetch;
}

/** The SDK, acting with the API key of a grant. */
export function apiClient(env: Env, apiKey: string, clientIp: string | null): SpaceContext {
  return new SpaceContext({ apiKey, baseUrl: env.API_BASE_URL, fetch: backendFetch(env, clientIp), maxRetries: 1, timeoutMs: 30_000 });
}

export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** A JSON call to the console endpoints (sign-in, key creation), which take no API key. */
export async function backendJson<T>(
  env: Env,
  path: string,
  options: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; sessionToken?: string; clientIp: string | null; language?: string | null }
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.sessionToken) headers.Authorization = `Bearer ${options.sessionToken}`;
  if (options.language) headers['Accept-Language'] = options.language;
  const response = await backendFetch(env, options.clientIp)(`${env.API_BASE_URL.replace(/\/+$/, '')}${path}`, {
    method: options.method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    redirect: 'manual',
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    throw new BackendError(response.status, body?.error?.code ?? `HTTP_${response.status}`, body?.error?.message ?? 'The API refused the request');
  }
  return body as T;
}
