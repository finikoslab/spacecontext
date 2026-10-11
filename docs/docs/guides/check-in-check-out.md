---
title: 'Check-in and check-out'
description: 'Scan a space before and after a stay, a rental or a move, then compare: items added, gone or moved, new issues, and what the second scan did not show.'
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
npx spacecontext diff spc_3f… --from scn_checkin…        # add --json for the full answer
```

The check-out scan is analysed against the check-in one: the same objects keep their names, and something is reported **gone** only when a frame shows its place empty. The comparison lists items added, gone, moved, with a changed quantity or condition, issues new or fixed, and, apart, what the check-out scan simply did not show (`not_seen`): it may be missing, or not filmed. Every entry links to its evidence frames in both scans: the original frames, with their time in the video, never retouched.

![A space in the console after a check-out scan: the loose heater cable as a high-severity issue with its evidence frames, the fuse box and the water shut-off as key locations; History & compare holds the before/after](/docs/console/space.jpg)

## With an agent

Connected through [MCP](../mcp/connect.md), an assistant can do it for you:

> Compare the check-in and check-out scans of Flat 4B and list anything damaged or missing, with photos.

## Notes

- Comparisons match records by content, so the same room filmed from another angle is still the same room.
- Film the check-out the way you filmed the check-in: the same rooms, in the same order, with cupboards open. What the camera does not show ends up in `not_seen`, never in `removed`.
- A scan made while lights are off or too fast can miss things: check `coverage` in both documents before drawing conclusions.
- Keep both scans: deleting the space deletes its history.
