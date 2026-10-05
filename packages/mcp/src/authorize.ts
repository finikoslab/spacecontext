import { AuthorizationError, CimdFetchError, type AuthRequest, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { BackendError, backendJson } from './backend.js';
import type { Env, GrantProps } from './env.js';
import { consentPage, emailPage, errorPage, page } from './html.js';

/** Scopes this server can grant, as advertised in its OAuth metadata. */
export const SCOPES_SUPPORTED = ['spaces:read', 'spaces:sensitive', 'offline_access'];
/** What any access needs: clients ask for it first. */
export const REQUIRED_SCOPES = ['spaces:read'];
/** What the API key of a grant may do: read spaces and follow scans. Never write, never spend. */
const KEY_SCOPES = ['spaces:read', 'scans:read'];

type VerifyResponse = { session_token: string; user: { id: string; email: string } };
type CreatedKey = { id: string; key: string; scopes: string[] };

function clientIp(request: Request): string | null {
  return request.headers.get('CF-Connecting-IP');
}

/**
 * Forms are posted only from this server's own pages. The library binds the
 * consent handle to the browser; this keeps other sites from making a signed-in
 * browser send code emails or post the forms.
 */
function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (origin !== null) return origin === new URL(env.PUBLIC_URL).origin || origin === new URL(request.url).origin;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

/** The authorization request and what the page must show about it, from the original query. */
async function describe(env: Env, request: Request, oauth: string): Promise<{ authRequest: AuthRequest; consent: ConsentDescription }> {
  const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(`${new URL(request.url).origin}/authorize?${oauth}`));
  return { authRequest, consent: await env.OAUTH_PROVIDER.describeConsent(authRequest) };
}

/**
 * A request the library refused. Back to the client when its redirect URI is
 * validated, otherwise on this page. Anything else (a KV outage, a bug) is not
 * the user's doing and surfaces as a 500.
 */
function refused(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return new Response(null, { status: 302, headers: { Location: error.redirectTo } });
  }
  if (error instanceof AuthorizationError) return errorPage('Invalid request', error.description, 400);
  if (error instanceof CimdFetchError) return errorPage('Unknown app', 'This app could not be verified. Start again from your assistant.', 400);
  throw error;
}

function expired(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return errorPage('Request expired', 'This page expired, was already used, or was opened in another browser. Start again from your assistant.', 400);
  }
  throw error;
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [name, value] of form.entries()) if (typeof value === 'string') out[name] = value;
  return out;
}

function validEmail(value: string | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

async function showAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = new URL(request.url).search.slice(1);
  let described;
  try {
    described = await describe(env, request, oauth);
  } catch (error) {
    return refused(error);
  }
  const transaction = await env.OAUTH_PROVIDER.beginConsent(described.authRequest);
  return emailPage({ consent: described.consent, handle: transaction.handle, oauth }, transaction.headers);
}

async function sendCode(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  let described;
  try {
    described = await describe(env, request, form.oauth ?? '');
  } catch (error) {
    return refused(error);
  }
  const handle = form.handle ?? '';
  const oauth = form.oauth ?? '';
  const email = validEmail(form.email);
  if (!email) return emailPage({ consent: described.consent, handle, oauth, email: form.email ?? '', error: 'Enter a valid email address.' });
  try {
    await backendJson(env, '/auth/email/send', {
      method: 'POST',
      body: { email },
      clientIp: clientIp(request),
      language: request.headers.get('Accept-Language'),
    });
  } catch (error) {
    const message =
      error instanceof BackendError && error.status === 429
        ? 'Too many codes were requested. Wait a few minutes and try again.'
        : 'The code could not be sent. Try again in a moment.';
    return emailPage({ consent: described.consent, handle, oauth, email, error: message });
  }
  return consentPage({ consent: described.consent, handle, oauth, email });
}

async function approve(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  const handle = form.handle ?? '';
  if (form.action === 'deny') {
    try {
      const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    } catch (error) {
      return expired(error);
    }
  }

  let described;
  try {
    described = await describe(env, request, form.oauth ?? '');
  } catch (error) {
    return refused(error);
  }
  const email = validEmail(form.email);
  const code = (form.code ?? '').trim();
  const again = (error: string) => consentPage({ consent: described.consent, handle, oauth: form.oauth ?? '', email: email ?? '', error });
  if (!email) return errorPage('Invalid request', 'Start again from your assistant.', 400);
  if (!/^[0-9A-Za-z]{4,12}$/.test(code)) return again('Enter the code from the email.');

  // 1. Sign in: the code is checked before the consent handle is used, so a typo can be retried.
  let session: VerifyResponse;
  try {
    session = await backendJson<VerifyResponse>(env, '/auth/email/verify', {
      method: 'POST',
      body: { email, code },
      clientIp: clientIp(request),
      language: request.headers.get('Accept-Language'),
    });
  } catch (error) {
    if (error instanceof BackendError && error.status === 401) return again('That code is not valid or has expired.');
    if (error instanceof BackendError && error.status === 429) return again('Too many attempts. Wait a few minutes and try again.');
    return again('Sign-in failed. Try again in a moment.');
  }

  let key: CreatedKey | null = null;
  try {
    // 2. Consent: the handle works once and only in the browser that opened the page.
    const sensitive = form.sensitive === '1';
    let approved;
    try {
      approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, {
        scope: sensitive ? ['spaces:read', 'spaces:sensitive'] : ['spaces:read'],
      });
    } catch (error) {
      return expired(error);
    }
    const scopes = sensitive ? [...KEY_SCOPES, 'spaces:sensitive'] : KEY_SCOPES;

    // 3. A key for this grant only, labelled as such in the console.
    key = await backendJson<CreatedKey>(env, '/keys', {
      method: 'POST',
      sessionToken: session.session_token,
      clientIp: clientIp(request),
      body: { name: `MCP · ${described.consent.clientName}`.slice(0, 60), mode: 'live', scopes, source: 'oauth' },
    });

    if (typeof key?.key !== 'string' || !/^sc_live_[A-Za-z0-9_-]+$/.test(key.key) || !Array.isArray(key.scopes)) {
      throw new Error('The API did not return a usable key');
    }
    const props: GrantProps = { apiKey: key.key, keyId: key.id, userId: session.user.id, email: session.user.email, scopes: key.scopes };
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: approved.request,
      userId: session.user.id,
      metadata: { email: session.user.email, keyId: key.id, client: described.consent.clientName },
      scope: approved.request.scope,
      props,
    });
    const headers = new Headers(approved.headers);
    headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers });
  } catch {
    // A key without a grant would be a credential nobody holds: revoke it.
    if (key) {
      await backendJson(env, `/keys/${encodeURIComponent(key.id)}`, { method: 'DELETE', sessionToken: session.session_token, clientIp: clientIp(request) }).catch(() => undefined);
    }
    return errorPage('Something went wrong', 'The connection could not be completed. Start again from your assistant.', 502);
  } finally {
    // The console session was only needed to create the key.
    await backendJson(env, '/auth/session', { method: 'DELETE', sessionToken: session.session_token, clientIp: clientIp(request) }).catch(() => undefined);
  }
}

function home(env: Env): Response {
  return page(
    'MCP server',
    `<h1>Space Context MCP server</h1><p>Add this URL to your assistant as a remote MCP server (connector):</p><p><code>${new URL('/mcp', env.PUBLIC_URL).toString()}</code></p><p class="muted">It signs you in with your Space Context email and asks what to share.</p>`
  );
}

/** Everything that is not the MCP endpoint nor an OAuth endpoint of the library. */
export const authHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return home(env);
    if (request.method === 'GET' && url.pathname === '/authorize') return showAuthorize(request, env);
    if (request.method === 'POST' && (url.pathname === '/authorize/code' || url.pathname === '/authorize/approve')) {
      if (!sameOrigin(request, env)) return errorPage('Forbidden', 'This form can only be sent from Space Context.', 403);
      return url.pathname === '/authorize/code' ? sendCode(request, env) : approve(request, env);
    }
    return new Response('Not found', { status: 404 });
  },
};
