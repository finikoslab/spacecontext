# Space Context MCP server

A remote MCP server on Cloudflare Workers that lets Claude and other MCP clients read your spaces. Stateless (`createMcpHandler`, MCP SDK v2) behind `@cloudflare/workers-oauth-provider`.

**Connect:** add `https://mcp.spacecontext.finikos.it/mcp` as a custom connector. You sign in with the email of your Space Context account (one-time code) and decide whether the assistant may see sensitive values (Wi-Fi passwords, door codes, narration). The server then creates an API key for that grant only, labelled `MCP · <client>` in the console. Revoking it there ends the connection: the assistant asks you to sign in again. Connecting the same assistant again replaces the previous key.

## Tools (all read-only)

| Tool | |
| --- | --- |
| `list_spaces` | Spaces with their latest scan, 50 per page (`next_cursor`) |
| `search_spaces` | Records matching a question across all spaces, any language |
| `get_space` | A space by section: areas, items, issues, key locations, instructions, facts, Q&A, coverage; optional photo evidence |
| `ask_space` | A short answer with citations, or "not documented" |
| `list_scans` / `compare_scans` | Scan history and what changed between two scans |
| `get_evidence_photo` | The original video frame behind a record |
| `get_scan_status` | Progress of a scan made with the API or the CLI |

Scanning a new space is done with the CLI or the API: an MCP tool would have to hand the agent an upload credential.

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
