---
title: 'Webhook events and signatures'
sidebar_label: 'Webhooks'
description: 'Signed webhooks when a scan completes or fails or an automatic top-up is declined: the payload, HMAC-SHA256 checks in Node.js and Python, and retries.'
---

# Webhook events and signatures

Instead of polling, let Space Context call you. Add an endpoint in the [console](https://spacecontext.app/developers/console/) under **Webhooks**: an HTTPS URL, the events, and the mode (test events come from test keys, live events from live keys). The **signing secret** (`whsec_…`) is shown once.

## Events

| Event | When | `data` |
| --- | --- | --- |
| `scan.completed` | A scan finished | `{ "scan": Scan }` |
| `scan.failed` | A scan failed and was refunded | `{ "scan": Scan }` with `error` and `charge.refunded: true` |
| `wallet.auto_recharge_failed` | The bank declined an automatic top-up; it was turned off | `{ "reason", "amount_cents", "auto_recharge_enabled": false }` |

## Request

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: SpaceContext-Webhooks/1
SpaceContext-Event-Id: evt_scn_8a…_completed
SpaceContext-Signature: t=1791200000,v1=5f2c…

{
  "id": "evt_scn_8a…_completed",
  "object": "event",
  "type": "scan.completed",
  "livemode": true,
  "created_at": "2026-10-05T10:15:03.000Z",
  "data": { "scan": { "object": "scan", "id": "scn_8a…", "space_id": "spc_3f…", "status": "complete", … } }
}
```

Answer with any `2xx` within 10 seconds. Do the work after answering.

## Verify the signature

`SpaceContext-Signature` is `t=<unix seconds>,v1=<hex HMAC-SHA256>` of `"<t>.<raw body>"`, keyed with the whole signing secret (including `whsec_`). Verify it on the **raw** body, compare in constant time, and reject old timestamps:

```ts title="Node.js"
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySpaceContext(rawBody: string, header: string, secret: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(parts.v1 ?? '', 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

```python title="Python"
import hashlib, hmac, time

def verify_spacecontext(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(part.split("=", 1) for part in header.split(","))
    try:
        timestamp = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - timestamp) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

## Delivery

- **At least once.** An event can arrive more than once: use its `id` (also in `SpaceContext-Event-Id`) to ignore repeats. Ids are stable for the same fact: a scan completes once, so `evt_<scan>_completed` is sent once per endpoint even if the pipeline repeats a step.
- **Retries.** A failed delivery (no `2xx`, timeout, network error) is retried up to 8 times, waiting 30 seconds, then doubling up to an hour between attempts.
- **Auto-disable.** After 20 failed deliveries in a row the endpoint is turned off; turn it back on in the console.
- **Order** is not guaranteed.
- **Never redirected.** A `3xx` is a failure.

## Allowed URLs

`https` on port 443, with a public hostname: no IP addresses, no `localhost` or private names, no Space Context or Cloudflare hosts. The URL is checked when you add the endpoint and before every delivery. For local development, use a tunnel with a public HTTPS name.

## In the console

**Send test event** delivers a sample event (`data: { "test": true }`) and shows the answer. **Deliveries** lists recent attempts with their status and the last answer. Up to 10 endpoints per mode (10 for test events, 10 for live).

![Webhooks in the console: add an HTTPS endpoint for test or live events, choose scan.completed, scan.failed and wallet.auto_recharge_failed, and see your endpoints](/docs/console/webhooks.jpg)
