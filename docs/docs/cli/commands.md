---
title: 'Commands'
description: 'Every command of the spacecontext CLI.'
---

# CLI commands

All commands accept `--json`, `--api-key <key>` and `--base-url <url>`. Ids are the ones the API uses: spaces `app_…` (scanned with the app) or `spc_…` (created with the API or the CLI), scans `scn_…`.

## Account

| Command | |
| --- | --- |
| `spacecontext login [--key sc_…]` | Check a key and save it. Without `--key`, asks for it without echo. |
| `spacecontext logout` | Forget the saved key. |
| `spacecontext whoami` | The account, mode (test or live) and scopes of the key. |
| `spacecontext wallet` | Balance, free scans left and price per scan. Needs `scans:read`. |

## Spaces

```bash
spacecontext spaces [--source app|api]
spacecontext space <space-id> [--transcript]
spacecontext delete-space <space-id>
```

`spaces` lists every space the key can read. `space` prints a summary (areas and their items, issues, coverage notes); add `--json` for the whole [Space Document](../api/space-document.md). `--transcript` adds what was said in the video and needs `spaces:sensitive`. `delete-space` removes a space created with the API, with its scans and files; spaces scanned with the app are deleted in the app.

## Search and ask

```bash
spacecontext search <question…> [--space <space-id>] [--limit <1-25>]
spacecontext ask <space-id> <question…>
```

`search` looks across every space, in any language. `ask` answers from one space, with its sources:

```text
$ spacecontext ask spc_demo "where is the electrical panel?"
In the utility closet, on the wall behind the sliding door, at eye level.

Sources:
  - Electrical panel (Utility closet)
```

## Skills and comparisons

```bash
spacecontext skill <space-id> [--out <dir>] [--transcript]
spacecontext scans <space-id>
spacecontext diff <space-id> --from <scan-id> [--to <scan-id>]
```

`skill` writes the space as an Agent Skill folder (default: a folder named after the skill in the current directory). `scans` lists the scan history; `diff` compares two of them (`--to` defaults to the current scan).

## Scans

```bash
spacecontext scan <video-file | frames-dir> (--space <space-id> | --name <name>) [--type <type>] [--language en|it] [--no-wait]
spacecontext scan-status <scan-id>
spacecontext cancel <scan-id>
```

`scan` uploads a video (`.mp4`, `.mov`, `.m4v`, up to 500 MB) or a folder of photos (`.jpg`, `.png`, `.webp`, up to 120, 2 MB each, taken in name order), starts the analysis and waits for it, printing each stage. With `--name` it first creates a space (`--type` is one of `apartment`, `house`, `office`, `warehouse`, `vehicle`, `boat`, `camper`, `shop`, `garage`, `appliance`, `other`). With `--no-wait` it returns once the scan has started.

Sizes are checked before anything is created. If an upload fails, the scan is cancelled (nothing is charged); a space created with `--name` stays, and the CLI tells you its id.

`cancel` cancels a scan that has not started. See [Scanning](scanning.md) for recording tips and costs.
