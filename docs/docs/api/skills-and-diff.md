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

## Compare two scans

```bash
curl "https://api.spacecontext.finikos.it/v1/spaces/spc_3f…/diff?from=scn_old…&to=scn_new…" \
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
  "summary": { "areas_added": 0, "areas_removed": 0, "items_added": 1, "items_removed": 2, "items_moved": 1, "items_changed": 1, "issues_new": 1, "issues_resolved": 0 },
  "areas": { "added": [], "removed": [], "condition_changed": [] },
  "items": { "added": […], "removed": […], "moved": […], "quantity_changed": […], "condition_changed": […] },
  "issues": { "new": […], "resolved": […] }
}
```

Records are matched by content (area names, canonical item names), never by id, and always between two documents of the same level. List the scans with `GET /spaces/{id}/scans`.

For spaces scanned with the app, past scans are not screened for sensitive values, so comparisons need `spaces:sensitive`. See the [check-in / check-out guide](../guides/check-in-check-out.md).
