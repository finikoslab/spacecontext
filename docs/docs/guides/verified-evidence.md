---
title: 'Verified evidence: every record checked on its own photo'
sidebar_label: 'Verified evidence'
description: 'Each item, issue and key location of a Space Document is checked again, by a second model that answers closed questions, on the frames it cites: verified, unconfirmed or not visual.'
---

# Verified evidence: every record checked on its own photo

The analysis that writes a Space Document is generative: it can name an object the photo it cites does not show (a cupboard read as a fridge, an object from the narration placed over a frame of the hall). So after it, every **item**, **issue** and **key location** is checked again, by a second model that cannot write text: a closed question about the record, asked on the frames the record cites, answered with a probability. The same frame always gets the same answer.

## In the document

```json
"verification": { "status": "verified", "probability": 0.97, "frame_id": "frame-12" }
```

| `status` | Meaning | What an agent should do |
| --- | --- | --- |
| `verified` | One of the frames it cites clearly shows it (probability 0.7 or more) | Rely on it; its first evidence frame is the one that shows it best |
| `unconfirmed` | Its frames were checked and none clearly shows it | Say it is uncertain; never state it as fact |
| `not_visual` | Nothing a photo could confirm: it cites no frame (it comes from the narration), or it is a fault or an absence | Say where it comes from when it matters |

- `probability` is the best over its frames (`null` for `not_visual`); `frame_id` is the frame that showed it best, moved first in the record's `evidence`, so the photo shown first is the right one.
- Up to four of the frames a record cites are asked; a frame it does not cite is never asked, and never added to it.
- `verification` is `null` where it was not computed: the base level of a space, documents made before the check existed, or a check that could not run. The check never makes a scan fail.
- It is numbers only, so keys without `spaces:sensitive` see it too; a record withheld from them stays withheld.
- The demo space (`spc_demo`, read with test keys) carries it too, computed on its published frames: at check-in 34 records verified and 4 unconfirmed, at check-out 41 verified, 1 unconfirmed and 2 not visual. A test key shows exactly what a live document looks like.

## What is asked

| Record | Question |
| --- | --- |
| Item | "The image shows a *generic name* (described as "*name*"), even if only partly or in the background." |
| Issue | "The image shows *title* (*category*), even if only partly." Faults and absences (`malfunction`, `missing`) are `not_visual`, never asked. |
| Key location | The definition of its kind used by the [frame check](guided-capture.md) ("The image clearly shows an electrical panel, fuse box…"). |

## How accurate it is

Measured on 2026-10-13 on the real check-out of the demo space (38 items, 4 issues, 36 frames):

- items: 38 of 38 verified on one of the frames they cite, and 0 false confirmations out of 227 room-specific items (toilet, bed, fridge, sofa…) asked on frames of other rooms. Asking "clearly shows *name*" instead verified 33 of 38 (2 of 227 false); asking the generic name alone verified 38 of 38 but confirmed 16 of 227 falsely;
- asking only the first frame a record cites missed 13 of 38: some of those were real citation mistakes of the analysis (a toilet cited on a frame that does not show it), which taking the best of its frames corrects;
- issues: 3 of 4 verified at 0.95–0.96; the fourth, written as a possibility ("Possible shower-frame darkening"), got 0.59 and stays `unconfirmed`, the honest answer;
- key locations: the definitions of the frame check, precision 1.00 at 0.7 except safety equipment (0.89); "connections" (behind an appliance) is not measured yet (measures of 2026-10-06 and 2026-10-13).

## Where it shows

- **API**: `verification` on `items`, `issues` and `key_locations` of every [Space Document](../api/space-document.md); a scan shows `stage: verifying` ("Verifying the evidence" in the SDK, CLI and MCP) for the few seconds it takes.
- **Markdown and Skill**: a "Photo check" line on every record and a summary ("31 of 36 records verified on photo…"); the Skill tells the agent how to read it.
- **Search and ask**: each record's text says its photo check, and `ask` says when an answer rests on an unconfirmed record.
- **SDK**: `summarizeVerification(document)` counts verified, unconfirmed, not visual and unchecked records.
- **CLI**: `spacecontext space` and `spacecontext scan` print "Evidence: 31 of 36 records verified on their photo · 3 unconfirmed · 2 not visual (from the narration, or a fault)", and mark unconfirmed issues and key locations ("(unconfirmed on its photo)").
- **MCP**: `get_space` gives each record's `verification` and an `evidence_check` count (`verified`, `unconfirmed`, `not_visual`, and `not_checked` when some records were not checked); the server tells the assistant to prefer verified records and hedge unconfirmed ones, and `ask_space`'s answer is asked to hedge on them.
