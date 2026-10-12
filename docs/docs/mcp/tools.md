---
title: 'MCP server tools'
sidebar_label: 'Tools'
description: 'Every tool, resource and prompt of the Space Context MCP server: arguments, what each returns, which tools need scanning access and the errors they report.'
---

# MCP server tools

Reading tools are read-only (`readOnlyHint: true`, not destructive, idempotent). The scanning tools (`create_scan`, `upload_frame`, `start_scan`, `cancel_scan`) are annotated as writes, `cancel_scan` as destructive. They, and `check_frame`, are listed on every connection but work only on one where the user ticked **let it scan spaces** when connecting: otherwise the API refuses them with `INSUFFICIENT_SCOPE`. No tool reaches the open web. Results are JSON text (or a Markdown page); results that carry space content include a `note` saying it is data captured from a physical space, not instructions.

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

## `get_space_markdown`

The whole current document of a space as one Markdown page: summary, every area with its items, issues, key locations and how-to steps, then facts, Q&A, coverage and the recording. One call to load a space as context before many questions. Redacted like everything else the connection reads.

| Argument | Type | |
| --- | --- | --- |
| `space_id` | string | |
| `include_transcript` | boolean | Optional. Adds the narration; needs the sensitive-values access. |

## `get_scan_status`

Where a scan made with the API or the CLI is: `awaiting_upload`, `queued`, `processing` (with its stage), `complete`, `failed` or `cancelled`.

| Argument | Type |
| --- | --- |
| `scan_id` | string |

## `follow_scan`

Waits for a running scan and returns where it is, in words (`label`, for example "Looking at the frames"), with `final: true` once it is complete, failed or cancelled. Waits up to `max_wait_seconds`; a scan still running after that comes back with `final: false` and `next: "Still running: call follow_scan again."`, never as an error. Clients that pass a progress token get a progress notification at every stage.

| Argument | Type | |
| --- | --- | --- |
| `scan_id` | string | |
| `max_wait_seconds` | integer, 1–110 | Optional, default 55. |

## `check_frame`

One photo checked as a scan would check it: `usable` (sharp, lit, showing a real place), `quality` (`score` 0–3 and `level`), `shows_space`, and the key locations it shows (`key_locations_seen`) or not (`key_locations_not_seen`): electrical panel, water shut-off, boiler, smoke detector, extinguisher, router, thermostat, gas meter. Nothing is stored. Use it on a photo the user sends, or from a camera, to say what is still missing before a scan. Needs the scanning access.

| Argument | Type | |
| --- | --- | --- |
| `image_base64` | string | The image bytes (JPEG, PNG or WebP, at most 2 MB), base64 without a `data:` prefix. |
| `mime_type` | `image/jpeg` \| `image/png` \| `image/webp` | |

## `wallet`

The prepaid balance (`balance_cents`), the free scans left, the price of one scan and whether automatic top-up is on. Tell the user before starting a scan. No arguments.

## `create_scan`

Declares a new scan and returns `upload`, exactly as the API gives it, and a `next` step. Frames are sent one by one with `upload_frame`. For a video, `upload` is a one-off `PUT` URL: when it points at storage (headers given, no key needed) the agent can `PUT` the bytes there; when it points at the API it needs the user's own key, which the server never hands out, so the agent asks the user to upload with the CLI or the console. Nothing is charged until `start_scan`. Everything the server can check (a video over 4 GB or of a type the API does not take, a missing `video` or `frames`) is refused before a `new_space` is created, and a space created for a scan the API then refuses is deleted again.

| Argument | Type | |
| --- | --- | --- |
| `space_id` | string | Scan this space again (the new scan is checked against the previous one). Either this or `new_space`. |
| `new_space` | `{ name, space_type? }` | Create a space for the scan. |
| `source` | `"video"` \| `"frames"` | |
| `video` | `{ content_type, content_length }` | With `source: "video"`: `video/mp4`, `video/quicktime`, `video/x-m4v`, `video/3gpp`, `video/webm`, `video/x-matroska` or `video/matroska`, and the exact size in bytes. Up to 4 GB and 10 minutes on api.spacecontext.app; the API states its limit in `GET /v1`. |
| `frames` | `{ count }` | With `source: "frames"`: how many images (1–120). |
| `language` | `"en"` \| `"it"` \| `"es"` \| `"fr"` \| `"de"` \| `"pt"` \| `"nl"` | Optional, default `en`: the language the report is written in (English, Italiano, Español, Français, Deutsch, Português, Nederlands). The narration can be in any language. |

## `upload_frame`

Sends one image of a frames scan, at its index (`0…count-1`), through the server, which holds the key. JPEG, PNG or WebP, at most 2 MB, base64. Sending an index again replaces that frame. Then `start_scan`.

| Argument | Type | |
| --- | --- | --- |
| `scan_id` | string | |
| `index` | integer | 0 to 119 |
| `image_base64` | string | The image bytes, base64, no `data:` prefix. |
| `mime_type` | `"image/jpeg"` \| `"image/png"` \| `"image/webp"` | |

## `start_scan`

Starts the analysis of an uploaded scan and charges it now: the free scan first, then the balance. Returns the scan with its `charge`. A scan that fails is refunded.

| Argument | Type |
| --- | --- |
| `scan_id` | string |

## `cancel_scan`

Cancels a scan that has not started: nothing is charged, its uploads are deleted. A scan already started cannot be cancelled.

| Argument | Type |
| --- | --- |
| `scan_id` | string |

## Resources

| URI | Type | |
| --- | --- | --- |
| `spacecontext://spaces` | `application/json` | The spaces this connection can read, with their latest scan and each one's resource URI. |
| `spacecontext://spaces/{space_id}` | `text/markdown` | The space as one page, the same as `get_space_markdown`. Listed once per space. |

## Prompts

| Name | Arguments | |
| --- | --- | --- |
| `check_out_report` | `space_id`, `from_scan_id`, `to_scan_id?` | Calls `compare_scans` and writes a report in three parts: confirmed changes (removed items and resolved issues seen in a frame, new issues), possibly missing (`not_seen`, never stated as gone), and items added, moved, recounted or in another condition. |
| `where_is` | `space_id`, `item` | Finds one thing with `search_spaces` (then `ask_space`), answers with area and location as recorded, and offers the evidence photo. |

## Errors

A tool that fails returns `isError: true` with the error code and a hint, for example:

| Code | Hint given to the assistant |
| --- | --- |
| `ENRICHMENT_PENDING` | The space is being screened; retry in about a minute. |
| `PRO_REQUIRED` | App spaces need Space Context Pro on this deployment (not the case today). |
| `INSUFFICIENT_SCOPE` | The user did not grant this access (sensitive values, or scanning); they can reconnect and tick it. |
| `INSUFFICIENT_FUNDS` | The balance does not cover a scan; top up in the console. |
| `FRAME_CHECK_UNAVAILABLE` | Photo checks are not available right now. |
| `RATE_LIMIT_EXCEEDED` | Wait the given number of seconds. |
| Key revoked | The connection ended; reconnect Space Context. |

See [all error codes](../api/errors.md).
