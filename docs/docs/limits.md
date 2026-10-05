---
title: 'Limits'
description: 'Sizes, rates and quotas of the Space Context API.'
---

# Limits

## Uploads

| | Limit |
| --- | --- |
| Video | MP4, MOV, M4V; up to 500 MB and 20 minutes |
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
| Scans processing at once | 3 per account |
| Evidence frames | Signed links expire; read the document again for fresh ones |

Exceeding a rate answers `429 RATE_LIMIT_EXCEEDED` with `Retry-After`.

## Account

| | Limit |
| --- | --- |
| Active API keys | 20 |
| Webhook endpoints | 10 |
| Top-up | $5 to $500 per payment |
| Automatic top-up | At most 3 per day, 10 minutes apart |
| Console session | 30 days, in one browser tab |
| Sign-in code | Valid 10 minutes |

## Results

| | Limit |
| --- | --- |
| Search results | 25 per request |
| Question length | 500 characters |
| Search query | 300 characters |
| Space list page | 50 spaces |

Need more? Write to [support](https://spacecontext.finikos.it/support).
