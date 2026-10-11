---
title: 'Scanning a space'
sidebar_label: 'Scanning'
description: 'How to record a space for a scan: video formats and limits, phone video sizes and automatic compression, recording tips, what happens next and the cost.'
---

# Scanning a space

## What you can upload

| Input | Limits |
| --- | --- |
| Video | MP4, MOV (including iPhone HEVC), M4V, 3GP, WebM or Matroska (`.mkv`); up to 100 MB and 10 minutes |
| Photos | Up to 120 JPEG, PNG or WebP, 2 MB each, in the order they were taken |
| Transcript (API only, optional) | Up to 600 segments of 2 000 characters, with their times |

From a video, the server takes 36 to 120 frames spread over its length (about one every 4 seconds) and transcribes the audio in whatever language is spoken. `--language` sets the language of the report: `en` (default), `it`, `es`, `fr`, `de`, `pt` or `nl`. Videos are deleted as soon as the frames are extracted; the frames are kept as evidence.

### Recording tips

Phones record far more than a scan needs. A default Android recording at 1080p and 30 fps runs at 16–17 Mbps, about 120 MB a minute: it reaches 100 MB after about 50 seconds. In 4K it gets there after about 19 seconds. To fit the full 10 minutes, a video needs about 1.4 Mbps in all, for example 720p H.264 at about 1.2 Mbps with 96 kbps AAC audio.

- **Let the CLI compress it.** With [ffmpeg](https://ffmpeg.org/download.html) installed (macOS: `brew install ffmpeg`; Debian or Ubuntu: `sudo apt install ffmpeg`; Windows: `winget install ffmpeg`), `spacecontext scan` re-encodes a video over 100 MB into an MP4 that fits, then uploads that. See [below](#automatic-compression).
- **Record at 720p** to send videos as they are. On an iPhone: Settings > Camera > Record Video > 720p HD at 30 fps; on Android, the video size in the camera's settings.
- **Keep clips short**, or trim what you do not need.

### Automatic compression

When a video is over 100 MB and `ffmpeg` and `ffprobe` are on the `PATH`, the CLI reads its duration and encodes a temporary copy before creating anything:

- the bitrate fills 90% of 100 MB over the duration, at most 8 Mbps: 10 minutes get about 1.26 Mbps, a minute gets 8 Mbps;
- video in H.264 (`-preset veryfast`), its long side at most 1920 pixels, or 1280 when the bitrate is under 2.5 Mbps; a smaller video is never enlarged;
- audio in AAC, mono, 96 kbps; `+faststart`;
- a phone's rotation is applied, so the copy is upright.

A status line shows the progress; the copy is uploaded and then deleted, and your file is never changed. A video over 10 minutes is refused before encoding, since the API would refuse it too. `--compress` compresses a video that already fits; `--no-compress` never compresses (a video over 100 MB is then refused). Without ffmpeg, a video over 100 MB is refused with how to install it.

The same in one command, without the CLI (long side 1280, about 1.3 Mbps in all):

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
