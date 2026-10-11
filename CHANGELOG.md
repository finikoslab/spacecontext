# Changelog

All packages of this repository share a version.

## 0.2.0 — 2026-10-10

### Before the first publish

- CLI: `spacecontext setup` does the whole setup in one command: signs in (device sign-in, `--test` for a test key), adds the MCP server to Claude Code, Codex, Cursor and VS Code (the ones found, or `--client …`/`all`), installs the Space Context skill in `~/.claude/skills/spacecontext/` (from spacecontext.app, or the plugin's copy shipped in the package when offline; a file you edited is kept unless `--yes`), checks the card on file of a live account, and prints the next steps and an SDK snippet. Every step reports done, skipped or failed without stopping the others; `--yes` runs without questions or browser for agents, `--json` prints `{ steps, next }`; exit code `0` when signed in and at least one assistant is connected. Programs run with argument arrays (never a shell) and timeouts; `~/.cursor/mcp.json` is merged, written atomically and backed up once. The Setup page's agent prompt is now one line.
- Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, `plugins/spacecontext`): the MCP server and a Space Context skill in one install.
- Codex: `codex mcp add spacecontext --url https://mcp.spacecontext.app/mcp` documented.
- Live scans, and live keys that can scan, need a card on file (saved without a charge, or a paid top-up): `PAYMENT_METHOD_REQUIRED` (402) is documented, the MCP consent page offers to add a card or connect read-only, and a live `login` says so.
- SDK: a dropped event stream reconnects instead of throwing; `require()` works; sources ship in the source maps; LICENSE in every package.
- CLI: `login --key -` reads the key without echo; an empty `SPACECONTEXT_API_KEY` counts as unset.
- MCP: Enter on the consent page approves; `create_scan` refuses videos over 100 MB before creating a space; reconnecting revokes only the keys of the grants it replaces.
- SDK: `scans.wait`, `scans.events` and `scan()` stop at `timeoutMs` even while the event stream only sends pings, and close the stream; MCP `follow_scan` answers within `max_wait_seconds`. When the stream cannot be had (the account's 10 open streams all in use, `429`; a failing stream; a proxy) they poll `GET /scans/{id}` instead, less often while nothing changes and no sooner than a `429` asks, instead of failing a scan already started and charged (`sc.scan()`, CLI `scan`, `scan-status --follow`, MCP `follow_scan`).
- CLI: `setup` checks an existing Claude Code `spacecontext` server: kept when it points here, reported as skipped when it points elsewhere, replaced (user scope) with `--yes`. The card step uses the wallet's `card_on_file` when the API sends it (a paid top-up counts as a card), and otherwise asks for "a card or funds".
- CLI: clearer terminal output. A short branded help with commands grouped by task and examples, and `spacecontext <command> --help` (or `help <command>`) for each command's usage, options and examples; a mistyped command or option gets a suggestion, and an option the command does not take is refused instead of ignored. `scan` shows a live status line at a terminal (the stage and its elapsed time, then a ✓ line per stage with its duration), plain `› stage…` lines when piped, and ends with the space and the commands to ask it, export it as a skill and read it again; Ctrl+C after the start says how to follow the scan that goes on. Errors print `✗ Error [CODE]: message (request id)` followed by what to do next (the console Billing page for `PAYMENT_METHOD_REQUIRED` and `INSUFFICIENT_FUNDS`, `spacecontext login` for a refused key, `SPACECONTEXT_API_KEY` when that variable holds it…). `spaces`, `scans` and `check` print tables; `whoami` shows the key in use, masked, and where it comes from; `wallet` shows the card on file. Colours only at a terminal, none with `NO_COLOR` or `TERM=dumb`; no spinner when piped or in CI; `--json` output unchanged, with nothing on stderr but errors.
- CLI: `scan --json` (and `--format json`) exits with `0` after printing the document; it used to end with a `TypeError` and exit code `1`. Output piped into `head` no longer ends with an `EPIPE` error.
- Skill: `get_scan_status` and `follow_scan` are listed as reading tools (they work on every connection).
- Docs: top-ups from US$10; one free scan per card (a card already used on another account brings none); the daily caps on new spaces (200) and scans (500) per mode and the 10 open event streams per account.


### SDK (`@spacecontext/sdk`)

- `sc.scan(source, options)`: from a video, an image or a folder of photos (a path in Node, a `Blob`/`File`, bytes or frames) to the space's document in one call — creates the space or scans an existing one, uploads, starts, follows the scan live and returns `{ spaceId, scan, document }`, plus `markdown` or `skill` when asked. A failed scan throws the scan's own error code; nothing is charged.
- `sc.scans.events(id)`: the scan as it changes, as an async iterator over the API's event stream (`GET /scans/{id}/events`), reconnecting when the stream ends early and polling only where streaming is not possible. `sc.scans.wait()` now uses it.
- `sc.spaces.markdown(id)`: the whole space as one Markdown page.
- `sc.frames.check(bytes, type)`: guided capture — is this frame usable, which key locations does it show.
- `deviceSignIn()`, `startDeviceSignIn()`, `waitForDeviceSignIn()`: the terminal sign-in flow for any tool.
- `describeScan(scan)`: a label for every stage (`Reading the video`, `Looking at the frames`, `Extracting the context`…); `parseServerSentEvents()` exported.

### CLI (`spacecontext`)

- `spacecontext login` with nothing to paste: the terminal shows a code and opens the console, where you approve it with the scopes you choose; the key arrives in the terminal and never through the browser (`--test` for a test key, `--no-browser` to only print the link). `--key` still works.
- `scan` follows the analysis live, in words, and prints the result as `--format text|json|markdown|skill` (`--out` for a file or the skill folder).
- `markdown <space-id> [--out file]` exports one page; `scan-status --follow` streams a scan until it ends.
- `check <image|frames-dir>`: which frames are usable and which key locations they show, before paying for a scan.

### MCP server (`@spacecontext/mcp`)

- Scanning from an assistant, when the user ticks "let it scan spaces" on the consent page (`scans:write` on the grant and its key): `wallet`, `create_scan`, `upload_frame`, `start_scan`, `follow_scan` (waits on the event stream, reports progress, answers `final: false` instead of an error when the scan outlasts the wait), `cancel_scan`, `check_frame`.
- `get_space_markdown`: a space as one page of context.
- Resources `spacecontext://spaces` and `spacecontext://spaces/{space_id}`; prompts `check_out_report` and `where_is`.
- `get_space` and `compare_scans` show which key locations a recording did not film.

### API (contract `openapi/openapi.json`)

- Device sign-in: `POST /v1/auth/device`, `POST /v1/auth/device/token`, and the console's `GET|POST /v1/auth/device/{user_code}[/approve|/deny]`.
- `GET /v1/scans/{id}/events` (Server-Sent Events), `GET /v1/spaces/{id}/markdown`, `POST /v1/frames/check`, `coverage.checklist` in the Space Document, `FOOTAGE_UNUSABLE` for recordings with no usable frame (refunded).

## 0.1.0 — 2026-10-05

First public version: SDK, CLI, remote MCP server (OAuth, read-only tools), OpenAPI contract and the documentation site.
