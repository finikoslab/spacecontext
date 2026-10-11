---
title: 'Guided capture: check frames while filming'
sidebar_label: 'Guided capture'
description: 'Check frames while a space is filmed with POST /frames/check: usable or not, which key locations each one shows and which are still missing before a scan.'
---

# Guided capture: check frames while filming

A scan is only as good as what was filmed. `POST /frames/check` looks at one frame in about half a second and says whether it is usable and which **key locations** it shows: electrical panel, water shut-off, boiler or water heater, smoke detector, fire extinguisher, router, thermostat, gas meter. An app that films a space can show a checklist that fills in while the person walks around, and point at what is still missing before the scan is made.

Nothing is stored. Checks are free within a daily allowance per account (2 000 by default) and need a key with `scans:write`; test keys get a fixed answer.

## One frame

```bash
curl -X POST $API/frames/check -H "$AUTH" -H "Content-Type: image/jpeg" --data-binary @frame.jpg
```

```json
{
  "object": "frame_check",
  "livemode": true,
  "usable": true,
  "quality": { "score": 2.41, "level": "good" },
  "shows_space": 0.99,
  "key_locations": [
    { "kind": "electrical_panel", "probability": 0.93, "seen": true },
    { "kind": "water_shutoff", "probability": 0.04, "seen": false }
  ]
}
```

- `usable`: sharp, lit and showing a place. Unusable frames are what a scan leaves out.
- `quality.level`: `unusable`, `poor`, `good` or `excellent` (`score` is the expected level, 0 to 3).
- `shows_space`: probability that the frame shows a real place, not a drawing, a document or a screen.
- `key_locations[].seen`: probability of at least 0.7.

The same image always gets the same answer.

## From the SDK

```ts
import { SpaceContext } from '@spacecontext/sdk';

const sc = new SpaceContext();
const seen = new Set<string>();
for (const frame of framesFromTheCamera()) {
  const check = await sc.frames.check(frame.bytes, 'image/jpeg');
  if (!check.usable) showHint('Hold still, more light');
  for (const location of check.key_locations) if (location.seen) seen.add(location.kind);
}
```

## Before a scan, from the terminal

```bash
npx spacecontext check ./photos
```

```text
FILE           USABLE  QUALITY          SHOWS
hall-1.jpg     ✓ yes   good, 2.41       electrical panel
kitchen-2.jpg  ✓ yes   excellent, 2.78
blur-3.jpg     ✗ no    unusable, 0.31
plan-4.jpg     ✗ no    not a place

Usable: 2 of 4 frames
Seen: electrical panel (hall-1.jpg)
Not seen yet: water shutoff, water heater, smoke detector, fire extinguisher, router, heating control, gas meter.
› Film them before scanning, if the space has them
```

## In every scan

Scans run the same check on every frame: unusable frames are left out of the analysis, footage with no usable frame is refused and refunded (`FOOTAGE_UNUSABLE`), and the document's `coverage.checklist` lists each key location, seen or not, with the frames that show it. A key location mentioned in the narration ("the fuse box is in the hall cupboard") gets its photo when a frame shows it.
