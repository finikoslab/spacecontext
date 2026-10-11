---
title: 'Scanning a space'
sidebar_label: 'Scanning'
description: 'How to record a space for a scan: video formats and limits, phone video sizes and automatic compression, recording tips, what happens next and the cost.'
---

# Scanning a space

## What you can upload

| Input | Limits |
| --- | --- |
| Video | MP4, MOV (including iPhone HEVC), M4V, 3GP, WebM or Matroska (`.mkv`); up to 4 GB and 10 minutes |
| Photos | Up to 120 JPEG, PNG or WebP, 2 MB each, in the order they were taken |
| Transcript (API only, optional) | Up to 600 segments of 2 000 characters, with their times |

From a video, the server takes 36 to 120 frames spread over its length (about one every 4 seconds) and transcribes the audio in whatever language is spoken. `--language` sets the language of the report: `en` (default), `it`, `es`, `fr`, `de`, `pt` or `nl`. Videos are deleted as soon as the frames are extracted; the frames are kept as evidence.

### Recording tips

A phone's default recording is fine as it is. At 1080p and 30 fps (16–17 Mbps, about 120 MB a minute) the full 10 minutes come to about 1.2 GB, and in 4K at 30 fps to about 3 GB, both within the 4 GB a video can be. A bigger file only takes longer to upload.

- **On a slow connection, let the CLI compress it.** With [ffmpeg](https://ffmpeg.org/download.html) installed (macOS: `brew install ffmpeg`; Debian or Ubuntu: `sudo apt install ffmpeg`; Windows: `winget install ffmpeg`), `spacecontext scan --compress` re-encodes the video to a smaller H.264 file before uploading it, and a video over the limit is compressed to fit without asking. See [below](#automatic-compression).
- **Keep clips short**, or trim what you do not need.

### Automatic compression

When a video is over the API's limit and `ffmpeg` and `ffprobe` are on the `PATH`, or with `--compress`, the CLI reads its duration and encodes a temporary copy before creating anything. The limit is the one the API states (4 GB), or 100 MB on an API that does not state it:

- the bitrate fills 90% of the limit over the duration, at most 8 Mbps: under 4 GB that is always 8 Mbps (ten minutes come to about 600 MB); under 100 MB, 10 minutes get about 1.26 Mbps and a minute gets 8 Mbps;
- video in H.264 (`-preset veryfast`), its long side at most 1920 pixels, or 1280 when the bitrate is under 2.5 Mbps; a smaller video is never enlarged;
- audio in AAC, mono, 96 kbps; `+faststart`;
- a phone's rotation is applied, so the copy is upright.

A status line shows the progress; the copy is uploaded and then deleted, and your file is never changed. A video over 10 minutes is refused before encoding, since the API would refuse it too. `--compress` re-encodes a video that already fits to a smaller H.264 file, useful on a slow connection (when the copy comes out larger, the original is sent); `--no-compress` never compresses (a video over the limit is then refused). Without ffmpeg, a video over the limit is refused with how to install it.

A small copy in one command, without the CLI (long side 1280, about 1.3 Mbps in all: 10 minutes come to about 100 MB):

```bash
ffmpeg -i in.mov -vf "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'" \
  -c:v libx264 -preset veryfast -b:v 1200k -maxrate 1200k -bufsize 2400k \
  -c:a aac -b:a 96k -ac 1 -movflags +faststart out.mp4
```

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

$1.00 per live scan; the first live scan of a new account is free (one free scan per card). See [Billing](../account/billing.md).
