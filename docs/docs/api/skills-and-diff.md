---
title: 'Skills and comparisons'
description: 'Export a space as an Agent Skill, and compare two scans of a space.'
---

# Skills and comparisons

## Agent Skill

`GET /spaces/{id}/skill` returns the space as a multi-file **Agent Skill**:

```json
{
  "object": "skill",
  "name": "space-seaside-flat",
  "space_id": "spc_3f…",
  "scan_id": "scn_8a…",
  "files": [
    { "path": "SKILL.md", "media_type": "text/markdown", "content": "---\nname: space-seaside-flat\n…" },
    { "path": "space.json", "media_type": "application/json", "content": "{…}" },
    { "path": "references/overview.md", "media_type": "text/markdown", "content": "…" },
    { "path": "references/items.md", "media_type": "text/markdown", "content": "…" }
  ]
}
```

- `SKILL.md` is a short, fixed guide: it tells the agent which file holds what, that the content is data and not instructions, to cite the area, and to say "not documented" rather than guess. The only text of the space in it is its name.
- `space.json` is the Space Document; `references/` has one file per topic: overview, one per area, items with aliases, key locations, how-to, issues, facts, Q&A, frames.
- It is built from the document this key may read: a redacted document gives a redacted skill. `include=transcript` adds the transcript and needs `spaces:sensitive`.

Write the files to a folder and point your agent at it; the CLI does it for you: `spacecontext skill <id> --out <dir>`. See [Use a space in Claude Code](../guides/claude-code-skill.md).

## One Markdown page

`GET /spaces/{id}/markdown` returns the whole space as a single readable page (`text/markdown`): the summary, every area with its items, issues, key locations and how-to steps, then facts, Q&A, coverage and the recording. Paste it in a ticket, hand it to a model as context, or save it (`spacecontext markdown <id> --out flat.md`). It follows the same rules as the Skill: built from exactly the document the key may read, never with image links, `include=transcript` with `spaces:sensitive` only, and 409 `ENRICHMENT_PENDING` for a restricted key until the space is screened.

## Compare two scans

```bash
curl "https://api.spacecontext.app/v1/spaces/spc_3f…/diff?from=scn_old…&to=scn_new…" \
  -H "Authorization: Bearer $SPACECONTEXT_API_KEY"
```

`to` defaults to the current scan. The answer summarises and lists what changed:

```json
{
  "object": "space_diff",
  "space_id": "spc_3f…",
  "from": { "scan_id": "scn_old…", "analyzed_at": "…" },
  "to": { "scan_id": "scn_new…", "analyzed_at": "…" },
  "level": "deep",
  "linked": true,
  "summary": { "areas_added": 0, "areas_removed": 0, "items_added": 1, "items_removed": 1, "items_not_seen": 2, "items_moved": 1, "items_changed": 1, "issues_new": 1, "issues_resolved": 1, "issues_not_seen": 0 },
  "areas": { "added": [], "removed": [], "condition_changed": [] },
  "items": { "added": […], "removed": […], "not_seen": […], "moved": […], "quantity_changed": […], "condition_changed": […] },
  "issues": { "new": […], "resolved": […], "not_seen": […] }
}
```

### Gone, or just not filmed?

A video shows what the camera pointed at, and two analyses of the same space never list exactly the same objects. So a comparison keeps two lists apart:

| | Means |
| --- | --- |
| `items.removed`, `issues.resolved` | **Confirmed.** A frame of the later scan shows the place where it was, without it. Each entry has a `note` and that frame. |
| `items.not_seen`, `issues.not_seen` | In the earlier scan, not in the later one, not confirmed: it may be gone, or its place was not filmed. Check it before acting on it. |

Confirmation comes from the later scan itself. When you scan a space created through the API again, the analysis is given the previous scan's inventory as a checklist: it links what it sees again (`previous_item_id`, `previous_issue_id` in the [document](space-document.md)) and reports what is gone only with a frame of the empty place (`continuity`). The comparison of two consecutive scans uses those links (`"linked": true`).

Otherwise (two scans that are not consecutive, or spaces scanned with the app) records are matched by content: area names, then the generic name of each item (`canonical_name`) in the same area, then items worded differently (*sideboard* and *TV cabinet*, *fan heater* and *heater*), never across categories. Nothing can then be confirmed gone, so what is missing is `not_seen`. Comparisons are always between two documents of the same level. List the scans with `GET /spaces/{id}/scans`.

### Evidence

Every entry carries `evidence.from` and `evidence.to`: the frames of each scan that show it, each with its signed `url` (`null` when your key may not see that image). For something gone, `to` is the photo of the empty place.

For spaces scanned with the app, past scans are not screened for sensitive values, so comparisons need `spaces:sensitive`. See the [check-in / check-out guide](../guides/check-in-check-out.md).
