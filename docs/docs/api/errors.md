---
title: 'API errors'
sidebar_label: 'Errors'
description: 'Every error code of the Space Context API, its HTTP status and what to do: requests, scans, uploads, failed scans, terminal sign-in, x402 and the console.'
---

# API errors

Errors share one envelope: `{ "error": { "code", "message", "request_id", … } }`. Branch on `code`, never on `message`. Quote `request_id` when you contact support.

## Requests

| Code | Status | Meaning, and what to do |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | A parameter or field is missing or invalid; the message says which. |
| `MISSING_AUTH_HEADER` | 401 | No `Authorization: Bearer …` header. |
| `INVALID_TOKEN` | 401 | The key does not exist or was revoked. |
| `USER_NOT_FOUND` | 401 | The account of the key was deleted. |
| `INSUFFICIENT_SCOPE` | 403 | The key lacks a scope; `required_scopes` lists it. |
| `PRO_REQUIRED` | 403 | Spaces scanned with the app need Space Context Pro (only when the service turns this rule on; today every account reads its app spaces). |
| `NOT_FOUND` | 404 | No such space, scan or record for this key (test and live data are separate). |
| `RATE_LIMIT_EXCEEDED` | 429 | Wait `retry_after` seconds (also in `Retry-After`, except for the daily limits of search, questions and frame checks). `daily_limit` comes with the daily allowance of new spaces or scans; `max_streams` when the account already holds its open event streams (poll `GET /scans/{id}` instead). On a live `POST /scans/{id}/start` it also means five scans of the account already failed today because of their footage (refunded): live scans resume at midnight UTC; check frames first with `POST /frames/check`. See [Limits](../limits.md). |
| `INTERNAL_ERROR` | 500 | Retry later; if it persists, contact support with the request id. |

## Spaces, search and questions

| Code | Status | Meaning |
| --- | --- | --- |
| `ENRICHMENT_PENDING` | 409 | A space scanned with the app is being screened; retry in a minute, or use a key with `spaces:sensitive`. |
| `SEARCH_UNAVAILABLE` | 503 | Search is temporarily unavailable. |

When the deep pass of a space scanned with the app could not finish, the document stays at the base level with `enrichment.status: "failed"`; reading it again retries (a few times). `STALE_ANALYSIS` in that case means the space was recorded again in the meantime.

## Scans and uploads

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_STATE` | 409 | The scan is not in a state for this (for example uploading to a started scan, deleting a space with a scan in progress). |
| `UPLOAD_INCOMPLETE` | 409 | Start refused: frames missing, or the video missing or of another size than declared. |
| `INVALID_CONTENT_TYPE` | 400 | On create: the video's `content_type` is not one the API reads (`video/mp4`, `video/quicktime`, `video/x-m4v`, `video/3gpp`, `video/webm`, `video/x-matroska`, `video/matroska`). Nothing is created or charged; convert the video to MP4 first ([Scans](scans.md#2-declare-the-scan)). |
| `INVALID_CONTENT_TYPE` | 415 | On an upload: a frame (or `POST /frames/check`) that is not a JPEG, PNG or WebP image, or a video sent with a `Content-Type` other than the declared one. |
| `FILE_TOO_LARGE` | 413 | Over 2 MB per frame, over the declared size of the video, or a video over 95 MB sent through the API instead of the direct upload link (`max_bytes`). |
| `EMPTY_FILE` | 400 | The upload has no bytes. |
| `SCANS_IN_PROGRESS` | 429 | On start: ten scans of the account are already processing; start again when one finishes. On create: twenty scans are waiting for their upload (`max_open_scans`); upload and start them, or cancel some with `DELETE /scans/{id}`. |
| `INSUFFICIENT_FUNDS` | 402 | The balance does not cover the scan; `balance_cents` and `price_cents` say by how much. |
| `SPENDING_CAP_REACHED` | 402 | The key's monthly cap is reached. |
| `FRAME_CHECK_UNAVAILABLE` | 503 | `POST /frames/check` cannot run right now; try again shortly. |

A scan that fails after starting carries its reason in `scan.error.code`, and is refunded:

| `scan.error.code` | Meaning |
| --- | --- |
| `VIDEO_UNREADABLE` | The video could not be decoded, or its length could not be read: a WebM recorded in a browser (`MediaRecorder`) states none; remux it first (`ffmpeg -i in.webm -c copy out.webm`). |
| `VIDEO_TOO_LONG` | Over 10 minutes. |
| `FOOTAGE_UNUSABLE` | Every frame was too dark, blurred or covered, or showed no place (a drawing, a screen). Refused before the analysis; film again in good light. |
| `ANALYSIS_EMPTY` | No space was recognised in the frames. |
| `AI_ANALYSIS_FAILED`, `AI_OVERLOADED` | The analysis failed; scan again later. |
| `PROCESSING_TIMEOUT` | Processing took more than 2 hours. |
| `UPLOAD_EXPIRED` | Not started within 24 hours (status `cancelled`, never charged). |

## Terminal sign-in (`POST /auth/device/token`)

| Code | Status | Meaning |
| --- | --- | --- |
| `AUTHORIZATION_PENDING` | 400 | Not decided yet in the console; poll again after `interval` seconds. |
| `SLOW_DOWN` | 400 | Polled faster than `interval`; wait longer. |
| `DEVICE_CODE_EXPIRED` | 400 | The code lived its ten minutes; start again. |
| `DEVICE_CODE_INVALID` | 400 | Unknown device code, or the key was already handed out. |
| `ACCESS_DENIED` | 403 | Denied in the console. |

## Agents that pay (`POST /agent/credits`)

| Code | Status | Meaning |
| --- | --- | --- |
| `PAYMENT_REQUIRED` | 402 | No payment yet: the options are in the `PAYMENT-REQUIRED` header (and in `error.payment_required`). |
| `PAYMENT_INVALID` | 400 | `PAYMENT-SIGNATURE` is malformed or does not match what was asked (amount, network, asset, recipient, fee payer, signature); `reason` says which. |
| `PAYMENT_FAILED` | 402 | The facilitator refused or could not settle the payment (for example not enough USDC); nothing was charged. |
| `PAYMENT_FAILED` | 502 | The settlement could not be confirmed: it may have gone through. Write to support with `nonce` (Base) or `signature` (Solana). |
| `AGENT_KEY_REQUIRED` | 403 | `rotate_key`, or the first key of the other mode, without one of the account's current keys; nothing was charged. |
| `PAYMENTS_UNAVAILABLE` | 503 | The chosen network cannot be served right now; try later or pay on the other one. |

Details and examples: [Agents that pay (x402)](../account/agent-payments.md#errors).

## Evidence frames

| Code | Status | Meaning |
| --- | --- | --- |
| `SIGNED_URL_INVALID` | 401 | Not a valid evidence link. |
| `SIGNED_URL_EXPIRED` | 401 | The link expired; read the document again for a fresh one. |
| `MEDIA_NOT_FOUND` | 404 | The frame no longer exists. |

## Console

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_CREDENTIALS` | 401 | Wrong or expired sign-in code. |
| `SIGN_IN_UNAVAILABLE` | 503 | That sign-in provider is not configured on this deployment. |
| `PAYMENT_METHOD_REQUIRED` | 402 | Starting a live scan (`POST /scans/{id}/start`) or creating a live key with `scans:write` (`POST /keys`, or approving a terminal sign-in) needs a card on file (or a top-up already paid): add one under **Billing → Add a card** (nothing is charged), or create a test key or a key without `scans:write`. Connecting an assistant with scanning allowed shows the same choice. |
| `PAYMENTS_UNAVAILABLE` | 503 | Card payments are temporarily unavailable. |
| `PAYMENT_FAILED` | 502 | Stripe could not create the payment page; try again. |
