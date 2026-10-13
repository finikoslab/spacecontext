---
title: 'The Space Document'
description: 'The JSON document a space becomes: areas, items, issues, key locations, instructions, facts, Q&A, evidence frames and coverage, and what redaction removes.'
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
| `continuity` | How this scan was checked against the previous one, or `null`: `previous_scan_id`, `absent_items` and `resolved_issues` (each with the frame of this scan that shows the place). See [Compare two scans](skills-and-diff.md#gone-or-just-not-filmed) |
| `coverage` | `warnings` (weak coverage, unreadable labels, withheld text), `not_documented` (what a reader would expect but the video did not show) and `checklist`: the key locations every frame was checked for, those of the space's type in their order (a flat: `electrical_panel`, `water_shutoff`, `water_heater`…; a car: `identification_plate`, `instrument_panel`, `engine_bay`…; see [Guided capture](../guides/guided-capture.md#what-to-film-for-each-type-of-space)), each `seen` or not, with its `probability` and best frames. Not seen means not filmed: a hint for the next recording. Empty for scans whose frames were not checked. |
| `transcript` | Only with `include=transcript` and `spaces:sensitive` |

## Records

| Record | Main fields |
| --- | --- |
| **Area** | `id`, `name`, `type` (`kitchen`, `bathroom`, `bedroom`, …), `level`, `condition` (`code`, `notes`), `description`, `orientation` (one sentence from where one comes in: "Coming in from the hallway: window ahead, bed on the left"), `features`, `access_from`, `item_ids`, `issue_ids` |
| **Item** | `id`, `area_id`, `name`, `canonical_name`, `category`, `subcategory`, `quantity`, `description` (one paragraph: what it is, where it is, what was said about it, its condition), `location` (where in the area, as a sentence), `placement` (see below), `condition`, `brand`, `model`, `attributes`, `visible_text`, `aliases`, `note`, `issue_ids` (its issues), `previous_item_id` (the same object in the previous scan) |
| **Issue** | `id`, `area_id`, `item_id`, `title`, `description`, `category`, `severity` (`low`, `medium`, `high`, `critical`), `suggested_action`, `previous_issue_id` |
| **Key location** | `id`, `kind` (`water_shutoff`, `electrical_panel`, `gas_shutoff`, `water_heater`, `heating_control`, `router`, `fire_extinguisher`, `smoke_detector`, `emergency_exit`, `keys`, meters, `alarm_panel`, and for vehicles, boats, campers and appliances `identification_plate`, `instrument_panel`, `engine_bay`, `spare_wheel`, `safety_equipment`, `battery_isolator`, `bilge_pump`, `seacock`, `fuel_shutoff`, `water_tank`, `sprinkler_valve`, `control_panel`, `filter`, `utility_connections`, …), `label`, `area_id`, `description`, `location`, `placement`, `notes` |
| **Instruction** | `id`, `title`, `area_id`, `item_id`, `steps`, `source_quote` (what was said) |
| **Fact** | `id`, `kind` (`access`, `wifi`, `rule`, `contact`, `schedule`, `quirk`, `measurement`, `history`, `other`), `statement`, `value`, `sensitive`, `redacted` |
| **Q&A** | `question`, `answer`, `source` (`owner` or `generated`) |

Every record that comes from the video carries `evidence`: a list of `{ frame_id, timestamp_ms }` pointing into `frames`, and a `confidence` between 0 and 1. Condition codes are `new`, `excellent`, `good`, `fair`, `poor`, `damaged`, `not_working` and `unknown`.

Items, issues and key locations also carry `verification`: a second, independent check of the record on the frames it cites, `{ status, probability, frame_id }` with `status` `verified` (a frame clearly shows it), `unconfirmed` (its frames were checked and none clearly shows it) or `not_visual` (it cites no frame, or it is a fault or an absence no photo can show). `frame_id` is the frame that shows it best, also the first of its `evidence`. `null` where it was not computed. The demo space carries it too, computed on its published frames. See [Verified evidence](../guides/verified-evidence.md).

## Evidence frames

Each entry of `frames` has `id`, `index`, `timestamp_ms` (its time in the video) and a signed `url` with its `url_expires_at`. The URL serves the original frame, unaltered. It expires: read the document again for a fresh one. `url` is `null` for frames a redacted document does not cite, and for past scans of spaces scanned with the app (a later recording replaced their images).

## Placements

Items and key locations say where they are as structured data, so an agent can reason about it instead of parsing a sentence:

```json
"placement": {
  "anchor": "entrance door",
  "anchor_item_id": "itm_1",
  "relation": "left_of",
  "viewpoint": "facing the entrance door from inside",
  "detail": "on the wooden panel, at chest height"
}
```

- `relation` is one of `on`, `inside`, `under`, `above`, `below`, `beside`, `left_of`, `right_of`, `in_front_of`, `behind`, `opposite`, `unknown`. The first six hold from anywhere; the others are meant from `viewpoint`, which is always present with them.
- A side comes from a frame that shows both the thing and its anchor. When no frame does, the relation is `beside`, never a guessed side.
- Someone coming in through a door has it behind them: a side given facing that door from inside is the other side for them. `location` and `description` say both when the anchor is a door ("left of the entrance door, facing it from inside; on your right as you come in").
- `anchor_item_id` is the item that is the anchor, when it is one of the space's items.
- `placement` is `null` for spaces scanned with the iPhone app and for documents produced before placements existed.

## Redacted documents

A key without `spaces:sensitive` reads the same structure with:

- sensitive facts' `statement` replaced and `value` set to `null` (`redacted: true`);
- the location of keys and other sensitive key locations hidden;
- the same values removed from every other text, together with values that look like credentials, email addresses or international phone numbers even when no fact marks them;
- no transcript, no owner answers, no `source_quote`;
- `space.description`, `summary`, the top-level `features`, area `layout` and the stored `coverage.warnings` left out: they were never screened (the warning about text addressed to an AI stays);
- frames that show sensitive content without a URL, and frames no record cites without one either.

Spaces scanned with the app are readable by such a key only after the deep pass has screened them. Until then the document keeps its shape and counts, without content, and says so in `coverage.warnings`.
