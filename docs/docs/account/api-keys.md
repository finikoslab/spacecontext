---
title: 'API keys'
description: 'Test and live keys, scopes, monthly spending caps and revocation.'
---

# API keys

Every call to the API, the CLI and the SDK uses an **API key**, sent as a bearer token:

```http
Authorization: Bearer sc_live_…
```

Create keys in the [console](https://spacecontext.finikos.it/developers/console) under **API keys**. The key is shown **once**: we store only its hash. If you lose it, revoke it and create another.

## Test and live

| | `sc_test_…` | `sc_live_…` |
| --- | --- | --- |
| Sees | The demo space `spc_demo` and spaces created with test keys | Your real spaces |
| Scans | Free, complete at once, always return the demo content | Real analysis; first one free, then paid from your balance |
| Models | None are called | Vision and language models |
| Webhooks | Sent to endpoints in test mode | Sent to endpoints in live mode |

Use test keys for development and CI; switch to a live key when you go to production. Test and live data never mix.

## Scopes

| Scope | Allows | Default |
| --- | --- | --- |
| `spaces:read` | `GET /spaces`, `GET /spaces/{id}`, search, ask, skills, comparisons | ✓ |
| `scans:read` | `GET /scans/{id}`, `GET /wallet` | ✓ |
| `scans:write` | Creating spaces and scans, uploading, starting, cancelling, deleting spaces | ✓ |
| `spaces:sensitive` | Wi-Fi passwords, door and alarm codes, the transcript, the owner's own answers, past scans of app spaces | — |

A key without `spaces:sensitive` reads the **redacted** document. For spaces scanned with the app, it reads them only once they have been screened; see [Security and privacy](../security-and-privacy.md). A request that needs a missing scope answers `403 INSUFFICIENT_SCOPE`.

Give an agent the narrowest key that does the job: `spaces:read` alone for an assistant that only answers questions.

## Monthly spending cap

A live key can have a **monthly cap** in US dollars. Scans that would take the key's spending for the calendar month over the cap are refused with `402 SPENDING_CAP_REACHED`; other keys are not affected. The cap counts what the key spends on scans, not your whole balance.

## Revoking

**Revoke** in the console takes effect at once: the next call with the key answers `401 INVALID_TOKEN`.

Keys created by the [MCP connector](../mcp/connect.md) carry the name of the assistant and an **MCP** badge. Revoking one disconnects that assistant: it asks you to sign in again on its next request. Connecting the same assistant again replaces its previous key automatically.

## Limits

Up to 20 active keys per account.
