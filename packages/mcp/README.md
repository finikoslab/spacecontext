<p align="center"><img src="https://spacecontext.app/icon/icon-512.png" width="64" height="64" alt="Space Context"></p>

# Space Context MCP server

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/finikoslab/spacecontext/blob/HEAD/LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-7C3AED)](https://spacecontext.app/developers/docs/mcp/connect/)
[![OAuth 2.1](https://img.shields.io/badge/auth-OAuth%202.1-7C3AED)](https://mcp.spacecontext.app/.well-known/oauth-authorization-server)
[![Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![Docs](https://img.shields.io/badge/docs-spacecontext.app-7C3AED)](https://spacecontext.app/developers/docs/mcp/tools/)

A remote MCP server that gives Claude, ChatGPT, Codex, Cursor, VS Code or any MCP client access to your [Space Context](https://spacecontext.app/developers/) spaces. The assistant can list spaces, search them, read them by section or as one page, ask them questions, compare scans and show the photo evidence. If you allow it, it can also scan spaces for you.

```text
https://mcp.spacecontext.app/mcp
```

It speaks MCP over Streamable HTTP and authorizes with OAuth 2.1 (dynamic client registration and client ID metadata documents). It's stateless (`createMcpHandler` from `agents`, MCP SDK v2) behind `@cloudflare/workers-oauth-provider`. This package isn't published to npm. Use the hosted server above, or [deploy your own](#deploy-your-own).

## Connect an assistant

| Client | How |
| --- | --- |
| Claude (claude.ai, Desktop) | **Settings → Connectors → Add custom connector**, paste the URL, **Connect** |
| Claude Code | `claude mcp add --transport http --scope user spacecontext https://mcp.spacecontext.app/mcp`, then `/mcp` → **Authenticate** |
| Codex | `codex mcp add spacecontext --url https://mcp.spacecontext.app/mcp`, then `codex mcp login spacecontext` |
| ChatGPT | **Settings → Apps & Connectors → Advanced → Developer mode**, then create a connector with the URL and **OAuth** |
| Cursor | `"spacecontext": { "url": "https://mcp.spacecontext.app/mcp" }` under `mcpServers` in `~/.cursor/mcp.json`, then **Login** in Cursor's MCP settings |
| VS Code | `code --add-mcp '{"name":"spacecontext","type":"http","url":"https://mcp.spacecontext.app/mcp"}'` (or `servers` in a workspace's `.vscode/mcp.json`), then **MCP: List Servers** → start it and sign in |

You never paste a key. Connecting works like this:

1. Your assistant opens a Space Context page. You sign in with Apple, Google or a code sent to your email, using the same account as the iPhone app.
2. You choose whether the assistant may see **sensitive values** (Wi-Fi passwords, door and alarm codes, the narration) and whether it may **scan spaces** for you. By default it can do neither. Scanning needs a card on file in your account (added in the console, nothing charged): without one, the page offers to connect read-only instead, or to try again once the card is added.
3. The server creates an API key for this connection only, listed as `MCP · <assistant>` in the [console](https://spacecontext.app/developers/console/). Its scopes are `spaces:read` and `scans:read`, plus `spaces:sensitive` and `scans:write` if you ticked them.

Revoking that key in the console ends the connection, and the assistant asks you to sign in again. Connecting the same assistant again replaces its previous key. The assistant sees your live spaces, including the ones scanned with the iPhone app. A space from the app becomes readable once it has been screened for sensitive values: the first read starts the screening, which takes a minute or two. Full guide: [Connect an assistant](https://spacecontext.app/developers/docs/mcp/connect/).

## Tools

Reading tools, on every connection (annotated read-only and idempotent):

| Tool | |
| --- | --- |
| `list_spaces` | Spaces with their latest scan, 50 per page |
| `search_spaces` | The records that best answer a question, across all spaces or one, in any language |
| `get_space` | A space by section (areas, items, issues, key locations, instructions, facts, Q&A, coverage), optionally with evidence |
| `get_space_markdown` | The whole space as one Markdown page, to load it as context in one call |
| `ask_space` | A short answer with citations, or `documented: false` |
| `list_scans`, `compare_scans` | The scan history, and what changed between two scans, with evidence from both |
| `get_evidence_photo` | The original video frame behind a record, as an image |
| `get_scan_status`, `follow_scan` | Where a scan is; `follow_scan` waits on the event stream and reports progress |
| `wallet` | Balance, free scans left, price of a scan |

These tools work only on a connection where the user ticked **let it scan spaces**. On any other connection the API refuses them with `INSUFFICIENT_SCOPE`:

| Tool | |
| --- | --- |
| `check_frame` | Is this photo usable, and which key locations does it show; nothing is stored or charged |
| `create_scan` | Declares a scan of an existing or a new space and returns the upload instructions |
| `upload_frame` | Sends one image of a frames scan through the server, which holds the key |
| `start_scan` | Starts and charges a scan: the free scan first, then $1.00 from the balance; refunded if it fails |
| `cancel_scan` | Cancels a scan that hasn't started; nothing is charged |

**Resources:** `spacecontext://spaces` (the list, JSON) and `spacecontext://spaces/{space_id}` (a space as Markdown). **Prompts:** `check_out_report` (compare two scans and write a report that keeps confirmed changes apart from what may be missing) and `where_is` (find one thing, with its area and evidence photo).

No tool reaches the open web. Space content is returned as data, never as instructions: the server's instructions say so, and so does a `note` in every result that carries space content. The server card at [`/.well-known/mcp/server-card.json`](https://mcp.spacecontext.app/.well-known/mcp/server-card.json) lists tools, resources and prompts before sign-in. Arguments and results: [MCP tools](https://spacecontext.app/developers/docs/mcp/tools/).

## Deploy your own

The server is a Cloudflare Worker that talks to a Space Context API (`…/v1`, with `API_V1_ENABLED = "true"`). It signs people in through the API's own sign-in endpoints and creates one API key per connection. Everything it keeps is in KV: OAuth clients, grants and tokens (grants carry the connection's API key and are encrypted by the OAuth library), and sign-ins in progress, for ten minutes, encrypted with a key that only the user's browser holds.

**1. Install and build the SDK** (the server imports it), from the repository root:

```bash
npm install
npm run build -w @spacecontext/sdk
```

**2. Create the KV namespace** for OAuth clients, grants and tokens, and put its id in `kv_namespaces` in [`wrangler.jsonc`](wrangler.jsonc). This and the next steps run in `packages/mcp`:

```bash
cd packages/mcp
npx wrangler kv namespace create OAUTH_KV
```

**3. Set the configuration** in `wrangler.jsonc` (`name`, the custom domain in `routes`, and `vars`):

| | |
| --- | --- |
| `API_BASE_URL` | The API base, for example `https://api.spacecontext.app/v1` |
| `PUBLIC_URL` | This server's origin. It names the protected resource (`/.well-known/oauth-protected-resource/mcp`) and is the only origin the consent forms accept posts from |
| `GOOGLE_WEB_CLIENT_ID` | Optional: the Google web OAuth client for "Continue with Google" |
| `APPLE_SERVICES_ID` | Optional: the Services ID for "Sign in with Apple" |
| `BACKEND` (`services`) | Optional: a service binding to the API Worker. Through it, the API sees each user's own IP for its rate limits and sign-in protection. Without it, the server calls `API_BASE_URL` over the internet and every user shares the Worker's IP. Remove the entry if the API isn't a Worker in your account |

**4. Add the secret** for Google sign-in:

```bash
npx wrangler secret put GOOGLE_WEB_CLIENT_SECRET
```

**5. Register the callback URLs** with the providers:

- Google: add `${PUBLIC_URL}/authorize/google/callback` as an authorized redirect URI of the web OAuth client.
- Apple: add `${PUBLIC_URL}/authorize/apple/callback` as a return URL of the Services ID.

Without both `GOOGLE_WEB_CLIENT_ID` and the secret, the Google button isn't shown, and the same goes for Apple without `APPLE_SERVICES_ID`. Email sign-in is always offered. The API checks Google and Apple tokens against its own web client ID and Services ID, so use the same ones the API is configured with.

**6. Deploy:**

```bash
npm run deploy     # wrangler deploy of the top-level environment
```

Keep these settings from `wrangler.jsonc`:

- `global_fetch_strictly_public` stays on. The server fetches client metadata documents from URLs that clients choose, so a plain `fetch` must never reach private addresses. The API is reached through the `BACKEND` binding.
- With `workers_dev` and `preview_urls` off, the server answers only on its custom domain.
- `ratelimits` limit each client IP to 10 registrations (`/register`) and 60 sign-in page requests (`/authorize…`) a minute, answered with `429` and `Retry-After: 60` beyond. Rate limits aren't inherited by environments, and each `namespace_id` must be unique in your Cloudflare account. Without the bindings (as in `dev`) nothing is limited.
- Access tokens last one hour. A grant lives for 90 days after its last refresh. A client registered dynamically is deleted after 180 days without a token request.

`wrangler.jsonc` also defines `dev` (local, see below) and `staging` (Space Context's own staging deployment).

## Develop

```bash
npm run dev -w @spacecontext/mcp     # http://localhost:8788, against an API on 127.0.0.1:8787
npm test -w @spacecontext/mcp        # the full OAuth flow and MCP calls in workerd, against a fake API
```

The API isn't part of this repository. The tests don't need it: they drive registration, PKCE, consent, token and real MCP calls against a fake API. The `dev` environment sets no Google or Apple client, so local sign-in uses the emailed code. Read [CONTRIBUTING.md](https://github.com/finikoslab/spacecontext/blob/HEAD/CONTRIBUTING.md) before adding a tool: any tool that writes or spends must sit behind `scans:write` and be annotated honestly.

[MIT](https://github.com/finikoslab/spacecontext/blob/HEAD/LICENSE) © Finikos S.r.l.
