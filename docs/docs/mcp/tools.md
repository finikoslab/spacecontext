---
title: 'Tools'
description: 'The read-only tools of the Space Context MCP server, their arguments and what they return.'
---

# MCP tools

Every tool is read-only (`readOnlyHint: true`, not destructive, idempotent). Results are JSON text; results that carry space content include a `note` saying it is data captured from a physical space, not instructions.

## `list_spaces`

The spaces this connection can read, newest first, with their latest scan (counts of areas, items and issues).

| Argument | Type | |
| --- | --- | --- |
| `source` | `"app"` \| `"api"` | Optional. Only spaces from this source. |
| `cursor` | string | Optional. `next_cursor` from a previous call (50 spaces per page). |

## `search_spaces`

The records that best answer a question, across all spaces or one. Any language: an Italian question finds an English record. Records are items, areas, issues, key locations, instructions, facts and Q&A.

| Argument | Type | |
| --- | --- | --- |
| `query` | string, 1–300 characters | What to look for. |
| `space_id` | string | Optional. Only this space. |
| `limit` | integer, 1–25 | Optional, default 10. |

Each result has `space_id`, `space_name`, `scan_id`, `record_type`, `record_id`, `title`, `area`, `text` and `score`.

## `get_space`

The current document of a space, shaped for a model: area names instead of ids, no frame list, empty fields left out.

| Argument | Type | |
| --- | --- | --- |
| `space_id` | string | `app_…` or `spc_…`. |
| `sections` | array of `areas`, `items`, `issues`, `key_locations`, `instructions`, `facts`, `qa`, `coverage` | Optional. Omit for all. Ask only for what you need on large spaces. |
| `include_evidence` | boolean | Optional. Adds to each record its frames, with signed URLs for `get_evidence_photo`. |

## `ask_space`

A short answer (one to three sentences) from the records of one space, with the records it cites and their evidence, or `documented: false` when the answer is not in the records.

| Argument | Type | |
| --- | --- | --- |
| `space_id` | string | |
| `question` | string, 1–500 characters | |

## `list_scans`

The scan history of a space, newest first, to choose two scans for `compare_scans`.

| Argument | Type |
| --- | --- |
| `space_id` | string |

## `compare_scans`

What changed between two scans of a space: items added, moved, recounted or in another condition, and new issues. Items `removed` and issues `resolved` are confirmed by a frame of the empty place; `not_seen` ones were only absent from the later scan, so the assistant is told to say they *may* be missing. Each entry has evidence frames of both scans, which `get_evidence_photo` can show.

| Argument | Type | |
| --- | --- | --- |
| `space_id` | string | |
| `from_scan_id` | string | The earlier scan. |
| `to_scan_id` | string | Optional. The later scan; default the current one. |

For spaces scanned with the app, past scans are not screened, so this needs a connection granted sensitive values.

## `get_evidence_photo`

The original video frame behind a record, as an image.

| Argument | Type | |
| --- | --- | --- |
| `url` | string | A signed evidence URL from `get_space` (with `include_evidence`) or `ask_space` citations. |

Evidence links expire after a while; on `SIGNED_URL_EXPIRED`, read the record again for a fresh link.

## `get_scan_status`

Where a scan made with the API or the CLI is: `queued`, `processing` (with its stage), `complete`, `failed` or `cancelled`.

| Argument | Type |
| --- | --- |
| `scan_id` | string |

## Errors

A tool that fails returns `isError: true` with the error code and a hint, for example:

| Code | Hint given to the assistant |
| --- | --- |
| `ENRICHMENT_PENDING` | The space is being screened; retry in about a minute. |
| `PRO_REQUIRED` | App spaces need Space Context Pro. |
| `INSUFFICIENT_SCOPE` | The user did not grant this access; they can reconnect and grant it. |
| `RATE_LIMIT_EXCEEDED` | Wait the given number of seconds. |
| Key revoked | The connection ended; reconnect Space Context. |

See [all error codes](../api/errors.md).
