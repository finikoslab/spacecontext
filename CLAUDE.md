# Space Context — public SDK, CLI and MCP server

Read CONTRIBUTING.md first: it lists the layout, the security invariants and the checks.

- The API (private repo `spacecontext-backend`, branch `dev`) is the source of truth. `openapi/openapi.json` and `packages/sdk/src/generated/schema.ts` are generated: `npm run openapi:sync && npm run generate -w @spacecontext/sdk`.
- `npm run check` (build, typecheck, test) must stay green; every behaviour change comes with a test.
- Packages depend on the SDK's build (`dist`): build it before typechecking or testing the CLI or the MCP server.
- Nothing is published or deployed from here without the owner's go-ahead: no `npm publish`, no `wrangler deploy`.
- The Workers runtime rejects `redirect: 'error'` in fetch: use `'manual'` and treat a 3xx as an error.
- The consent pages are tested in a real browser too (MCP Inspector against `wrangler dev`): workerd tests send headers browsers do not. Lessons: with `Referrer-Policy: no-referrer` browsers post forms with `Origin: null`; CSP `form-action` also governs the redirect after a post (the consent form must allow the client's redirect origin); a second click must not resend the form.
