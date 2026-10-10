---
title: 'Limits'
description: 'Sizes, rates and quotas of the Space Context API.'
---

# Limits

## Uploads

| | Limit |
| --- | --- |
| Video | MP4, MOV, M4V; up to 100 MB and 10 minutes |
| Video through the API (when no direct upload link is offered) | 95 MB |
| Photos per scan | 120, JPEG, PNG or WebP, 2 MB each |
| Transcript | 600 segments of up to 2 000 characters |
| Direct upload link | Valid 1 hour |
| Time to start a scan after creating it | 24 hours, then it is cancelled |

## Rates

| | Limit |
| --- | --- |
| Requests per key | 120 per minute |
| Requests per IP address | 1 200 per minute |
| Search | 20 per minute and 1 000 per day per account |
| Questions (`ask`) | 20 per minute and 200 answered per day per account |
| Frame checks (`POST /frames/check`) | 2 000 per day per account (free) |
| Scans processing at once | 10 per account; more on request |
| New spaces (`POST /spaces`) | 200 per day per account, in each mode (test keys included) |
| New scans (`POST /spaces/{id}/scans`) | 500 per day per account, in each mode (test keys included) |
| Event streams (`GET /scans/{id}/events`) open at once | 10 per account, test and live together |
| Event streams opened | 20 per minute per account |
| Event stream length | 30 minutes per connection; reconnect to keep following |
| Evidence frames | Signed links expire; read the document again for fresh ones |

Exceeding a rate answers `429 RATE_LIMIT_EXCEEDED` with the seconds to wait in `retry_after`, and in the `Retry-After` header too for per-minute limits, new spaces and scans, and event streams:

- **Daily limits** reset at midnight UTC. New spaces and new scans answer with the time left until then and their allowance in `daily_limit`; a retry with the same `Idempotency-Key` (scans) or `external_id` (spaces) returns what was already created and does not count again. Search, questions and frame checks answer `retry_after: 3600`.
- **Event streams**: with 10 open, the next one answers `Retry-After: 30` and `max_streams: 10`. Close one, or poll `GET /scans/{id}` meanwhile; the SDK, the CLI and the MCP server do this for you.

## Account

| | Limit |
| --- | --- |
| Active API keys | 20 |
| Live keys with `scans:write` | Only with a card on file ([Billing](account/billing.md#add-a-card)) |
| Live scans | Only with a card on file or a top-up already paid |
| Webhook endpoints | 10 per mode (test and live) |
| Top-up | $10 to $500 per payment |
| Automatic top-up | At most 3 per day, 10 minutes apart |
| Console session | 30 days, in one browser tab |
| Email sign-in code | Valid 10 minutes |
| Terminal sign-in code (`spacecontext login`) | Valid 10 minutes; polled at most every 5 seconds |

## Results

| | Limit |
| --- | --- |
| Search results | 25 per request |
| Question length | 500 characters |
| Search query | 300 characters |
| Space list page | 50 spaces |

Need more? Write to [support](https://spacecontext.app/support/).
