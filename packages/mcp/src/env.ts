import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  /** OAuth clients, grants and tokens. */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Service binding to the API Worker. Optional: without it, API_BASE_URL is fetched. */
  BACKEND?: Fetcher;
  /** The API base, `…/v1`. */
  API_BASE_URL: string;
  /** This server's own origin, for links and the Origin check of the sign-in forms. */
  PUBLIC_URL: string;
}

/** What a grant carries, encrypted by the OAuth library with the token. */
export type GrantProps = {
  apiKey: string;
  keyId: string;
  userId: string;
  email: string;
  scopes: string[];
};
