# Space Context MCP server

A remote MCP server on Cloudflare Workers that lets Claude and other MCP clients read your spaces. Stateless (`createMcpHandler`, MCP SDK v2) behind `@cloudflare/workers-oauth-provider`.

**Connect:** add `https://mcp.spacecontext.finikos.it/mcp` as a custom connector. You sign in with Apple, Google or your email (one-time code) and decide whether the assistant may see sensitive values (Wi-Fi passwords, door codes, narration) and whether it may scan spaces for you (paid from your balance). The server then creates an API key for that grant only, labelled `MCP · <client>` in the console. Revoking it there ends the connection: the assistant asks you to sign in again. Connecting the same assistant again replaces the previous key.

## Tools

Read-only, always:

| Tool | |
| --- | --- |
| `list_spaces` | Spaces with their latest scan, 50 per page (`next_cursor`) |
| `search_spaces` | Records matching a question across all spaces, any language |
| `get_space` | A space by section: areas, items, issues, key locations, instructions, facts, Q&A, coverage; optional photo evidence |
| `get_space_markdown` | The whole space as one Markdown page, to load it as context in one call |
| `ask_space` | A short answer with citations, or "not documented" |
| `list_scans` / `compare_scans` | Scan history and what changed between two scans |
| `get_evidence_photo` | The original video frame behind a record |
| `get_scan_status` / `follow_scan` | Where a scan is; `follow_scan` waits on the API's event stream and reports progress |
| `wallet` | Balance, free scans left, price per scan |

Only when the user ticks **"let it scan spaces"** on the consent page (which adds `scans:write` to the grant and to its key):

| Tool | |
| --- | --- |
| `check_frame` | Is this photo usable, and which key locations does it show (nothing is stored) |
| `create_scan` | Declare a scan of an existing or a new space; returns the upload instructions |
| `upload_frame` | Send one image of a frames scan through the server, which holds the key |
| `start_scan` / `cancel_scan` | Start (and charge: the free scan first, then the balance) or cancel before it starts |

A video upload URL that points at the API needs the user's own key, which the server never hands to the agent: `create_scan` then tells the agent to ask the user to upload with the CLI or the console. Frames go through `upload_frame`.

Resources: `spacecontext://spaces` (the list) and `spacecontext://spaces/{space_id}` (the Markdown page). Prompts: `check_out_report`, `where_is`.

## Deploy

```bash
wrangler kv namespace create OAUTH_KV          # put the id in wrangler.jsonc
npm run deploy -w @spacecontext/mcp
```

- `BACKEND` is a service binding to the API Worker (`spacecontext-backend`): the API sees each user's own IP for its rate limits and sign-in protection. Without the binding the server calls `API_BASE_URL` over the internet and every user shares this Worker's IP.
- `PUBLIC_URL` must be the server's origin: it names the protected resource (`/.well-known/oauth-protected-resource/mcp`) and is the only origin the consent forms accept posts from.
- The API must have `API_V1_ENABLED = "true"`.

## Develop

```bash
npm run dev -w @spacecontext/mcp     # http://localhost:8788, against the API on 127.0.0.1:8787
npm test -w @spacecontext/mcp        # full OAuth flow + MCP calls in workerd, fake API
```

MIT © Finikos S.r.l.
