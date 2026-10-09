---
title: 'API overview'
description: 'Base URL, authentication, errors, pagination, idempotency and rate limits of the Space Context API.'
---

# API overview

```text
https://api.spacecontext.app/v1
```

A JSON API over HTTPS. Field names are `snake_case`, timestamps ISO 8601 in UTC, money in US cents. The contract is the [OpenAPI document](https://api.spacecontext.app/v1/openapi.json), browsable in the [API reference](/api-reference); it lists exactly what you call with a key (the console's own endpoints are not in it). `GET /v1` answers a short descriptor with the links to the contract, the docs, `llms.txt` and the MCP server.

## Authentication

Send an [API key](../account/api-keys.md) as a bearer token:

```bash
curl https://api.spacecontext.app/v1/me \
  -H "Authorization: Bearer $SPACECONTEXT_API_KEY"
```

```json
{
  "user": { "id": "…", "email": "you@example.com", "is_pro": false },
  "key": { "id": "key_…", "mode": "test", "scopes": ["spaces:read", "scans:read", "scans:write"] }
}
```

The console endpoints (`/auth/*`, `/keys`, `/billing`, `/webhook-endpoints`) take a console session instead and are meant for the [console](../account/console-and-login.md).

## Errors

Every error has the same envelope, with a stable `code` to branch on and a `request_id` to quote to support. Some errors add fields:

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "The wallet does not cover this scan",
    "request_id": "8f0c…",
    "balance_cents": 60,
    "price_cents": 100
  }
}
```

See [all error codes](errors.md).

## Pagination

Lists that can grow take `limit` and `cursor` and answer `next_cursor` (`null` on the last page):

```bash
curl "https://api.spacecontext.app/v1/spaces?limit=20&cursor=$NEXT" -H "Authorization: Bearer $KEY"
```

## Idempotency

`POST /spaces/{id}/scans` accepts an `Idempotency-Key` header (8 to 64 letters, digits, `-` or `_`). Retrying with the same key returns the scan already created (`200`) instead of creating another (`201`). `POST /scans/{id}/start` is safe to repeat: a second call answers `200` with the scan already started and charges nothing.

## Rate limits

| Limit | Value |
| --- | --- |
| Per key | 120 requests per minute |
| Per IP address | 1 200 requests per minute |
| Search, per account | 20 per minute, 1 000 per day |
| Questions (`ask`), per account | 20 per minute, 200 answered per day |
| Frame checks, per account | 2 000 per day |
| Scans processing at once, per account | 10 (more on request) |

A refused request answers `429 RATE_LIMIT_EXCEEDED` with a `Retry-After` header (seconds), or `retry_after` in the body for daily limits. The SDK and the CLI wait and retry short waits for you. See [Limits](../limits.md).

## Test mode

Requests made with a test key (`sc_test_…`) never touch real data: see [Concepts](../concepts.md#test-and-live-mode). Responses have the same shape in both modes; scans and spaces carry `livemode`.

## Browsers

The API is meant to be called from servers, scripts and agents. Browser calls are accepted only from Space Context's own sites (CORS); keep keys out of web pages.

## Endpoints at a glance

| | |
| --- | --- |
| `GET /me` | The key in use |
| `GET /spaces`, `POST /spaces` | List spaces, create a space |
| `GET /spaces/{id}`, `DELETE /spaces/{id}` | Read a space (Space Document), delete an API space |
| `GET /spaces/{id}/scans`, `POST /spaces/{id}/scans` | Scan history, create a scan |
| `GET /spaces/{id}/scans/{scan_id}` | A past scan as recorded |
| `GET /spaces/{id}/skill`, `GET /spaces/{id}/markdown` | The space as an Agent Skill, or as one Markdown page |
| `POST /spaces/{id}/ask` | Ask a question |
| `GET /spaces/{id}/diff` | Compare two scans |
| `GET /search` | Search across spaces |
| `GET /scans/{id}`, `DELETE /scans/{id}` | A scan, cancel a scan |
| `GET /scans/{id}/events` | Follow a scan live (Server-Sent Events) |
| `PUT /scans/{id}/frames/{index}`, `PUT /scans/{id}/video` | Upload |
| `POST /scans/{id}/start` | Start and charge |
| `POST /frames/check` | Is this frame usable, which key locations does it show |
| `GET /wallet` | Balance and free scans |
| `POST /auth/device`, `POST /auth/device/token` | Sign in from a terminal (what `spacecontext login` does) |
| `GET /media/{key}` | An evidence frame (signed URL) |
