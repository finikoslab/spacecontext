---
title: 'Check-in and check-out'
description: 'Document a space before and after a stay, a rental or a move, and get what changed.'
---

# Check-in and check-out

Two scans of the same space and one comparison give you an evidence-backed record of what changed: for holiday rentals, long lets, moves, equipment handovers or vehicle returns.

## 1. Before

```bash
npx spacecontext scan checkin.mp4 --name "Flat 4B — Rossi stay" --type apartment
```

Walk every room, open cupboards, film appliances and anything already damaged, and say it out loud ("small scratch on the table, already there").

## 2. After

Scan the same space again, with its id:

```bash
npx spacecontext scan checkout.mp4 --space spc_3f…
```

## 3. Compare

```bash
npx spacecontext scans spc_3f…                       # the two scan ids
npx spacecontext diff spc_3f… --from scn_checkin… --json
```

The comparison lists items added, removed, moved, with a changed quantity or condition, and issues new or resolved. Every item and issue links to its evidence frames in each scan: the original frames, with their time in the video, never retouched.

## With an agent

Connected through [MCP](../mcp/connect.md), an assistant can do it for you:

> Compare the check-in and check-out scans of Flat 4B and list anything damaged or missing, with photos.

## Notes

- Comparisons match records by content, so the same room filmed from another angle is still the same room.
- A scan made while lights are off or too fast can miss things: the comparison reports what each scan saw. Check `coverage` in both documents before drawing conclusions.
- Keep both scans: deleting the space deletes its history.
