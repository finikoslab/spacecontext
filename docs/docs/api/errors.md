---
title: 'Errors'
description: 'Every error code of the Space Context API, with its HTTP status and what to do.'
---

# Errors

Errors share one envelope: `{ "error": { "code", "message", "request_id", … } }`. Branch on `code`, never on `message`. Quote `request_id` when you contact support.

## Requests

| Code | Status | Meaning, and what to do |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | A parameter or field is missing or invalid; the message says which. |
| `MISSING_AUTH_HEADER` | 401 | No `Authorization: Bearer …` header. |
| `INVALID_TOKEN` | 401 | The key does not exist or was revoked. |
| `USER_NOT_FOUND` | 401 | The account of the key was deleted. |
| `INSUFFICIENT_SCOPE` | 403 | The key lacks a scope; `required_scopes` lists it. |
| `PRO_REQUIRED` | 403 | Spaces scanned with the app need Space Context Pro. |
| `NOT_FOUND` | 404 | No such space, scan or record for this key (test and live data are separate). |
| `RATE_LIMIT_EXCEEDED` | 429 | Wait `Retry-After` seconds (or `retry_after` for daily limits). |
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
| `INVALID_CONTENT_TYPE` | 415 | Not a JPEG, PNG or WebP frame, or not an MP4, MOV or M4V video. |
| `FILE_TOO_LARGE` | 413 | Over 2 MB per frame, or over the video size of the upload. |
| `EMPTY_FILE` | 400 | The upload has no bytes. |
| `SCANS_IN_PROGRESS` | 429 | Three scans are already processing; start again when one finishes. |
| `INSUFFICIENT_FUNDS` | 402 | The balance does not cover the scan; `balance_cents` and `price_cents` say by how much. |
| `SPENDING_CAP_REACHED` | 402 | The key's monthly cap is reached. |
| `FRAME_CHECK_UNAVAILABLE` | 503 | `POST /frames/check` cannot run right now; try again shortly. |

A scan that fails after starting carries its reason in `scan.error.code`, and is refunded:

| `scan.error.code` | Meaning |
| --- | --- |
| `VIDEO_UNREADABLE` | The video could not be decoded. |
| `VIDEO_TOO_LONG` | Over 20 minutes. |
| `FOOTAGE_UNUSABLE` | Every frame was too dark, blurred or covered, or showed no place (a drawing, a screen). Refused before the analysis; film again in good light. |
| `ANALYSIS_EMPTY` | No space was recognised in the frames. |
| `AI_ANALYSIS_FAILED`, `AI_OVERLOADED` | The analysis failed; scan again later. |
| `PROCESSING_TIMEOUT` | Processing took more than 2 hours. |
| `UPLOAD_EXPIRED` | Not started within 24 hours (status `cancelled`, never charged). |

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
| `PAYMENTS_UNAVAILABLE` | 503 | Card payments are temporarily unavailable. |
| `PAYMENT_FAILED` | 502 | Stripe could not create the payment page; try again. |
