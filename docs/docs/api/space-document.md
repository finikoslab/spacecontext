---
title: 'The Space Document'
description: 'The JSON document a space becomes: areas, items, issues, key locations, instructions, facts, Q&A, frames and coverage.'
---

# The Space Document

`GET /spaces/{id}` returns the current **Space Document** of a space; `GET /spaces/{id}/scans/{scan_id}` returns a past scan as it was recorded. The schema is versioned (`schema_version: "1.0"`) and is the same for spaces scanned with the app and through the API. The exact schema is in the [API reference](/api-reference).

## Top level

| Field | |
| --- | --- |
| `space` | `id`, `source` (`app` or `api`), `name`, `description`, `space_type`, `created_at`, `updated_at` |
| `scan` | `id`, `analyzed_at`, `recorded_at`, `duration_seconds`, `device`, `frame_count` |
| `enrichment` | `level` (`base` or `deep`) and `status` (`not_requested`, `pending`, `complete`, `failed`); see [Concepts](../concepts.md#the-space-document) |
| `summary` | A short description of the space |
| `confidence` | How sure the analysis is overall, 0 to 1 |
| `features` | Features of the space as a whole |
| `stats` | Counts of areas, items, issues, key locations, instructions, facts |
| `areas`, `items`, `issues`, `key_locations`, `instructions`, `facts`, `qa` | The records, below |
| `frames` | The evidence frames, with signed URLs |
| `coverage` | `warnings` (weak coverage, unreadable labels, withheld text) and `not_documented` (what a reader would expect but the video did not show) |
| `transcript` | Only with `include=transcript` and `spaces:sensitive` |

## Records

| Record | Main fields |
| --- | --- |
| **Area** | `id`, `name`, `type` (`kitchen`, `bathroom`, `bedroom`, …), `level`, `condition` (`code`, `notes`), `description`, `features`, `access_from`, `item_ids`, `issue_ids` |
| **Item** | `id`, `area_id`, `name`, `canonical_name`, `category`, `subcategory`, `quantity`, `location` (where in the area), `condition`, `brand`, `model`, `attributes`, `visible_text`, `aliases`, `note` |
| **Issue** | `id`, `area_id`, `item_id`, `title`, `description`, `category`, `severity` (`low`, `medium`, `high`, `critical`), `suggested_action` |
| **Key location** | `id`, `kind` (`water_shutoff`, `electrical_panel`, `gas_shutoff`, `water_heater`, `heating_control`, `router`, `fire_extinguisher`, `smoke_detector`, `emergency_exit`, `keys`, meters, `alarm_panel`, …), `label`, `area_id`, `location`, `notes` |
| **Instruction** | `id`, `title`, `area_id`, `item_id`, `steps`, `source_quote` (what was said) |
| **Fact** | `id`, `kind` (`access`, `wifi`, `rule`, `contact`, `schedule`, `quirk`, `measurement`, `history`, `other`), `statement`, `value`, `sensitive`, `redacted` |
| **Q&A** | `question`, `answer`, `source` (`owner` or `generated`) |

Every record that comes from the video carries `evidence`: a list of `{ frame_id, timestamp_ms }` pointing into `frames`, and a `confidence` between 0 and 1. Condition codes are `new`, `excellent`, `good`, `fair`, `poor`, `damaged`, `not_working` and `unknown`.

## Evidence frames

Each entry of `frames` has `id`, `index`, `timestamp_ms` (its time in the video) and a signed `url` with its `url_expires_at`. The URL serves the original frame, unaltered. It expires: read the document again for a fresh one. `url` is `null` for frames a redacted document does not cite, and for past scans of spaces scanned with the app (a later recording replaced their images).

## Redacted documents

A key without `spaces:sensitive` reads the same structure with:

- sensitive facts' `statement` replaced and `value` set to `null` (`redacted: true`);
- the location of keys and other sensitive key locations hidden;
- the same values removed from every other text;
- no transcript, no owner answers, no `source_quote`;
- frames that show sensitive content without a URL.

Spaces scanned with the app are readable by such a key only after the deep pass has screened them. Until then the document keeps its shape and counts, without content, and says so in `coverage.warnings`.
