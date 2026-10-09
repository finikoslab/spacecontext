# Changelog

All packages of this repository share a version.

## 0.2.0 — 2026-10-09

### SDK (`@spacecontext/sdk`)

- `sc.scan(source, options)`: from a video, an image or a folder of photos (a path in Node, a `Blob`/`File`, bytes or frames) to the space's document in one call — creates the space or scans an existing one, uploads, starts, follows the scan live and returns `{ spaceId, scan, document }`, plus `markdown` or `skill` when asked. A failed scan throws the scan's own error code; nothing is charged.
- `sc.scans.events(id)`: the scan as it changes, as an async iterator over the API's event stream (`GET /scans/{id}/events`), reconnecting when the stream ends early and polling only where streaming is not possible. `sc.scans.wait()` now uses it.
- `sc.spaces.markdown(id)`: the whole space as one Markdown page.
- `sc.frames.check(bytes, type)`: guided capture — is this frame usable, which key locations does it show.
- `describeScan(scan)`: a label for every stage (`Reading the video`, `Looking at the frames`, `Extracting the context`…); `parseServerSentEvents()` exported.

### CLI (`spacecontext`)

- `scan` follows the analysis live, in words, and prints the result as `--format text|json|markdown|skill` (`--out` for a file or the skill folder).
- `markdown <space-id> [--out file]` exports one page; `scan-status --follow` streams a scan until it ends.
- `check <image|frames-dir>`: which frames are usable and which key locations they show, before paying for a scan.

### MCP server (`@spacecontext/mcp`)

- Scanning from an assistant, when the user ticks "let it scan spaces" on the consent page (`scans:write` on the grant and its key): `wallet`, `create_scan`, `upload_frame`, `start_scan`, `follow_scan` (waits on the event stream, reports progress, answers `final: false` instead of an error when the scan outlasts the wait), `cancel_scan`, `check_frame`.
- `get_space_markdown`: a space as one page of context.
- Resources `spacecontext://spaces` and `spacecontext://spaces/{space_id}`; prompts `check_out_report` and `where_is`.
- `get_space` and `compare_scans` show which key locations a recording did not film.

### API (contract `openapi/openapi.json`)

- `GET /v1/scans/{id}/events` (Server-Sent Events), `GET /v1/spaces/{id}/markdown`, `POST /v1/frames/check`, `coverage.checklist` in the Space Document, `FOOTAGE_UNUSABLE` for recordings with no usable frame (refunded).

## 0.1.0 — 2026-10-05

First public version: SDK, CLI, remote MCP server (OAuth, read-only tools), OpenAPI contract and the documentation site.
