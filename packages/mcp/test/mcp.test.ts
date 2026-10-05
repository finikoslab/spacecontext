import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { redirectSource, SUBMIT_ONCE_SCRIPT } from '../src/html';

const ORIGIN = 'https://mcp.example.test';
const REDIRECT = 'https://claude.example/api/mcp/auth_callback';
const API_KEY = `sc_live_${'k'.repeat(43)}`;
const USER_IP = '203.0.113.7';
const CODE = '123456';

type BackendCall = { method: string; path: string; search: URLSearchParams; headers: Headers; body: unknown };

/** The Space Context API, faked: sign-in, key creation and a few read endpoints. */
function fakeBackend(overrides: Partial<Record<string, (call: BackendCall) => Response>> = {}) {
  const calls: BackendCall[] = [];
  let keyCount = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const document = {
    object: 'space_document',
    space: { id: 'app_p1', source: 'app', name: 'Seaside flat', space_type: 'apartment' },
    scan: { id: 'scn_1', analyzed_at: '2026-10-01T10:00:00.000Z' },
    enrichment: { level: 'deep', status: 'complete' },
    summary: null,
    stats: { areas: 1, items: 1, issues: 0, key_locations: 1, instructions: 0, facts: 0 },
    features: [],
    areas: [{ id: 'area_1', name: 'Bathroom', type: 'bathroom', level: null, condition: { code: 'good', label: null, notes: null }, description: null, layout: null, features: [], access_from: [], item_ids: ['itm_1'], issue_ids: [], evidence: [], confidence: null }],
    items: [{ id: 'itm_1', area_id: 'area_1', name: 'Stopcock', canonical_name: 'stopcock', category: 'plumbing', subcategory: null, quantity: 1, location: 'under the sink', condition: null, brand: null, model: null, attributes: [], visible_text: [], aliases: ['water shut-off'], note: null, issue_ids: [], evidence: [{ frame_id: 'frame-0', timestamp_ms: 1200 }], confidence: 0.9 }],
    issues: [],
    key_locations: [{ id: 'loc_1', kind: 'water_shutoff', label: 'Main water valve', area_id: 'area_1', location: 'under the sink', notes: null, evidence: [], confidence: 0.9 }],
    instructions: [],
    facts: [],
    qa: [],
    frames: [{ id: 'frame-0', index: 0, timestamp_ms: 1200, url: 'https://api.example.test/v1/media/frames/u1/p1/frame-0.jpg?token=t&expires=9', url_expires_at: null }],
    coverage: { warnings: [], not_documented: ['attic'] },
  };
  const routes: Record<string, (call: BackendCall) => Response> = {
    'POST /auth/email/send': () => json({ sent: true }),
    'POST /auth/email/verify': (call) =>
      (call.body as { code: string }).code === CODE
        ? json({ session_token: 'scs_session', expires_at: '2026-10-06T00:00:00.000Z', is_new_user: false, user: { id: 'user_1', email: 'owner@example.com', name: null, is_pro: true } })
        : json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid or expired code', request_id: 'r' } }, 401),
    'POST /keys': (call) => {
      keyCount += 1;
      return json({ id: `key_${keyCount}`, key: API_KEY, scopes: (call.body as { scopes: string[] }).scopes, source: 'oauth' }, 201);
    },
    'DELETE /auth/session': () => new Response(null, { status: 204 }),
    'DELETE /keys/key_1': () => new Response(null, { status: 204 }),
    'DELETE /keys/key_2': () => new Response(null, { status: 204 }),
    'GET /spaces': (call) =>
      json({
        data: call.search.get('source') === 'api' ? [] : [{ object: 'space', id: 'app_p1', source: 'app', name: 'Seaside flat', space_type: 'apartment', created_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-01T10:00:00.000Z', latest_scan: { id: 'scn_1', analyzed_at: null, areas: 1, items: 1, issues: 0 } }],
        next_cursor: null,
      }),
    'GET /search': (call) =>
      json({ object: 'search_results', query: call.search.get('q'), data: [{ space_id: 'app_p1', space_name: 'Seaside flat', scan_id: 'scn_1', record_type: 'item', record_id: 'itm_1', title: 'Stopcock', area: 'Bathroom', text: 'Stopcock under the sink.', score: 0.91 }] }),
    'GET /spaces/app_p1': () => json(document),
    'GET /spaces/app_pending': () => json({ error: { code: 'ENRICHMENT_PENDING', message: 'The space is being screened', request_id: 'r' } }, 409),
    'POST /spaces/app_p1/ask': (call) =>
      json({ object: 'answer', space_id: 'app_p1', scan_id: 'scn_1', question: (call.body as { question: string }).question, answer: 'Under the bathroom sink.', documented: true, citations: [{ record_type: 'item', record_id: 'itm_1', title: 'Stopcock', area: 'Bathroom', evidence: [] }] }),
    'GET /media/frames/u1/p1/frame-0.jpg': () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'Content-Type': 'image/jpeg' } }),
    ...overrides,
  };
  const backend = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      const call: BackendCall = { method: request.method, path: url.pathname.replace(/^\/v1/, ''), search: url.searchParams, headers: request.headers, body: text ? JSON.parse(text) : null };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      return route ? route(call) : json({ error: { code: 'NOT_FOUND', message: 'not found', request_id: 'r' } }, 404);
    },
  };
  return { backend: backend as unknown as Fetcher, calls };
}

let backend: ReturnType<typeof fakeBackend>;

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...(env as unknown as Env), BACKEND: backend.backend }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function registerClient(name = 'Claude') {
  const response = await call(
    new Request(`${ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    })
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Opens the consent page like a browser: returns its handle, the OAuth query and the binding cookie. */
async function openAuthorize(clientId: string) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'spaces:read',
    state: 'state-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
  });
  const response = await call(new Request(`${ORIGIN}/authorize?${query}`));
  expect(response.status).toBe(200);
  const html = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(handle).toBeTruthy();
  expect(cookie).toContain('__Host-');
  return { html, handle: handle!, oauth: query.toString(), cookie, verifier, headers: response.headers };
}

function post(path: string, form: Record<string, string>, cookie: string, headers: Record<string, string> = { Origin: ORIGIN }) {
  return call(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, 'CF-Connecting-IP': USER_IP, ...headers },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    })
  );
}

/** The whole browser flow, up to the access token. */
async function connect(options: { sensitive?: boolean; clientId?: string } = {}) {
  const clientId = options.clientId ?? (await registerClient());
  const page = await openAuthorize(clientId);
  const sent = await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'Owner@Example.com' }, page.cookie);
  expect(sent.status).toBe(200);
  const approved = await post(
    '/authorize/approve',
    { handle: page.handle, oauth: page.oauth, email: 'owner@example.com', code: CODE, action: 'approve', ...(options.sensitive ? { sensitive: '1' } : {}) },
    page.cookie
  );
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('Location')!);
  const token = await call(
    new Request(`${ORIGIN}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: page.verifier, resource: `${ORIGIN}/mcp` }).toString(),
    })
  );
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string; scope: string; refresh_token?: string };
  return { clientId, location, accessToken: body.access_token, scope: body.scope, refreshToken: body.refresh_token };
}

let rpcId = 0;
async function rpc(accessToken: string, method: string, params: Record<string, unknown> = {}) {
  const response = await call(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
        'CF-Connecting-IP': '198.51.100.9',
        Host: new URL(ORIGIN).host,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
  );
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const payload = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .at(-1)!
    : text;
  return JSON.parse(payload) as { result?: any; error?: { code: number; message: string } };
}

async function initialize(accessToken: string) {
  const init = await rpc(accessToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
  expect(init.result?.serverInfo?.name).toBe('spacecontext');
  return init.result;
}

async function tool(accessToken: string, name: string, args: Record<string, unknown>) {
  const response = await rpc(accessToken, 'tools/call', { name, arguments: args });
  expect(response.error).toBeUndefined();
  return response.result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
}

beforeEach(() => {
  backend = fakeBackend();
});

describe('authorization', () => {
  it('signs the user in, creates a read-only key for the grant, and issues a token', async () => {
    const { location, accessToken, scope } = await connect();

    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(scope.split(' ')).toEqual(['spaces:read']);

    const send = backend.calls.find((entry) => entry.path === '/auth/email/send')!;
    expect(send.body).toEqual({ email: 'owner@example.com' });
    // The user's own IP reaches the API's sign-in protection.
    expect(send.headers.get('CF-Connecting-IP')).toBe(USER_IP);

    const key = backend.calls.find((entry) => entry.path === '/keys')!;
    expect(key.headers.get('Authorization')).toBe('Bearer scs_session');
    expect(key.body).toEqual({ name: 'MCP · Claude', mode: 'live', scopes: ['spaces:read', 'scans:read'], source: 'oauth' });
    // The console session was only for creating the key.
    expect(backend.calls.some((entry) => entry.method === 'DELETE' && entry.path === '/auth/session')).toBe(true);
    expect(accessToken).toBeTruthy();
  });

  it('grants sensitive values only when the user ticks them', async () => {
    const { scope } = await connect({ sensitive: true });
    expect(scope.split(' ').sort()).toEqual(['spaces:read', 'spaces:sensitive']);
    expect((backend.calls.find((entry) => entry.path === '/keys')!.body as { scopes: string[] }).scopes).toEqual(['spaces:read', 'scans:read', 'spaces:sensitive']);
  });

  it('lets the user retry a wrong code, and deny', async () => {
    const clientId = await registerClient();
    const page = await openAuthorize(clientId);
    await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie);

    const wrong = await post('/authorize/approve', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com', code: '000000', action: 'approve' }, page.cookie);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('not valid or has expired');
    expect(backend.calls.some((entry) => entry.path === '/keys')).toBe(false);

    const denied = await post('/authorize/approve', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com', code: '', action: 'deny' }, page.cookie);
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get('Location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-123');

    // The handle works once.
    const again = await post('/authorize/approve', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com', code: CODE, action: 'approve' }, page.cookie);
    expect(again.status).toBe(400);
    expect(backend.calls.some((entry) => entry.path === '/keys')).toBe(false);
  });

  it('accepts its own form posted with an opaque origin, as browsers do under some policies', async () => {
    const page = await openAuthorize(await registerClient());
    expect(page.headers.get('Referrer-Policy')).toBe('same-origin');
    const sent = await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie, { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' });
    expect(sent.status).toBe(200);
  });

  it('refuses forms from other sites and handles bound to another browser', async () => {
    const clientId = await registerClient();
    const page = await openAuthorize(clientId);

    const forged = await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie, { Origin: 'https://evil.example' });
    expect(forged.status).toBe(403);
    const noOrigin = await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie, {});
    expect(noOrigin.status).toBe(403);
    const opaqueElsewhere = await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' });
    expect(opaqueElsewhere.status).toBe(403);
    expect(backend.calls.some((entry) => entry.path === '/auth/email/send')).toBe(false);

    // Signed in, but in a browser without the binding cookie: no grant, no key kept.
    const stolen = await post('/authorize/approve', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com', code: CODE, action: 'approve' }, '');
    expect(stolen.status).toBe(400);
    expect(backend.calls.some((entry) => entry.path === '/keys')).toBe(false);
  });

  it('lets the consent form redirect to the client, and only to it', async () => {
    const page = await openAuthorize(await registerClient());
    const consent = await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie);
    const csp = consent.headers.get('Content-Security-Policy')!;
    expect(csp).toContain(`form-action 'self' ${new URL(REDIRECT).origin};`);
    // The email step posts to this server only.
    expect(page.headers.get('Content-Security-Policy')).toContain("form-action 'self';");
  });

  it('expresses native-app redirects by their scheme, and nothing else', () => {
    expect(redirectSource('https://claude.ai/api/mcp/auth_callback')).toBe('https://claude.ai');
    expect(redirectSource('http://127.0.0.1:6274/oauth/callback')).toBe('http://127.0.0.1:6274');
    expect(redirectSource('cursor://anysphere.cursor-mcp/oauth/callback')).toBe('cursor:');
    expect(redirectSource('not a url')).toBeNull();
  });

  it('sends each form once, with a script the CSP allows by its exact hash', async () => {
    const page = await openAuthorize(await registerClient());
    expect(page.html).toContain(`<script>${SUBMIT_ONCE_SCRIPT}</script>`);
    const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SUBMIT_ONCE_SCRIPT)))));
    expect(page.headers.get('Content-Security-Policy')).toContain(`script-src 'sha256-${digest}'`);
  });

  it('escapes what the client chose to call itself', async () => {
    const clientId = await registerClient('<script>alert(1)</script>');
    const page = await openAuthorize(clientId);
    expect(page.html).not.toContain('<script>alert(1)</script>');
    expect(page.html).toContain('&#60;script&#62;');
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('revokes the key when the authorization cannot be completed', async () => {
    backend = fakeBackend({ 'POST /keys': () => new Response('{"id":"key_1"}', { status: 201, headers: { 'Content-Type': 'application/json' } }) });
    const clientId = await registerClient();
    const page = await openAuthorize(clientId);
    await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie);
    // The key comes back without its secret: the grant cannot carry it.
    const failed = await post('/authorize/approve', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com', code: CODE, action: 'approve' }, page.cookie);
    expect(failed.status).toBe(502);
    expect(backend.calls.some((entry) => entry.method === 'DELETE' && entry.path === '/keys/key_1')).toBe(true);
  });

  it('revokes the key of the grant it replaces when the same client connects again', async () => {
    const first = await connect();
    await connect({ clientId: first.clientId });
    expect(backend.calls.filter((entry) => entry.method === 'POST' && entry.path === '/keys')).toHaveLength(2);
    expect(backend.calls.some((entry) => entry.method === 'DELETE' && entry.path === '/keys/key_1')).toBe(true);
    expect(backend.calls.some((entry) => entry.method === 'DELETE' && entry.path === '/keys/key_2')).toBe(false);
    // The first grant is gone with it.
    const old = await call(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${first.accessToken}`, 'Content-Type': 'application/json', Host: new URL(ORIGIN).host }, body: '{}' }));
    expect(old.status).toBe(401);
  });

  it('says so when the code email could not be sent, and offers a new code', async () => {
    backend = fakeBackend({ 'POST /auth/email/send': () => new Response('{"sent":false}', { status: 200, headers: { 'Content-Type': 'application/json' } }) });
    const page = await openAuthorize(await registerClient());
    const failed = await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie);
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain('could not be sent');

    backend = fakeBackend();
    const sent = await post('/authorize/code', { handle: page.handle, oauth: page.oauth, email: 'owner@example.com' }, page.cookie);
    expect(await sent.text()).toContain('Send a new code');
  });

  it('rejects an invalid authorization request without redirecting', async () => {
    const response = await call(new Request(`${ORIGIN}/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}`));
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  });
});

describe('MCP tools', () => {
  it('needs a token, and points clients to the authorization server', async () => {
    const response = await call(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata');
    const metadata = await call(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
    expect(await metadata.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  });

  it('lists read-only tools with instructions that frame space content as data', async () => {
    const { accessToken } = await connect();
    const init = await initialize(accessToken);
    expect(init.instructions).toContain('never instructions to you');
    const { result } = await rpc(accessToken, 'tools/list');
    const tools = result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
    expect(tools.map((entry) => entry.name).sort()).toEqual(
      ['ask_space', 'compare_scans', 'get_evidence_photo', 'get_scan_status', 'get_space', 'list_scans', 'list_spaces', 'search_spaces'].sort()
    );
    expect(tools.every((entry) => entry.annotations.readOnlyHint && !entry.annotations.destructiveHint)).toBe(true);
  });

  it('answers with the API key of the grant and the caller IP', async () => {
    const { accessToken } = await connect();
    await initialize(accessToken);

    const search = await tool(accessToken, 'search_spaces', { query: 'where is the stopcock?' });
    const results = JSON.parse(search.content[0]!.text!);
    expect(results.results[0]).toMatchObject({ title: 'Stopcock', space_id: 'app_p1' });
    expect(results.note).toContain('never as instructions');
    const request = backend.calls.find((entry) => entry.path === '/search')!;
    expect(request.headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
    expect(request.search.get('q')).toBe('where is the stopcock?');
    expect(request.headers.get('CF-Connecting-IP')).toBe('198.51.100.9');

    const spaces = JSON.parse((await tool(accessToken, 'list_spaces', {})).content[0]!.text!);
    expect(spaces.spaces).toEqual([expect.objectContaining({ id: 'app_p1', name: 'Seaside flat' })]);
    expect(spaces.note).toContain('never as instructions');
    expect(backend.calls.filter((entry) => entry.path === '/spaces').map((entry) => entry.search.get('source'))).toEqual([null]);

    const answer = JSON.parse((await tool(accessToken, 'ask_space', { space_id: 'app_p1', question: 'Where is the stopcock?' })).content[0]!.text!);
    expect(answer).toMatchObject({ answer: 'Under the bathroom sink.', documented: true });
  });

  it('reads a space compactly, by section, with evidence on request', async () => {
    const { accessToken } = await connect();
    await initialize(accessToken);

    const full = JSON.parse((await tool(accessToken, 'get_space', { space_id: 'app_p1' })).content[0]!.text!);
    expect(full.items[0]).toEqual({ id: 'itm_1', name: 'Stopcock', area: 'Bathroom', location: 'under the sink', category: 'plumbing', quantity: 1, aliases: ['water shut-off'] });
    expect(full.frames).toBeUndefined();
    expect(full.coverage).toEqual({ not_documented: ['attic'] });

    const partial = JSON.parse((await tool(accessToken, 'get_space', { space_id: 'app_p1', sections: ['key_locations'], include_evidence: true })).content[0]!.text!);
    expect(Object.keys(partial)).not.toContain('items');
    expect(partial.key_locations[0]).toMatchObject({ kind: 'water_shutoff', area: 'Bathroom' });

    const withEvidence = JSON.parse((await tool(accessToken, 'get_space', { space_id: 'app_p1', sections: ['items'], include_evidence: true })).content[0]!.text!);
    const url = withEvidence.items[0].evidence[0].url as string;
    expect(url).toContain('/v1/media/frames/u1/p1/frame-0.jpg');

    const photo = await tool(accessToken, 'get_evidence_photo', { url });
    expect(photo.content[0]).toEqual({ type: 'image', data: btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0)), mimeType: 'image/jpeg' });
    // A signed media URL needs no key: none is sent with it.
    expect(backend.calls.find((entry) => entry.path.startsWith('/media/'))!.headers.get('Authorization')).toBeNull();

    const elsewhere = await tool(accessToken, 'get_evidence_photo', { url: 'https://evil.example/v1/media/x.jpg' });
    expect(elsewhere.isError).toBe(true);
  });

  it('ends the grant when its key was revoked in the console, so the client signs in again', async () => {
    const { accessToken } = await connect();
    await initialize(accessToken);
    backend = fakeBackend({ 'GET /search': () => new Response(JSON.stringify({ error: { code: 'INVALID_TOKEN', message: 'Invalid token', request_id: 'r' } }), { status: 401 }) });
    const result = await tool(accessToken, 'search_spaces', { query: 'oven' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Reconnect Space Context');
    const after = await call(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Host: new URL(ORIGIN).host }, body: '{}' }));
    expect(after.status).toBe(401);
  });

  it('keeps the grant on a 401 that is not about the key (an expired evidence link)', async () => {
    const { accessToken } = await connect();
    await initialize(accessToken);
    backend = fakeBackend({
      'GET /media/frames/u1/p1/frame-0.jpg': () => new Response(JSON.stringify({ error: { code: 'SIGNED_URL_EXPIRED', message: 'Signed URL expired', request_id: 'r' } }), { status: 401 }),
    });
    const photo = await tool(accessToken, 'get_evidence_photo', { url: 'https://api.example.test/v1/media/frames/u1/p1/frame-0.jpg?token=old&expires=1' });
    expect(photo.isError).toBe(true);
    expect(photo.content[0]!.text).toContain('fresh link');
    // Still connected.
    const search = await tool(accessToken, 'search_spaces', { query: 'oven' });
    expect(search.isError).toBeUndefined();
  });

  it('turns API errors into tool errors with advice', async () => {
    const { accessToken } = await connect();
    await initialize(accessToken);
    const pending = await tool(accessToken, 'get_space', { space_id: 'app_pending' });
    expect(pending.isError).toBe(true);
    expect(pending.content[0]!.text).toContain('ENRICHMENT_PENDING');
    expect(pending.content[0]!.text).toContain('retry in about a minute');

    const invalid = await rpc(accessToken, 'tools/call', { name: 'get_space', arguments: { space_id: '../../keys' } });
    expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
    expect(backend.calls.some((entry) => entry.path.includes('keys') && entry.method === 'GET')).toBe(false);
  });
});
