import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { iconResponse } from './brand.js';
import { createMcpHandler } from 'agents/mcp/server';
import { authHandler, REQUIRED_SCOPES, SCOPES_SUPPORTED } from './auth/authorize.js';
import { errorPage } from './auth/html.js';
import { apiClient } from './api/backend.js';
import type { Env, GrantProps } from './env.js';
import { serverCard } from './server/card.js';
import { createServer } from './server/tools.js';

/**
 * `/mcp`, reached only with a valid access token: the library has checked it and
 * decrypted the grant's props, which carry the API key the tools act with.
 */
const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props: GrantProps }).props;
    const api = apiClient(env, props.apiKey, request.headers.get('CF-Connecting-IP'));
    const hooks = { onUnauthorized: () => revokeGrantOfKey(env, props) };
    return createMcpHandler(() => createServer(api, hooks, new URL(env.PUBLIC_URL).origin), { route: '/mcp', allowedHostnames: [new URL(env.PUBLIC_URL).hostname] })(request, env, ctx);
  },
};

/**
 * The key of a grant was revoked in the console: the grant goes too, so the
 * client's next request is refused and it asks the user to sign in again.
 */
async function revokeGrantOfKey(env: Env, props: GrantProps): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(props.userId, cursor ? { cursor } : {});
    for (const grant of page.items) {
      if ((grant.metadata as { keyId?: string } | null)?.keyId === props.keyId) await env.OAUTH_PROVIDER.revokeGrant(grant.id, props.userId);
    }
    cursor = page.cursor;
  } while (cursor);
}

/** The provider for this deployment's public URL, which names the protected resource (RFC 9728). */
function provider(publicUrl: string): OAuthProvider<Env> {
  const origin = new URL(publicUrl).origin;
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler: authHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    clientIdMetadataDocumentEnabled: true,
    // Codes may go to an app's own URL scheme (RFC 8252), which the authorize
    // pages then limit to known apps (NATIVE_REDIRECT_SCHEMES): Cursor falls
    // back to `cursor://` when its loopback port is taken. PKCE stays required.
    allowPrivateUseRedirectUris: true,
    scopesSupported: SCOPES_SUPPORTED,
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Space Context' },
    requiredScopes: REQUIRED_SCOPES,
    accessTokenTTL: 3600,
    // A grant lives while it is used: three months after its last refresh.
    refreshTokenTTL: 90 * 86_400,
    refreshTokenIdleTTL: 90 * 86_400,
    // A client registered dynamically (anonymously) is deleted once unused. The
    // library renews a registration on a token request only past half its life,
    // so it lasts twice a grant's idle life: a client still holding a live grant
    // never finds its registration gone.
    clientRegistrationTTL: 180 * 86_400,
  });
}

/**
 * Requests per minute and client IP (`ratelimits` in wrangler.jsonc): client
 * registration is anonymous, and every sign-in page writes to KV and calls the
 * API, so neither may be driven in a loop. Without a binding, no limit.
 */
async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const registering = request.method === 'POST' && pathname === '/register';
  const limiter = registering ? env.RATE_LIMIT_REGISTER : pathname === '/authorize' || pathname.startsWith('/authorize/') ? env.RATE_LIMIT_AUTHORIZE : undefined;
  if (!limiter) return null;
  // Cloudflare sets it on every request to the custom domain; an IPv6 address
  // fits the limiter's 64-character key.
  const ip = (request.headers.get('CF-Connecting-IP') ?? 'unknown').slice(0, 64);
  if ((await limiter.limit({ key: ip })).success) return null;
  const headers = new Headers({ 'Retry-After': '60', 'Cache-Control': 'no-store' });
  if (!registering) return errorPage('Too many requests', 'Too many requests from your network. Wait a minute and try again.', 429, headers);
  // Readable by a client registering from a browser, like the library's own answers.
  const origin = request.headers.get('Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'Retry-After');
    headers.set('Vary', 'Origin');
  }
  return Response.json({ error: 'too_many_requests', error_description: 'Too many registrations from this address. Try again in a minute.' }, { status: 429, headers });
}

const providers = new Map<string, OAuthProvider<Env>>();

const SERVER_CARD_PATH = '/.well-known/mcp/server-card.json';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The Space Context mark, for clients and browsers that show the server's icon.
    if (request.method === 'GET') {
      const icon = iconResponse(new URL(request.url).pathname);
      if (icon) return icon;
    }
    // The MCP Server Card: public discovery, before any sign-in.
    if (request.method === 'GET' && new URL(request.url).pathname === SERVER_CARD_PATH) {
      return Response.json(serverCard(new URL(env.PUBLIC_URL).origin), {
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' },
      });
    }
    const limited = await rateLimited(request, env);
    if (limited) return limited;
    let current = providers.get(env.PUBLIC_URL);
    if (!current) {
      current = provider(env.PUBLIC_URL);
      providers.set(env.PUBLIC_URL, current);
    }
    return current.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
