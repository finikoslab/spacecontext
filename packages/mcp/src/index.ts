import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { iconResponse } from './brand.js';
import { createMcpHandler } from 'agents/mcp/server';
import { authHandler, REQUIRED_SCOPES, SCOPES_SUPPORTED } from './authorize.js';
import { apiClient } from './backend.js';
import type { Env, GrantProps } from './env.js';
import { serverCard } from './card.js';
import { createServer } from './tools.js';

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
    scopesSupported: SCOPES_SUPPORTED,
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Space Context' },
    requiredScopes: REQUIRED_SCOPES,
    accessTokenTTL: 3600,
    // A grant lives while it is used: three months after its last refresh.
    refreshTokenTTL: 90 * 86_400,
    refreshTokenIdleTTL: 90 * 86_400,
  });
}

const providers = new Map<string, OAuthProvider<Env>>();

const SERVER_CARD_PATH = '/.well-known/mcp/server-card.json';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The Space Context mark, for clients and browsers that show the server's icon.
    if (request.method === 'GET') {
      const icon = iconResponse(new URL(request.url).pathname);
      if (icon) return Promise.resolve(icon);
    }
    // The MCP Server Card: public discovery, before any sign-in.
    if (request.method === 'GET' && new URL(request.url).pathname === SERVER_CARD_PATH) {
      return Promise.resolve(
        Response.json(serverCard(new URL(env.PUBLIC_URL).origin), {
          headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' },
        })
      );
    }
    let current = providers.get(env.PUBLIC_URL);
    if (!current) {
      current = provider(env.PUBLIC_URL);
      providers.set(env.PUBLIC_URL, current);
    }
    return current.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
