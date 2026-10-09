---
title: 'Scanning'
description: 'How to record a space so that the analysis finds everything, and what a scan costs.'
---

# Scanning a space

## What you can upload

| Input | Limits |
| --- | --- |
| Video | MP4, MOV (including iPhone HEVC) or M4V; up to 500 MB and 20 minutes |
| Photos | Up to 120 JPEG, PNG or WebP, 2 MB each, in the order they were taken |
| Transcript (API only, optional) | Up to 600 segments of 2 000 characters, with their times |

From a video, the server takes 36 frames spread over its length and transcribes the audio (English or Italian, chosen with `--language`). Videos are deleted as soon as the frames are extracted; the frames are kept as evidence.

## Record well

- **Walk slowly** and keep the camera steady; turn on the lights.
- **Name the rooms out loud** as you enter them ("this is the kitchen"): the narration ties frames to areas.
- **Say what matters**: where the water shut-off and the fuse box are, how the boiler or the washing machine works, which key opens what. Spoken instructions become how-to steps; spoken codes and passwords become facts marked sensitive, hidden from keys without `spaces:sensitive`.
- **Show labels up close** for a second: brand and model plates, meter numbers, the Wi-Fi sticker.
- **Open cupboards** whose content you want to find later.
- One video per space. Re-scan later and [compare](../api/skills-and-diff.md) the two.

## What happens after the upload

1. **Start**: the scan is charged (the free scan first, then the balance; test keys are never charged).
2. **Ingesting** (videos): frames and audio are extracted.
3. **Screening**: every frame is checked once: usable or not, and which key locations it shows. Blurred, dark or covered frames are left out ([guided capture](../guides/guided-capture.md) runs the same check while you film).
4. **Observing**: every usable frame is described.
5. **Fusing**: the observations become areas, items and issues.
6. **Enriching**: the deep pass structures everything, finds key locations, instructions and facts, and screens sensitive values.
7. **Complete**: the space shows the new scan, and the [webhook](../api/webhooks.md) `scan.completed` is sent.

A scan usually takes a few minutes. If it fails (`VIDEO_UNREADABLE`, `VIDEO_TOO_LONG`, `FOOTAGE_UNUSABLE` when no frame is usable, `ANALYSIS_EMPTY` when no space is recognised, or a processing error), it is refunded and the `scan.failed` webhook is sent.

## Cost

$1.00 per live scan, the first one free. See [Billing](../account/billing.md).
