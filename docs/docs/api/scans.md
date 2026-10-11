---
title: 'Scans API'
sidebar_label: 'Scans'
description: 'Scan a space through the API: create the space, declare a video or photos, upload them, start the scan and follow it with server-sent events or webhooks.'
---

# Scans API

A scan goes through four calls: **create**, **upload**, **start**, then **follow** it (an event stream, polling, or [webhooks](webhooks.md)). The [SDK](../sdk/typescript.md) does all of it in one call, `sc.scan()`.

```bash
API=https://api.spacecontext.app/v1
AUTH="Authorization: Bearer $SPACECONTEXT_API_KEY"
```

## 1. Create a space

```bash
curl -X POST $API/spaces -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name": "Seaside flat", "space_type": "apartment"}'
```

```json
{ "object": "space", "id": "spc_3f…", "source": "api", "livemode": true, "name": "Seaside flat", "space_type": "apartment", "description": null, "external_id": null, "created_at": "…", "updated_at": "…" }
```

`external_id` (up to 128 characters) lets you store your own reference, for example a listing id.

An account creates at most 200 spaces and 500 scans a day in each mode, test keys included; past that, `429 RATE_LIMIT_EXCEEDED` with `Retry-After` until midnight UTC and the allowance in `daily_limit`. A retry with the same `external_id` or `Idempotency-Key` returns what was already created and does not count again.

## 2. Declare the scan

For a video, declare its type and exact size:

```bash
curl -X POST $API/spaces/spc_3f…/scans -H "$AUTH" -H "Content-Type: application/json" \
  -H "Idempotency-Key: flat-2026-10-05" \
  -d '{"input": {"kind": "video", "language": "en", "video": {"content_type": "video/mp4", "content_length": 48211983}}}'
```

`content_type` is the file's container:

| `content_type` | Container | Read inside it |
| --- | --- | --- |
| `video/mp4`, `video/quicktime`, `video/x-m4v`, `video/3gpp` | MP4, MOV, M4V, 3GP | H.264, HEVC (8 and 10 bit), AV1, ProRes, MPEG-4 part 2, H.263; AAC, Opus, PCM, AMR or no audio; fragmented MP4 too |
| `video/webm`, `video/x-matroska`, `video/matroska` | WebM, Matroska (`.mkv`) | VP9 or H.264; Opus or AAC |

Any frame rate is fine, and a phone's rotation is applied: a portrait video gives upright frames. Any other type (AVI, MPEG-TS, Ogg, FLV, WMV…) is refused here with `400 INVALID_CONTENT_TYPE`, before anything is created or charged; convert it to MP4 first: `ffmpeg -i in.avi -c:v libx264 -c:a aac -movflags +faststart out.mp4`.

The duration is read from the container itself, whatever type you declared (for a fragmented MP4 that does not state it, from the video), and a video over 10 minutes fails with `VIDEO_TOO_LONG`, refunded. A WebM recorded in a browser with `MediaRecorder` states no duration and cannot be read: its scan fails with `VIDEO_UNREADABLE`, refunded. Remux it first, which writes the duration: `ffmpeg -i in.webm -c copy out.webm`.

For photos, list them in order, with their time in milliseconds when you know it:

```json
{ "input": { "kind": "frames", "language": "it", "frames": [{ "timestamp_ms": 0 }, { "timestamp_ms": 2000 }] } }
```

`language` is the language the report is written in, `en` by default:

| Code | Language |
| --- | --- |
| `en` | English |
| `it` | Italiano |
| `es` | Español |
| `fr` | Français |
| `de` | Deutsch |
| `pt` | Português |
| `nl` | Nederlands |

The narration can be in any language: a video narrated in Spanish can have its report in English.

Either can carry a `transcript` (`{ "text": "…", "segments": [{ "start_ms": 0, "end_ms": 1500, "text": "This is the kitchen." }] }`) when you already have one; for videos without it, the audio is transcribed for you.

The answer is the scan, with upload instructions:

```json
{
  "object": "scan", "id": "scn_8a…", "status": "awaiting_upload",
  "upload": {
    "kind": "video", "method": "PUT",
    "url": "https://…",
    "headers": { "Content-Type": "video/mp4", "Content-Length": "48211983" },
    "expires_at": "…"
  }
}
```

## 3. Upload

**Video**: `PUT` the bytes to `upload.url` with `upload.headers`. When the URL points to storage (a signed link, valid for an hour), do not send your API key. When it points to the API (`…/v1/scans/{id}/video`, up to 95 MB), send the `Authorization` header as usual. A video can be up to 100 MB and 10 minutes.

```bash
curl -X PUT "$UPLOAD_URL" -H "Content-Type: video/mp4" --data-binary @flat.mp4
```

The `Content-Type` of the upload must be the declared type: another one is refused with `415 INVALID_CONTENT_TYPE`.

**Size.** Phones record far more than a scan needs: a default Android recording at 1080p (16–17 Mbps) reaches 100 MB after about 50 seconds, and a 4K one after about 19 seconds. Ten minutes fit at about 1.4 Mbps in all, for example 720p H.264 at about 1.2 Mbps with 96 kbps AAC. Record at 720p, trim, or compress before uploading; the [CLI](../cli/scanning.md#automatic-compression) compresses a bigger video by itself when ffmpeg is installed.

**Photos**: one `PUT` per photo to `upload.url_template` with `{index}` replaced, starting at 0:

```bash
curl -X PUT $API/scans/scn_8a…/frames/0 -H "$AUTH" -H "Content-Type: image/jpeg" --data-binary @frame-0.jpg
```

Uploads can be repeated. A scan not started within 24 hours is cancelled and its uploads deleted.

## 4. Start

```bash
curl -X POST $API/scans/scn_8a…/start -H "$AUTH" -H "Content-Type: application/json" -d '{}'
```

`202` with the scan `queued` and its `charge`: `{ "kind": "free_scan" | "scan_charge", "price_cents": 100, "refunded": false }`. The scan is charged now, atomically; see [Billing](../account/billing.md).

| Answer | Meaning |
| --- | --- |
| `202` | Started |
| `200` | Already started; nothing charged again |
| `409 UPLOAD_INCOMPLETE` | Some photos or the video are missing |
| `429 SCANS_IN_PROGRESS` | Ten scans of the account are already processing; start again when one finishes |
| `402 INSUFFICIENT_FUNDS` | Add funds (automatic top-up, if enabled, starts now) |
| `402 SPENDING_CAP_REACHED` | The key's monthly cap is reached |

## 5. Follow

```bash
curl -N $API/scans/scn_8a…/events -H "$AUTH"      # live, as Server-Sent Events
curl $API/scans/scn_8a… -H "$AUTH"                 # or one look
```

`status` moves through `queued`, `processing` (with `stage`: `ingesting`, `screening`, `observing`, `fusing`, `enriching`, `saving`) to `complete`, or `failed` with `error` and `charge.refunded: true`.

`GET /scans/{id}/events` is a `text/event-stream`: it sends the scan at once as an event named `scan` (the same JSON as `GET /scans/{id}`, without `upload`), then again at every change of status, stage or error, and closes after the final state. A `ping` event every 15 seconds keeps the connection alive; one stream lasts at most 30 minutes, after which you reconnect. Nothing to poll, nothing to miss:

```text
event: scan
id: 1
data: {"object":"scan","id":"scn_8a…","status":"queued",…}

event: scan
id: 2
data: {"object":"scan","id":"scn_8a…","status":"processing","stage":"observing",…}
```

An account holds at most 10 streams open at once, test and live together: the next one answers `429 RATE_LIMIT_EXCEEDED` with `Retry-After: 30` and `max_streams`. Close one, or poll meanwhile; the SDK, the CLI and the MCP server poll for you.

Polling `GET /scans/{id}` every few seconds works too, and so do the `scan.completed` and `scan.failed` [webhooks](webhooks.md) for servers that must not hold a connection.

**Screening.** Before the analysis, every frame is checked once: is it usable, does it show a place, and which key locations does it show. Blurred, dark or covered frames are left out, and the sharpest frame of each part of the video is the one analysed. Footage with no usable frame at all fails with `FOOTAGE_UNUSABLE` and is refunded. What the frames showed becomes `coverage.checklist` in the document. To check frames while filming, before a scan, see [Guided capture](../guides/guided-capture.md).

Then read the space: `GET /spaces/spc_3f…` returns its [Space Document](space-document.md).

## Cancel

`DELETE /scans/{id}` cancels a scan still `awaiting_upload` (`204`). Nothing is charged and its uploads are deleted.

## With the SDK

```ts
import { SpaceContext } from '@spacecontext/sdk';

const sc = new SpaceContext();
const { spaceId, document } = await sc.scan('./flat.mp4', {
  name: 'Seaside flat',
  type: 'apartment',
  onProgress: (p) => console.log(p.type === 'scan' ? p.label : p.type),
});
```

One call creates the space, uploads, starts, follows the event stream and returns the document (`format: 'markdown'` or `'skill'` adds the export). The steps are also available one by one: `spaces.create`, `scans.fromVideo` / `scans.fromFrames`, `scans.events` / `scans.wait`.
