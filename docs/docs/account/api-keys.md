---
title: 'API keys'
description: 'Test and live keys, scopes, the card on file for live keys that can scan, monthly spending caps and revocation.'
---

# API keys

Every call to the API, the CLI and the SDK uses an **API key**, sent as a bearer token:

```http
Authorization: Bearer sc_live_…
```

Create keys in the [console](https://spacecontext.app/developers/console/) under **API keys**. The key is shown **once**: we store only its hash. If you lose it, revoke it and create another.

![Creating a key in the console: name, Test or Live mode, the four scopes, an optional monthly spending cap](/docs/console/keys.jpg)

## Test and live

| | `sc_test_…` | `sc_live_…` |
| --- | --- | --- |
| Sees | The demo space `spc_demo` and spaces created with test keys | Your real spaces |
| Scans | Free, complete at once, always return the demo content | Real analysis; first one free, then paid from your balance |
| Models | None are called | Vision and language models |
| Webhooks | Sent to endpoints in test mode | Sent to endpoints in live mode |
| Card on file | Never needed | Needed for a key with `scans:write` |

Use test keys for development and CI; switch to a live key when you go to production. Test and live data never mix.

## Scopes

| Scope | Allows | Default |
| --- | --- | --- |
| `spaces:read` | `GET /spaces`, `GET /spaces/{id}`, search, ask, skills, comparisons | ✓ |
| `scans:read` | `GET /scans/{id}`, the event stream, `GET /wallet` | ✓ |
| `scans:write` | Creating spaces and scans, uploading, starting, cancelling, deleting spaces, frame checks | ✓ |
| `spaces:sensitive` | Wi-Fi passwords, door and alarm codes, the transcript, the owner's own answers, past scans of app spaces | — |

A key without `spaces:sensitive` reads the **redacted** document. For spaces scanned with the app, it reads them only once they have been screened; see [Security and privacy](../security-and-privacy.md). A request that needs a missing scope answers `403 INSUFFICIENT_SCOPE`.

Give an agent the narrowest key that does the job: `spaces:read` alone for an assistant that only answers questions.

## Live keys that can scan need a card

A live key with `scans:write` (one of the default scopes) can be created only once your account has a **card on file**: add one in the console under **Billing → Add a card**. Stripe saves it and nothing is charged; your first live scan stays free, and scans are still paid from your balance. See [Billing](billing.md#add-a-card).

Without a card, creating such a key answers `402 PAYMENT_METHOD_REQUIRED`, whether you create it in the console, approve it for `spacecontext login` or allow scanning when you connect an assistant. Test keys and live keys without `scans:write` (read-only) never need a card. Removing the card later does not revoke the keys you already have.

## Monthly spending cap

A live key can have a **monthly cap** in US dollars. Scans that would take the key's spending for the calendar month over the cap are refused with `402 SPENDING_CAP_REACHED`; other keys are not affected. The cap counts what the key spends on scans, not your whole balance.

## Revoking

**Revoke** in the console takes effect at once: the next call with the key answers `401 INVALID_TOKEN`.

Keys created by the [MCP connector](../mcp/connect.md) carry the name of the assistant and an **MCP** badge; they have `scans:write` only if you allowed scanning when you connected (which needs a card on file). Revoking one disconnects that assistant: it asks you to sign in again on its next request. Connecting the same assistant again replaces its previous key automatically. Keys created by `spacecontext login` are named `CLI · …` after the terminal that asked.

## Limits

Up to 20 active keys per account.
