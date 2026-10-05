import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { authHandler, REQUIRED_SCOPES, SCOPES_SUPPORTED } from './authorize.js';
import { apiClient } from './backend.js';
import type { Env, GrantProps } from './env.js';
import { createServer } from './tools.js';

/**
 * `/mcp`, reached only with a valid access token: the library has checked it and
 * decrypted the grant's props, which carry the API key the tools act with.
 */
const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props: GrantProps }).props;
    const api = apiClient(env, props.apiKey, request.headers.get('CF-Connecting-IP'));
    return createMcpHandler(() => createServer(api), { route: '/mcp', allowedHostnames: [new URL(env.PUBLIC_URL).hostname] })(request, env, ctx);
  },
};

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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let current = providers.get(env.PUBLIC_URL);
    if (!current) {
      current = provider(env.PUBLIC_URL);
      providers.set(env.PUBLIC_URL, current);
    }
    return current.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
