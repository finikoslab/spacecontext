---
title: 'Commands'
description: 'Every command of the spacecontext CLI.'
---

# CLI commands

All commands accept `--json`, `--api-key <key>` and `--base-url <url>`. Ids are the ones the API uses: spaces `app_…` (scanned with the app) or `spc_…` (created with the API or the CLI), scans `scn_…`.

## Account

| Command | |
| --- | --- |
| `spacecontext login [--test] [--no-browser]` | Sign in from the terminal: a code to approve in the console, the key comes back here. `--key sc_…` saves a key you already have. |
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

`search` looks across every space, in any language. `ask` answers from one space, with its sources, in English or Italian whatever language the scan was described in (with a test key, from the demo space, without a model):

```text
$ spacecontext ask spc_demo "where is the fuse box?"
The fuse box is in the Open-plan Living, Dining and Kitchen, in the hallway cupboard behind the coats.

Sources:
  - Fuse box (Open-plan Living, Dining and Kitchen)

$ spacecontext ask spc_demo "dov'è il frigorifero?"
Dark refrigerator is in the Open-plan Living, Dining and Kitchen, at the left side of the kitchen work area. Condition: good.

Sources:
  - Dark refrigerator (Open-plan Living, Dining and Kitchen)
```

## Skills and comparisons

```bash
spacecontext skill <space-id> [--out <dir>] [--transcript]
spacecontext markdown <space-id> [--out <file>] [--transcript]
spacecontext scans <space-id>
spacecontext diff <space-id> --from <scan-id> [--to <scan-id>]
```

`skill` writes the space as an Agent Skill folder (default: a folder named after the skill in the current directory). `markdown` prints the space as one readable page (or writes it with `--out`), to paste into a ticket or hand to a model as context. `scans` lists the scan history; `diff` compares two of them (`--to` defaults to the current scan) and prints what changed, keeping what is confirmed gone apart from what the later scan did not show ([why](../api/skills-and-diff.md#gone-or-just-not-filmed)).

## Scans

`spacecontext check <image|frames-dir>` checks images before a scan: which are usable, and which key locations (fuse box, stopcock, boiler, smoke detector…) they show, so what is missing can be filmed before paying for a scan. Free; needs `scans:write`. With `--json`, every frame's answer and a summary.

```bash
spacecontext scan <video-file | frames-dir> (--space <space-id> | --name <name>) [--type <type>] [--language en|it]
                  [--format text|json|markdown|skill] [--out <path>] [--no-wait]
spacecontext scan-status <scan-id> [--follow]
spacecontext cancel <scan-id>
```

`scan` uploads a video (`.mp4`, `.mov`, `.m4v`, up to 500 MB) or a folder of photos (`.jpg`, `.png`, `.webp`, up to 120, 2 MB each, taken in name order), starts the analysis and follows it live, printing each stage in words (`Reading the video`, `Looking at the frames`, `Extracting the context`…). With `--name` it first creates a space (`--type` is one of `apartment`, `house`, `office`, `warehouse`, `vehicle`, `boat`, `camper`, `shop`, `garage`, `appliance`, `other`); with `--space` it scans an existing space again, and the new scan is checked against the previous one. `--format` chooses what to print when it is done: a summary (`text`), the whole document (`json`), one Markdown page (`markdown`, to stdout or `--out <file>`) or an Agent Skill folder (`skill`, written to `--out <dir>`). With `--no-wait` it returns once the scan has started; `scan-status --follow` picks it up again and prints every change until the end.

Sizes are checked before anything is created. If an upload fails, the scan is cancelled (nothing is charged); a space created with `--name` stays, and the CLI tells you its id.

`cancel` cancels a scan that has not started. See [Scanning](scanning.md) for recording tips and costs.
