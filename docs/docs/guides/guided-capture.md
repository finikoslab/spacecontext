---
title: 'Guided capture: what to film, checked while filming'
sidebar_label: 'Guided capture'
description: 'What to film for each type of space (homes, offices, shops, warehouses, garages, vehicles, campers, boats, appliances) and how POST /frames/check?space_type= checks each frame while it is filmed.'
---

# Guided capture: what to film, checked while filming

A scan is only as good as what was filmed. Two things help the person filming get it right the first time:

- **Capture profiles** say what to film for each type of space: the **key locations** people and agents ask about first (the fuse box and stopcock of a flat, the VIN plate and dashboard of a car, the seacocks and battery switch of a boat, the rating plate of an appliance), each with a one-line hint, and the areas of that type of space.
- **`POST /frames/check`** looks at one frame in about half a second and says whether it is usable, which of those key locations it shows and, with a type of space, which area it shows. An app can show a checklist that ticks itself while the person walks around, and point at what is still missing before the scan is made.

The same profiles drive every scan: each frame of a scan is checked for the key locations of the space's type, and the document's `coverage.checklist` lists them, seen or not.

## What to film for each type of space

Key locations in **bold** are usually there (worth a reminder when not filmed); the others count "if there is one".

| Type | Key locations | Areas |
| --- | --- | --- |
| `apartment`, `house`, `other` | **Electrical panel**, **water shut-off**, **water heater**, smoke detector, fire extinguisher, **router**, **heating control**, gas meter | Entrance, hallway, living room, kitchen, dining room, bedroom, bathroom, laundry, storage, balcony, garden, garage, stairs, outside |
| `office` | **Electrical panel**, **fire extinguisher**, **emergency exit**, smoke detector, alarm panel, first-aid kit, **router**, air-conditioning control, heating control, water shut-off | Entrance, reception, open-plan office, office, meeting room, kitchen, bathroom, storage, server room, hallway, stairs, outside |
| `shop` | The same as an office | Entrance, sales floor, checkout, fitting room, stockroom, office, bathroom, storage, outside |
| `warehouse` | **Electrical panel**, **fire extinguisher**, **emergency exit**, sprinkler valve, alarm panel, first-aid kit, smoke detector, water shut-off, electricity meter | Entrance, loading dock, storage area, mezzanine, office, bathroom, outside |
| `garage` | **Electrical panel**, water shut-off, fire extinguisher, smoke detector, electricity meter, gas shut-off | Entrance, storage area, outside |
| `vehicle` | **Identification plate** (VIN), **instrument panel**, **engine**, spare wheel, safety equipment, fire extinguisher, first-aid kit | Front, rear and side (outside), front seats, rear seats, boot, engine compartment |
| `camper` | **Identification plate**, **instrument panel**, **electrical panel**, **gas shut-off**, battery and isolator, water heater, fresh-water tank, heating control, smoke detector, fire extinguisher, spare wheel, safety equipment | Cab, living area, kitchen, bathroom, bedroom, storage, front, rear and side (outside) |
| `boat` | **Electrical panel**, **battery and isolator**, **instrument panel**, **engine**, **fire extinguisher**, **safety equipment**, bilge pump, seacocks, fuel shut-off, gas shut-off, first-aid kit, identification plate | Deck, cockpit, cabin, galley, bathroom, engine room, outside |
| `appliance` | **Identification plate** (rating plate), **control panel**, filter, connections, water shut-off | — |

`GET /capture-profiles` returns them all and `GET /capture-profiles/{space_type}` one, with labels and hints in `en`, `it`, `es`, `fr`, `de`, `pt` or `nl` (`?language=`). A hint says what to film for that type of space: the identification plate of a car is its VIN plate, of an appliance its rating plate. They are public: no key, the same for everyone, cached for an hour.

```bash
curl "$API/capture-profiles/vehicle?language=en"
```

```json
{
  "object": "capture_profile",
  "space_type": "vehicle",
  "language": "en",
  "key_locations": [
    { "kind": "identification_plate", "label": "Identification plate", "hint": "Film the VIN plate (door pillar, under the bonnet or through the windscreen) up close, holding still.", "expected": true },
    { "kind": "instrument_panel", "label": "Instrument panel", "hint": "Film the dashboard switched on, with the odometer visible.", "expected": true }
  ],
  "areas": [{ "value": "exterior_front", "label": "Front (outside)" }]
}
```

## One frame

```bash
curl -X POST "$API/frames/check?space_type=vehicle" -H "$AUTH" -H "Content-Type: image/jpeg" --data-binary @frame.jpg
```

```json
{
  "object": "frame_check",
  "livemode": true,
  "space_type": "vehicle",
  "usable": true,
  "quality": { "score": 2.41, "level": "good" },
  "shows_space": 0.99,
  "area": { "value": "interior_front", "probability": 0.88 },
  "key_locations": [
    { "kind": "identification_plate", "probability": 0.03, "seen": false },
    { "kind": "instrument_panel", "probability": 0.97, "seen": true }
  ]
}
```

- `usable`: sharp, lit and showing the space. Unusable frames are what a scan leaves out.
- `quality.level`: `unusable`, `poor`, `good` or `excellent` (`score` is the expected level, 0 to 3).
- `shows_space`: probability that the frame shows the real thing being filmed (a room, a vehicle, a boat, an appliance), not a drawing, a document or a screen.
- `area`: the most likely area and its probability; show it from about 0.6. `null` without `space_type`, for an appliance, or when the frame says too little.
- `key_locations[].seen`: probability of at least 0.7, for each key location of the type, in its order.

Without `space_type` the check is the original one: the eight key locations of a home, no area. Nothing is stored. Checks are free within a daily allowance per account (2 000 by default) and need a key with `scans:write`; a live check needs a card on file, like a live scan; test keys get a fixed answer. The same image always gets the same answer.

## In an app that films

1. When filming starts, read the profile of the space's type and show its key locations, those usually there first, unticked.
2. Every few seconds, send the latest frame (a JPEG of about 800 px is plenty) to `POST /frames/check?space_type=…`. Skip frames that are dark or blurred on the device, and back off on `429` or `503`: the recording must never wait for a check.
3. Tick a key location the first time a frame shows it, and keep the time of its best frame. Show the area from 0.6.
4. Before the person stops, say what is still missing among those usually there ("Not filmed yet: water heater"), and let them keep filming.

## From the SDK

```ts
import { SpaceContext, fetchCaptureProfile } from '@spacecontext/sdk';

const profile = await fetchCaptureProfile('vehicle'); // no key needed
const sc = new SpaceContext();
const seen = new Set<string>();
for await (const frame of framesFromTheCamera()) {
  const check = await sc.frames.check(frame.bytes, 'image/jpeg', { spaceType: 'vehicle' });
  if (!check.usable) showHint('Hold still, more light');
  for (const location of check.key_locations) if (location.seen) seen.add(location.kind);
}
const missing = profile.key_locations.filter((entry) => entry.expected && !seen.has(entry.kind));
```

`sc.captureProfiles.list()` and `sc.captureProfiles.get(type)` read the same profiles from a client (the key is not sent with them). After a scan, `summarizeCoverage(document, profile)` splits what was not filmed into `missingExpected` and `missingOptional`.

## From the terminal

```bash
npx spacecontext checklist --type vehicle       # what to film, with a hint each
npx spacecontext check ./car --type vehicle     # are these photos usable, what do they show
```

```text
FILE        USABLE  QUALITY          AREA          SHOWS
dash-1.jpg  ✓ yes   good, 2.41       Front seats   Instrument panel
boot-2.jpg  ✓ yes   good, 2.10       Boot          Spare wheel
blur-3.jpg  ✗ no    unusable, 0.31   —

Usable: 2 of 3 frames
Seen: Instrument panel (dash-1.jpg), Spare wheel (boot-2.jpg)
Not seen yet, usually there: Identification plate, Engine.
Not seen yet, if there is one: Safety equipment, Fire extinguisher, First-aid kit.
› Film them before scanning, if the space has them
```

## From an assistant (MCP)

`capture_checklist` tells the user what to film for a type of space, on any connection. On a connection allowed to scan, `check_frame` with `space_type` checks a photo the user sends.

## In every scan

Scans run the same check on every frame, with the profile of the space's type: unusable frames are left out of the analysis, footage with no usable frame is refused and refunded (`FOOTAGE_UNUSABLE`), and the document's `coverage.checklist` lists each key location of the type, seen or not, with the frames that show it. A key location mentioned in the narration ("the fuse box is in the hall cupboard") gets its photo when a frame shows it. The records of the scan are then checked again on their own photos: see [Verified evidence](verified-evidence.md).

## How accurate it is

Measured on 2026-10-13 on 191 hand-labelled photos (Wikimedia Commons, `gpt-6-luna`, threshold 0.7): precision 1.00 on the frames of their own type of space for every new key location with labelled examples, except safety equipment (0.89); "connections" has no labelled examples yet. The question "does it show the space" asked per type accepts 96% of real vehicle photos, 96% of boat photos, 88% of camper photos and all appliance photos, and refuses all nine drawings, plans, documents and screenshots; the building-only question used before called 34 of 102 such real photos "not a space". The eight key locations of a home were measured on 2026-10-06 (best F1 0.94 at 0.7 on 456 labelled answers).
