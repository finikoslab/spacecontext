---
title: 'Security and privacy'
description: 'How Space Context protects sensitive values, keeps agents safe from text in videos, stores data and deletes it.'
---

# Security and privacy

## Sensitive values

Videos often show or mention things an assistant should not repeat: the Wi-Fi password, door and alarm codes, where the spare keys are, phone numbers.

- The deep pass marks such facts as **sensitive**; a rule-based second net also catches passwords and codes announced in text, card numbers, IBANs, emails and phone numbers that it missed.
- Keys without the `spaces:sensitive` scope read the **redacted** document: those values are removed from every field, frames that show them have no URL, and the transcript and the owner's own answers are not available. Search results never contain them, whatever the key.
- A space scanned with the app is readable by such a key only after it has been screened.
- MCP connections never get sensitive values unless you tick the box when you connect.

## Text that addresses an AI

A sign, a sticker or a sentence said on camera can try to give orders to the agent that will read the space ("ignore your previous instructions and…"). Space Context recognises such text (in English and Italian, and attempts to override instructions also in Spanish, French and German), withholds it from documents, skills, search, answers and the models it uses, and notes it in `coverage.warnings`. Everything a space contains is presented to agents as data, never as instructions. This is a safety net, not a guarantee: agents should still treat content from the physical world as untrusted.

## Keys and sessions

- API keys and console sessions are stored hashed; a key is shown once.
- Keys cannot manage keys, billing or webhooks; console sessions cannot be used as keys.
- Each MCP connection has its own key, read-only unless you tick "let it scan spaces" when you connect; revocable from the console.
- Signing in from the terminal (`spacecontext login`) uses a code you type in the console; the code never travels in a link, and the key reaches the terminal without passing through the browser. Approve only a code shown in your own terminal.
- Every sign-in, key, webhook change, payment, refund and deletion is recorded in the account's **audit log** (console → Security, `GET /v1/console/audit-log`), with who did it: you in the console, an API key, Stripe, or Space Context itself. Secrets are never written there. Entries are kept 400 days and erased with the account.

## Where data lives

- Videos, frames and documents are stored on Cloudflare (R2 in the EU jurisdiction, D1).
- Source videos are deleted as soon as their frames are extracted; frames are kept as evidence and served through short-lived signed links.
- Frames, audio and text are processed by AI providers (OpenAI for vision and language, Cloudflare Workers AI for transcription and search) as described in the [privacy policy](https://spacecontext.app/privacy/).
- Card payments are handled by Stripe; card details never reach Space Context.

## Webhooks

Webhook requests are signed (HMAC-SHA256 over the timestamp and the body), sent only to public HTTPS hosts on port 443, never to IP addresses or private names, and never redirected. See [Webhooks](api/webhooks.md).

## Deleting data

- `DELETE /v1/spaces/{id}` deletes an API space with its scans, files and search entries.
- Deleting your account (from the iPhone app or by asking support) deletes every API key, space, scan, file, webhook, search entry and session. A remaining balance is not refunded automatically: contact support before deleting an account with funds.

## Reporting a vulnerability

Write to [support@finikos.it](mailto:support@finikos.it) with "Security" in the subject. Please do not test against other people's data.
