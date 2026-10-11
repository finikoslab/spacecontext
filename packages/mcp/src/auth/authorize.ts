import { AuthorizationError, CimdFetchError, type AuthRequest, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { BackendError, backendJson } from '../api/backend.js';
import type { Env, GrantProps } from '../env.js';
import { cardRequiredPage, consentPage, emailPage, errorPage, keyLimitPage, page, type SignInProviders } from './html.js';

/** Scopes this server can grant, as advertised in its OAuth metadata. */
export const SCOPES_SUPPORTED = ['spaces:read', 'spaces:sensitive', 'scans:write', 'offline_access'];
/** What any access needs: clients ask for it first. */
export const REQUIRED_SCOPES = ['spaces:read'];
/**
 * What the API key of a grant may do: read spaces and follow scans. Writing
 * (scans paid from the balance, photo checks) only when the user ticks it on
 * the consent page: `scans:write` is then added to the key and to the grant.
 */
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
  // Browsers send "null" (opaque) under some referrer policies and privacy
  // settings: then Sec-Fetch-Site, set by the browser itself, decides.
  if (origin !== null && origin !== 'null') return origin === new URL(env.PUBLIC_URL).origin || origin === new URL(request.url).origin;
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

/** The API's answer when the account already holds its 20 active keys (400 `VALIDATION_ERROR`, no code of its own). */
function isKeyLimit(error: unknown): boolean {
  return error instanceof BackendError && error.status === 400 && error.code === 'VALIDATION_ERROR' && /key limit/i.test(error.message);
}

function validEmail(value: string | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * A client id that is an https URL with a path names a client metadata document
 * (CIMD): every installation of that client shares it. Tested as the library does.
 */
function isMetadataDocumentClient(clientId: string): boolean {
  try {
    return new URL(clientId).protocol === 'https:' && /^https:\/\/[^/?#]*\//i.test(clientId);
  } catch {
    return false;
  }
}

/**
 * The API keys of the grants that completing this request replaces. The OAuth
 * library (`completeAuthorization`) revokes the user's grants to the same client
 * for the same resource and, for a CIMD client, with the same redirect URI (one
 * installation); this follows the same rule, so connecting a second installation
 * of a client never revokes the key of the first. Resources are compared as the
 * library stores them; a grant without one predates resources and belongs to the
 * only resource this server has.
 */
export async function keysOfReplacedGrants(env: Env, userId: string, request: Pick<AuthRequest, 'clientId' | 'redirectUri' | 'resource'>): Promise<string[]> {
  const resource = request.resource ?? new URL('/mcp', env.PUBLIC_URL).toString();
  const perInstallation = isMetadataDocumentClient(request.clientId);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, cursor ? { cursor } : {});
    for (const grant of page.items) {
      const keyId = (grant.metadata as { keyId?: unknown } | null)?.keyId;
      if (typeof keyId !== 'string' || grant.clientId !== request.clientId) continue;
      if (perInstallation && grant.redirectUri !== request.redirectUri) continue;
      if (grant.resource !== undefined && ![grant.resource].flat().includes(resource)) continue;
      keys.push(keyId);
    }
    cursor = page.cursor;
  } while (cursor);
  return keys;
}

// ---------------------------------------------------------------- Google and Apple

/** A sign-in started with a provider: what to come back to, for ten minutes, once. */
type PendingLogin = { provider: 'google' | 'apple'; handle: string; oauth: string; nonce: string };
/**
 * An identity verified by a provider, waiting for the user's consent on this
 * server's page; or one verified by an emailed code, kept when the consent has
 * to be given again (scanning asked for without a card on file).
 */
type Ticket = { sessionToken: string; userId: string; email: string; provider: 'google' | 'apple' | 'email' };

const LOGIN_TTL_SECONDS = 600;
const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const APPLE_AUTHORIZE = 'https://appleid.apple.com/auth/authorize';

function signInProviders(env: Env): SignInProviders {
  return {
    google: Boolean(env.GOOGLE_WEB_CLIENT_ID?.trim() && env.GOOGLE_WEB_CLIENT_SECRET?.trim()),
    apple: Boolean(env.APPLE_SERVICES_ID?.trim()),
  };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function callbackUrl(env: Env, provider: 'google' | 'apple'): string {
  return new URL(`/authorize/${provider}/callback`, env.PUBLIC_URL).toString();
}

/** Reads a value of OAUTH_KV once: it is deleted as it is read. */
async function takeOnce<T>(env: Env, key: string): Promise<T | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(key.split(':')[1] ?? '')) return null;
  const value = await env.OAUTH_KV.get(key);
  if (value === null) return null;
  await env.OAUTH_KV.delete(key);
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** POST /authorize/{google|apple}: from the email page, off to the provider. */
async function startProviderSignIn(request: Request, env: Env, provider: 'google' | 'apple'): Promise<Response> {
  const form = await readForm(request);
  try {
    await describe(env, request, form.oauth ?? '');
  } catch (error) {
    return refused(error);
  }
  if (!signInProviders(env)[provider]) return errorPage('Not available', 'This sign-in method is not available.', 404);
  const state = randomToken();
  const nonce = randomToken();
  const pending: PendingLogin = { provider, handle: form.handle ?? '', oauth: form.oauth ?? '', nonce };
  await env.OAUTH_KV.put(`sc-login:${state}`, JSON.stringify(pending), { expirationTtl: LOGIN_TTL_SECONDS });

  const target =
    provider === 'google'
      ? new URL(
          `${GOOGLE_AUTHORIZE}?${new URLSearchParams({
            client_id: env.GOOGLE_WEB_CLIENT_ID!.trim(),
            redirect_uri: callbackUrl(env, 'google'),
            response_type: 'code',
            scope: 'openid email profile',
            state,
            nonce,
            prompt: 'select_account',
          })}`
        )
      : new URL(
          `${APPLE_AUTHORIZE}?${new URLSearchParams({
            client_id: env.APPLE_SERVICES_ID!.trim(),
            redirect_uri: callbackUrl(env, 'apple'),
            // Apple returns name and email only with form_post.
            response_type: 'code id_token',
            response_mode: 'form_post',
            scope: 'name email',
            state,
            nonce: await sha256Hex(nonce),
          })}`
        );
  return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } });
}

/**
 * Back from the provider with a verified identity: a console session is opened
 * for it, kept under a one-time ticket, and the user is shown the consent page.
 * Consent is given on this server's page (same origin, bound to the browser),
 * never on the provider's callback, which another site can post.
 */
async function providerSignedIn(request: Request, env: Env, pending: PendingLogin, idToken: string, name: string | null): Promise<Response> {
  let described;
  try {
    described = await describe(env, request, pending.oauth);
  } catch (error) {
    return refused(error);
  }
  const label = pending.provider === 'google' ? 'Google' : 'Apple';
  let session: VerifyResponse;
  try {
    session = await backendJson<VerifyResponse>(env, `/auth/${pending.provider}`, {
      method: 'POST',
      body: pending.provider === 'google' ? { id_token: idToken } : { id_token: idToken, nonce: pending.nonce, ...(name ? { name } : {}) },
      clientIp: clientIp(request),
      language: request.headers.get('Accept-Language'),
    });
  } catch (error) {
    const message = error instanceof BackendError && error.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : `Sign-in with ${label} failed. Try again, or use your email.`;
    return emailPage({ consent: described.consent, handle: pending.handle, oauth: pending.oauth, error: message, providers: signInProviders(env) });
  }
  const ticket = randomToken();
  const value: Ticket = { sessionToken: session.session_token, userId: session.user.id, email: session.user.email, provider: pending.provider };
  await env.OAUTH_KV.put(`sc-ticket:${ticket}`, JSON.stringify(value), { expirationTtl: LOGIN_TTL_SECONDS });
  return consentPage({ consent: described.consent, handle: pending.handle, oauth: pending.oauth, email: session.user.email, ticket, signedInWith: label });
}

async function googleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pending = await takeOnce<PendingLogin>(env, `sc-login:${url.searchParams.get('state') ?? ''}`);
  if (!pending || pending.provider !== 'google') return errorPage('Request expired', 'This sign-in expired or was already used. Start again from your assistant.', 400);
  const code = url.searchParams.get('code');
  if (!code) return providerCancelled(request, env, pending);
  let idToken: string | undefined;
  try {
    const response = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_WEB_CLIENT_ID?.trim() ?? '',
        client_secret: env.GOOGLE_WEB_CLIENT_SECRET?.trim() ?? '',
        redirect_uri: callbackUrl(env, 'google'),
        grant_type: 'authorization_code',
      }).toString(),
      redirect: 'manual',
    });
    if (response.ok) idToken = ((await response.json()) as { id_token?: string }).id_token;
  } catch {
    idToken = undefined;
  }
  if (!idToken) return providerCancelled(request, env, pending, 'Sign-in with Google failed. Try again, or use your email.');
  return providerSignedIn(request, env, pending, idToken, null);
}

async function appleCallback(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  const pending = await takeOnce<PendingLogin>(env, `sc-login:${form.state ?? ''}`);
  if (!pending || pending.provider !== 'apple') return errorPage('Request expired', 'This sign-in expired or was already used. Start again from your assistant.', 400);
  if (!form.id_token) return providerCancelled(request, env, pending);
  // Apple sends the name once, on the first sign-in, outside the token.
  let name: string | null = null;
  try {
    const user = JSON.parse(form.user ?? 'null') as { name?: { firstName?: string; lastName?: string } } | null;
    name = [user?.name?.firstName, user?.name?.lastName].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim() || null;
  } catch {
    name = null;
  }
  return providerSignedIn(request, env, pending, form.id_token, name);
}

/** The user went back from the provider, or it refused: the email page again. */
async function providerCancelled(request: Request, env: Env, pending: PendingLogin, error?: string): Promise<Response> {
  try {
    const described = await describe(env, request, pending.oauth);
    const label = pending.provider === 'google' ? 'Google' : 'Apple';
    return emailPage({ consent: described.consent, handle: pending.handle, oauth: pending.oauth, error: error ?? `Sign-in with ${label} was cancelled.`, providers: signInProviders(env) });
  } catch (cause) {
    return refused(cause);
  }
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
  return emailPage({ consent: described.consent, handle: transaction.handle, oauth, providers: signInProviders(env) }, transaction.headers);
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
  if (!email) return emailPage({ consent: described.consent, handle, oauth, email: form.email ?? '', error: 'Enter a valid email address.', providers: signInProviders(env) });
  try {
    const sent = await backendJson<{ sent?: boolean }>(env, '/auth/email/send', {
      method: 'POST',
      body: { email },
      clientIp: clientIp(request),
      language: request.headers.get('Accept-Language'),
    });
    if (sent?.sent === false) throw new BackendError(502, 'EMAIL_NOT_SENT', 'The code could not be sent');
  } catch (error) {
    const message =
      error instanceof BackendError && error.status === 429
        ? 'Too many codes were requested. Wait a few minutes and try again.'
        : 'The code could not be sent. Try again in a moment.';
    return emailPage({ consent: described.consent, handle, oauth, email, error: message, providers: signInProviders(env) });
  }
  return consentPage({ consent: described.consent, handle, oauth, email });
}

async function approve(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  const handle = form.handle ?? '';
  // Signed in with Google or Apple: the identity was verified on the callback.
  const ticket = form.ticket ? await takeOnce<Ticket>(env, `sc-ticket:${form.ticket}`) : null;
  if (form.ticket && !ticket) return errorPage('Request expired', 'This sign-in expired or was already used. Start again from your assistant.', 400);
  if (form.action === 'deny') {
    if (ticket) {
      await backendJson(env, '/auth/session', { method: 'DELETE', sessionToken: ticket.sessionToken, clientIp: clientIp(request) }).catch(() => undefined);
    }
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
  const email = ticket ? ticket.email : validEmail(form.email);
  const code = (form.code ?? '').trim();
  const again = (error: string) => consentPage({ consent: described.consent, handle, oauth: form.oauth ?? '', email: email ?? '', error });
  if (!email) return errorPage('Invalid request', 'Start again from your assistant.', 400);
  if (!ticket && !/^[0-9A-Za-z]{4,12}$/.test(code)) return again('Enter the code from the email.');

  // 1. Sign in: the code is checked before the consent handle is used, so a typo can be retried.
  let session: VerifyResponse;
  if (ticket) {
    session = { session_token: ticket.sessionToken, user: { id: ticket.userId, email: ticket.email } };
  } else {
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
  }

  let key: CreatedKey | null = null;
  // Kept only when the consent is asked again (see below): a one-time ticket then holds it.
  let keepSession = false;
  try {
    // 2. Consent: the handle works once and only in the browser that opened the page.
    const sensitive = form.sensitive === '1';
    const scanning = form.scans === '1';
    let approved;
    try {
      approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, {
        scope: ['spaces:read', ...(sensitive ? ['spaces:sensitive'] : []), ...(scanning ? ['scans:write'] : [])],
      });
    } catch (error) {
      return expired(error);
    }
    const scopes = [...KEY_SCOPES, ...(sensitive ? ['spaces:sensitive'] : []), ...(scanning ? ['scans:write'] : [])];

    // 3. A key for this grant only, labelled as such in the console.
    try {
      key = await backendJson<CreatedKey>(env, '/keys', {
        method: 'POST',
        sessionToken: session.session_token,
        clientIp: clientIp(request),
        body: { name: `MCP · ${described.consent.clientName}`.slice(0, 60), mode: 'live', scopes, source: 'oauth' },
      });
    } catch (error) {
      // Nothing was created: a key revoked in the console makes room. The used
      // handle's cookie is cleared.
      if (isKeyLimit(error)) return keyLimitPage(approved.headers);
      if (!(scanning && error instanceof BackendError && error.code === 'PAYMENT_METHOD_REQUIRED')) throw error;
      // A live key that can scan needs a card on file. The handle was used, so the
      // same consent starts again for the request just approved, bound to this
      // browser like the first, with the signed-in user under a one-time ticket:
      // read-only now, or with scanning once a card is added.
      const transaction = await env.OAUTH_PROVIDER.beginConsent(approved.request);
      const ticketId = randomToken();
      const value: Ticket = { sessionToken: session.session_token, userId: session.user.id, email: session.user.email, provider: ticket?.provider ?? 'email' };
      await env.OAUTH_KV.put(`sc-ticket:${ticketId}`, JSON.stringify(value), { expirationTtl: LOGIN_TTL_SECONDS });
      keepSession = true;
      const headers = new Headers(transaction.headers);
      // The used handle's cookie is cleared, the new one set.
      for (const cookie of approved.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
      return cardRequiredPage({ consent: described.consent, handle: transaction.handle, oauth: form.oauth ?? '', email: session.user.email, ticket: ticketId, sensitive }, headers);
    }

    if (typeof key?.key !== 'string' || !/^sc_live_[A-Za-z0-9_-]+$/.test(key.key) || !Array.isArray(key.scopes)) {
      throw new Error('The API did not return a usable key');
    }
    const props: GrantProps = { apiKey: key.key, keyId: key.id, userId: session.user.id, email: session.user.email, scopes: key.scopes };
    // Connecting again replaces this client's earlier grants (the library revokes
    // them): their keys are revoked too, so the console does not fill up with keys
    // nobody holds.
    const replaced = await keysOfReplacedGrants(env, session.user.id, approved.request);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: approved.request,
      userId: session.user.id,
      metadata: { email: session.user.email, keyId: key.id, client: described.consent.clientName },
      scope: approved.request.scope,
      props,
    });
    for (const keyId of replaced) {
      await backendJson(env, `/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', sessionToken: session.session_token, clientIp: clientIp(request) }).catch(() => undefined);
    }
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
    if (!keepSession) {
      await backendJson(env, '/auth/session', { method: 'DELETE', sessionToken: session.session_token, clientIp: clientIp(request) }).catch(() => undefined);
    }
  }
}

function home(env: Env): Response {
  const providers = signInProviders(env);
  const ways = [...(providers.apple ? ['Apple'] : []), ...(providers.google ? ['Google'] : []), 'a code sent to your email'];
  const signIn = ways.length > 1 ? `${ways.slice(0, -1).join(', ')} or ${ways.at(-1)}` : ways[0];
  return page(
    'MCP server',
    `<h1>Space Context MCP server</h1><p>Add this URL to your assistant as a remote MCP server (connector):</p><p><code>${new URL('/mcp', env.PUBLIC_URL).toString()}</code></p><p class="muted">It signs you in to your Space Context account (with ${signIn}) and asks what to share.</p>`
  );
}

/** Everything that is not the MCP endpoint nor an OAuth endpoint of the library. */
export const authHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return home(env);
    if (request.method === 'GET' && url.pathname === '/authorize') return showAuthorize(request, env);
    if (request.method === 'POST' && ['/authorize/code', '/authorize/approve', '/authorize/google', '/authorize/apple'].includes(url.pathname)) {
      if (!sameOrigin(request, env)) return errorPage('Forbidden', 'This form can only be sent from Space Context.', 403);
      if (url.pathname === '/authorize/code') return sendCode(request, env);
      if (url.pathname === '/authorize/approve') return approve(request, env);
      return startProviderSignIn(request, env, url.pathname === '/authorize/google' ? 'google' : 'apple');
    }
    // The providers come back here: Google with a GET, Apple with a POST from its own site.
    // Their `state` names a sign-in this server started, once.
    if (request.method === 'GET' && url.pathname === '/authorize/google/callback') return googleCallback(request, env);
    if (request.method === 'POST' && url.pathname === '/authorize/apple/callback') return appleCallback(request, env);
    return new Response('Not found', { status: 404 });
  },
};
