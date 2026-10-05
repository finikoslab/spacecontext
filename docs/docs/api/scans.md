---
title: 'Scans'
description: 'Create a space, declare a scan, upload a video or photos, start it and follow it.'
---

# Scans

A scan goes through four calls: **create**, **upload**, **start**, then **follow** it (polling or [webhooks](webhooks.md)).

```bash
API=https://api.spacecontext.finikos.it/v1
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

## 2. Declare the scan

For a video, declare its type and exact size:

```bash
curl -X POST $API/spaces/spc_3f…/scans -H "$AUTH" -H "Content-Type: application/json" \
  -H "Idempotency-Key: flat-2026-10-05" \
  -d '{"input": {"kind": "video", "language": "en", "video": {"content_type": "video/mp4", "content_length": 48211983}}}'
```

For photos, list them in order, with their time in milliseconds when you know it:

```json
{ "input": { "kind": "frames", "language": "it", "frames": [{ "timestamp_ms": 0 }, { "timestamp_ms": 2000 }] } }
```

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

**Video**: `PUT` the bytes to `upload.url` with `upload.headers`. When the URL points to storage (a signed link, valid for an hour), do not send your API key. When it points to the API (`…/v1/scans/{id}/video`, up to 95 MB), send the `Authorization` header as usual.

```bash
curl -X PUT "$UPLOAD_URL" -H "Content-Type: video/mp4" --data-binary @flat.mp4
```

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
| `429 SCANS_IN_PROGRESS` | Three scans are already processing; start again when one finishes |
| `402 INSUFFICIENT_FUNDS` | Add funds (automatic top-up, if enabled, starts now) |
| `402 SPENDING_CAP_REACHED` | The key's monthly cap is reached |

## 5. Follow

```bash
curl $API/scans/scn_8a… -H "$AUTH"
```

`status` moves through `queued`, `processing` (with `stage`: `ingesting`, `observing`, `fusing`, `enriching`, `saving`) to `complete`, or `failed` with `error` and `charge.refunded: true`. Poll every few seconds, or subscribe to `scan.completed` and `scan.failed`.

Then read the space: `GET /spaces/spc_3f…` returns its [Space Document](space-document.md).

## Cancel

`DELETE /scans/{id}` cancels a scan still `awaiting_upload` (`204`). Nothing is charged and its uploads are deleted.

## With the SDK

```ts
import { SpaceContext } from '@spacecontext/sdk';
import { openAsBlob } from 'node:fs';

const sc = new SpaceContext();
const space = await sc.spaces.create({ name: 'Seaside flat', space_type: 'apartment' });
const scan = await sc.scans.fromVideo(space.id, { data: await openAsBlob('flat.mp4'), contentType: 'video/mp4' });
const done = await sc.scans.wait(scan.id);
```
