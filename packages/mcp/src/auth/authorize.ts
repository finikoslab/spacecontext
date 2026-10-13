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
 * A request the library refused, shown on this page. Never sent back to the
 * client, even when its redirect URI is validated: anyone can register a client
 * with any redirect URI, so an error redirect would make this server an open
 * redirector (RFC 9700 §4.11.2). Deny still goes back to the client, through
 * `denyConsent`. Anything else (a KV outage, a bug) is not the user's doing and
 * surfaces as a 500.
 */
function refused(error: unknown): Response {
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

/**
 * A sign-in started with a provider: what to come back to, for ten minutes,
 * once. `browser` is the SHA-256 of the binding cookie's value.
 */
type PendingLogin = { provider: 'google' | 'apple'; handle: string; oauth: string; nonce: string; browser: string };
/**
 * An identity verified by a provider, waiting for the user's consent on this
 * server's page; or one verified by an emailed code, kept when the consent has
 * to be given again (scanning asked for without a card on file). `handle` is
 * the SHA-256 of the consent handle it was issued for: it works with no other.
 * Every way of using a ticket ends its console session unless a new ticket
 * takes it over; a ticket never used expires with its record, and its session,
 * which nobody holds any more, lasts until the API ends it (30 days): the API
 * has no shorter session to offer.
 */
type Ticket = { sessionToken: string; userId: string; email: string; provider: 'google' | 'apple' | 'email'; handle: string };

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
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function callbackUrl(env: Env, provider: 'google' | 'apple'): string {
  return new URL(`/authorize/${provider}/callback`, env.PUBLIC_URL).toString();
}

/** Compares two hex hashes without telling, by its timing, how much of them matched. */
function sameHash(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

type RecordKind = 'sc-login' | 'sc-ticket';

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The AES-GCM key of a record, derived from its id: only the browser holding the id can open it. */
async function recordKey(kind: RecordKind, id: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}-key:${id}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Keeps a sign-in record in OAUTH_KV for ten minutes. Records hold a console
 * session and a consent handle: each is stored under the hash of its one-time
 * id and sealed with a key derived from the id, which only the browser holds
 * (in the provider's callback URL or in the page's form), so KV alone reveals
 * neither. The OAuth library keeps its own consent transactions the same way.
 */
async function putRecord(env: Env, kind: RecordKind, id: string, value: PendingLogin | Ticket): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await recordKey(kind, id), new TextEncoder().encode(JSON.stringify(value))));
  await env.OAUTH_KV.put(`${kind}:${await sha256Hex(id)}`, `${base64url(iv)}.${base64url(sealed)}`, { expirationTtl: LOGIN_TTL_SECONDS });
}

/**
 * Reads a sign-in record without using it up. The caller checks that it belongs
 * to this request (browser, consent handle) and only then consumes it, so a
 * stranger presenting a leaked id cannot spend the record of its owner.
 */
async function openRecord<T>(env: Env, kind: RecordKind, id: string): Promise<{ value: T; consume: () => Promise<void> } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;
  const key = `${kind}:${await sha256Hex(id)}`;
  const stored = await env.OAUTH_KV.get(key);
  if (stored === null) return null;
  try {
    const [iv, sealed] = stored.split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(iv ?? '') }, await recordKey(kind, id), fromBase64url(sealed ?? ''));
    return { value: JSON.parse(new TextDecoder().decode(plain)) as T, consume: () => env.OAUTH_KV.delete(key) };
  } catch {
    return null;
  }
}

/** Keeps a signed-in identity for the consent form of one handle, under a new one-time ticket. */
async function issueTicket(env: Env, identity: Omit<Ticket, 'handle'>, handle: string): Promise<string> {
  const ticket = randomToken();
  await putRecord(env, 'sc-ticket', ticket, { ...identity, handle: await sha256Hex(handle) });
  return ticket;
}

/**
 * The identity behind a ticket, once, and only next to the consent handle it
 * was issued for. That handle works only in the browser that opened the consent
 * page, so a ticket taken anywhere else (a leaked page, a leaked callback) can
 * never approve another request, for another client, with this account.
 */
async function takeTicket(env: Env, ticket: string, handle: string): Promise<Ticket | null> {
  const record = await openRecord<Ticket>(env, 'sc-ticket', ticket);
  if (!record || typeof record.value.handle !== 'string' || !sameHash(record.value.handle, await sha256Hex(handle))) return null;
  await record.consume();
  return record.value;
}

/**
 * The cookie that binds a provider sign-in to the browser that started it. Its
 * value is random and only its hash is stored, so whoever learns the callback
 * URL (state and code) cannot finish the sign-in elsewhere: knowing the state
 * is not enough. Named after the state, so sign-ins in two tabs keep their own.
 * SameSite=None for Apple only: it comes back with a cross-site form post,
 * which never carries a Lax cookie; Google comes back with a top-level GET.
 */
async function loginCookieName(state: string): Promise<string> {
  return `__Host-sc-login-${(await sha256Hex(state)).slice(0, 16)}`;
}

function loginCookie(name: string, value: string, provider: 'google' | 'apple', maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${provider === 'apple' ? 'None' : 'Lax'}; Max-Age=${maxAge}`;
}

/**
 * The sign-in a provider came back for: once, and only in the browser that
 * started it. Returns the header that clears the binding cookie.
 */
async function takeLogin(request: Request, env: Env, provider: 'google' | 'apple', state: string): Promise<{ pending: PendingLogin; headers: Headers } | null> {
  const name = await loginCookieName(state);
  const browser = readCookie(request, name);
  if (!browser) return null;
  const record = await openRecord<PendingLogin>(env, 'sc-login', state);
  if (!record || record.value.provider !== provider || typeof record.value.browser !== 'string' || !sameHash(record.value.browser, await sha256Hex(browser))) return null;
  await record.consume();
  return { pending: record.value, headers: new Headers({ 'Set-Cookie': loginCookie(name, '', provider, 0) }) };
}

const SIGN_IN_EXPIRED = 'This sign-in expired, was already used, or was started in another browser. Start again from your assistant.';

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
  const browser = randomToken();
  const pending: PendingLogin = { provider, handle: form.handle ?? '', oauth: form.oauth ?? '', nonce, browser: await sha256Hex(browser) };
  await putRecord(env, 'sc-login', state, pending);

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
  const headers = new Headers({ Location: target.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', loginCookie(await loginCookieName(state), browser, provider, LOGIN_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

/**
 * Back from the provider with a verified identity: a console session is opened
 * for it, kept under a one-time ticket, and the user is shown the consent page.
 * Consent is given on this server's page (same origin, bound to the browser),
 * never on the provider's callback, which another site can post.
 */
async function providerSignedIn(request: Request, env: Env, login: { pending: PendingLogin; headers: Headers }, idToken: string, name: string | null): Promise<Response> {
  const { pending, headers } = login;
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
    return emailPage({ consent: described.consent, handle: pending.handle, oauth: pending.oauth, error: message, providers: signInProviders(env) }, headers);
  }
  const ticket = await issueTicket(env, { sessionToken: session.session_token, userId: session.user.id, email: session.user.email, provider: pending.provider }, pending.handle);
  return consentPage({ consent: described.consent, handle: pending.handle, oauth: pending.oauth, email: session.user.email, ticket, signedInWith: label }, headers);
}

async function googleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const login = await takeLogin(request, env, 'google', url.searchParams.get('state') ?? '');
  if (!login) return errorPage('Request expired', SIGN_IN_EXPIRED, 400);
  const code = url.searchParams.get('code');
  if (!code) return providerCancelled(request, env, login);
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
  if (!idToken) return providerCancelled(request, env, login, 'Sign-in with Google failed. Try again, or use your email.');
  return providerSignedIn(request, env, login, idToken, null);
}

async function appleCallback(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  const login = await takeLogin(request, env, 'apple', form.state ?? '');
  if (!login) return errorPage('Request expired', SIGN_IN_EXPIRED, 400);
  if (!form.id_token) return providerCancelled(request, env, login);
  // Apple sends the name once, on the first sign-in, outside the token.
  let name: string | null = null;
  try {
    const user = JSON.parse(form.user ?? 'null') as { name?: { firstName?: string; lastName?: string } } | null;
    name = [user?.name?.firstName, user?.name?.lastName].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim() || null;
  } catch {
    name = null;
  }
  return providerSignedIn(request, env, login, form.id_token, name);
}

/** The user went back from the provider, or it refused: the email page again. */
async function providerCancelled(request: Request, env: Env, login: { pending: PendingLogin; headers: Headers }, error?: string): Promise<Response> {
  const { pending, headers } = login;
  try {
    const described = await describe(env, request, pending.oauth);
    const label = pending.provider === 'google' ? 'Google' : 'Apple';
    return emailPage({ consent: described.consent, handle: pending.handle, oauth: pending.oauth, error: error ?? `Sign-in with ${label} was cancelled.`, providers: signInProviders(env) }, headers);
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
  // Signed in with Google or Apple: the identity was verified on the callback,
  // for this consent handle only.
  const ticket = form.ticket ? await takeTicket(env, form.ticket, handle) : null;
  if (form.ticket && !ticket) return errorPage('Request expired', SIGN_IN_EXPIRED, 400);
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
    // The ticket is spent: its console session is of no use to anyone now.
    if (ticket) {
      await backendJson(env, '/auth/session', { method: 'DELETE', sessionToken: ticket.sessionToken, clientIp: clientIp(request) }).catch(() => undefined);
    }
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
  const revokeKey = (keyId: string) =>
    backendJson(env, `/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', sessionToken: session.session_token, clientIp: clientIp(request) }).catch(() => undefined);
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
    const createKey = () =>
      backendJson<CreatedKey>(env, '/keys', {
        method: 'POST',
        sessionToken: session.session_token,
        clientIp: clientIp(request),
        body: { name: `MCP · ${described.consent.clientName}`.slice(0, 60), mode: 'live', scopes, source: 'oauth' },
      }).then(
        (created) => ({ created }),
        (error: unknown) => ({ error })
      );
    let attempt = await createKey();
    // Keys of the grants this one replaces, revoked before it is complete.
    let revokedFirst: string[] = [];
    if ('error' in attempt && isKeyLimit(attempt.error)) {
      // At the limit, connecting the same client again would be refused although
      // completing it revokes the key of the grant it replaces: that key goes
      // first, to make room, and the key is asked for once more. The user is
      // replacing that connection anyway; its grant, if this one is not
      // completed, ends on its next call, when the API refuses the key.
      revokedFirst = await keysOfReplacedGrants(env, session.user.id, approved.request);
      if (revokedFirst.length > 0) {
        for (const keyId of revokedFirst) await revokeKey(keyId);
        attempt = await createKey();
      }
    }
    if ('error' in attempt) {
      const { error } = attempt;
      // Nothing was created: a key revoked in the console makes room. The used
      // handle's cookie is cleared.
      if (isKeyLimit(error)) return keyLimitPage(approved.headers);
      if (!(scanning && error instanceof BackendError && error.code === 'PAYMENT_METHOD_REQUIRED')) throw error;
      // A live key that can scan needs a card on file. The handle was used, so the
      // same consent starts again for the request just approved, bound to this
      // browser like the first, with the signed-in user under a one-time ticket:
      // read-only now, or with scanning once a card is added.
      const transaction = await env.OAUTH_PROVIDER.beginConsent(approved.request);
      const identity = { sessionToken: session.session_token, userId: session.user.id, email: session.user.email, provider: ticket?.provider ?? 'email' } as const;
      const ticketId = await issueTicket(env, identity, transaction.handle);
      keepSession = true;
      const headers = new Headers(transaction.headers);
      // The used handle's cookie is cleared, the new one set.
      for (const cookie of approved.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
      return cardRequiredPage({ consent: described.consent, handle: transaction.handle, oauth: form.oauth ?? '', email: session.user.email, ticket: ticketId, sensitive }, headers);
    }
    key = attempt.created;

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
    for (const keyId of replaced) if (!revokedFirst.includes(keyId)) await revokeKey(keyId);
    const headers = new Headers(approved.headers);
    headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers });
  } catch {
    // A key without a grant would be a credential nobody holds: revoke it.
    if (key) await revokeKey(key.id);
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
