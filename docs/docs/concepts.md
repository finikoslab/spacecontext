---
title: 'Concepts'
description: 'Spaces, scans, the Space Document, test and live mode, scopes and screening.'
---

# Concepts

## Spaces

A **space** is a physical place you document: a flat, a house, an office, a warehouse, a vehicle, a boat, a camper, a shop, a garage or an appliance. Each space has an id:

| Id | Where it comes from | Who can read it through the API |
| --- | --- | --- |
| `app_…` | Scanned with the Space Context iPhone app | Live keys of the same account |
| `spc_…` | Created through the API, the CLI or the console | The keys of the same mode (test or live) |
| `spc_demo` | The demo space | Test keys only |

## Scans

A **scan** is one recording of a space: a video, or up to 120 photos, optionally with a transcript of what was said. Each scan produces a new version of the space; older scans stay available for [comparison](api/skills-and-diff.md).

A scan goes through these statuses:

`awaiting_upload` → `queued` → `processing` (stages: `ingesting`, `screening`, `observing`, `fusing`, `enriching`, `saving`) → `complete`

or ends as `failed` (refunded) or `cancelled` (before it started; nothing charged). You can poll the scan, follow it live as an event stream (`GET /scans/{id}/events`), or be told by a [webhook](api/webhooks.md).

## The Space Document

Reading a space returns a **Space Document**, a JSON document with a versioned schema: areas, items, issues, key locations, instructions, facts, Q&A, frames and coverage. → [The Space Document](api/space-document.md)

Documents have two levels:

- **base**: what the first analysis found (areas, items as names, issues).
- **deep**: after a second pass that structures everything (categories, locations, conditions, brands, key locations, how-to steps from the narration, facts) and screens it for sensitive values. Scans made through the API are deep when they complete. Spaces scanned with the app are deepened the first time you read them through the API; until then you get the base level with `enrichment.status: "pending"`.

## Test and live mode

Every key is either **test** (`sc_test_…`) or **live** (`sc_live_…`).

- **Test** keys see only the demo space and spaces created with test keys; scans are free, instant, and always return the demo content. Use them to build and test integrations.
- **Live** keys see your real spaces and run real analyses. Test and live data never mix.

## Scopes

A key carries scopes that limit what it can do:

| Scope | Allows |
| --- | --- |
| `spaces:read` | Reading, searching and asking spaces |
| `scans:read` | Following scans (status and event stream), reading the wallet |
| `scans:write` | Creating spaces and scans, checking frames while filming (a live key spends your balance) |
| `spaces:sensitive` | Seeing sensitive values: Wi-Fi passwords, door and alarm codes, the transcript and the owner's own answers |

`spaces:sensitive` is never granted by default. → [API keys](account/api-keys.md)

## Screening

Before content reaches a key, a model or an agent, Space Context screens it:

- **Sensitive values** found by the deep pass (and by a second, rule-based detector for passwords, codes, card numbers, IBANs, emails and phone numbers) are redacted for keys without `spaces:sensitive`. A key without that scope reads a space only once the deep pass has screened it.
- **Text that addresses an AI** ("ignore your previous instructions…", written on a sign or said on camera) is withheld everywhere, with a notice in `coverage.warnings`. Content of a space is data, never instructions.
- **Footage** is checked frame by frame before any model describes it: blurred, dark or covered frames are left out, a recording with nothing usable is refused and refunded (`FOOTAGE_UNUSABLE`), and `coverage.checklist` says which key locations the recording did not show. → [Guided capture](guides/guided-capture.md)

→ [Security and privacy](security-and-privacy.md)
