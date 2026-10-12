---
title: 'CLI commands'
sidebar_label: 'Commands'
description: 'Every spacecontext CLI command: setup, sign-in, spaces, search and ask, Agent Skill and Markdown exports, scan comparisons and scans from the terminal.'
---

# CLI commands

All commands accept `--json`, `--api-key <key>` and `--base-url <url>`. `spacecontext <command> --help` (or `spacecontext help <command>`) shows a command's options and examples, and an option a command does not take is refused rather than ignored. New here? Start with [`setup`](#get-started). Ids are the ones the API uses: spaces `app_…` (scanned with the app) or `spc_…` (created with the API or the CLI), scans `scn_…`.

## Get started

```bash
spacecontext setup [--client claude-code,codex,cursor,vscode,all] [--test] [--yes] [--json]
                   [--no-browser] [--skip-login] [--skip-mcp] [--skip-skill]
```

Everything in one go: signs in (the device sign-in of `login`, unless the key the CLI has is accepted), adds the MCP server to Claude Code, Codex, Cursor and VS Code (the ones it finds, or those named with `--client`), saves the skill as `~/.claude/skills/spacecontext/SKILL.md`, checks the card on file of a live account, and ends with what is left to do. Each step prints ✓ done, – skipped or ✗ failed with one line on why, and none stops the others.

| Option | |
| --- | --- |
| `--client <list>` | `claude-code`, `codex`, `cursor`, `vscode`, comma-separated, or `all`. Default: the clients found on this machine. A client named but not installed fails; with `all` it is skipped. |
| `--test` | Sign in with a test key (free, the demo space). |
| `--yes` | No questions and no browser, for agents. Also replaces a skill file you edited (kept as `SKILL.md.bak`) and a `spacecontext` server that points elsewhere in Claude Code (its user scope; a local or project one is reported, not removed), Codex or Cursor. Without `--yes` that server is kept and the step says skipped. |
| `--json` | Only the summary on standard output: `{ "steps": [{ "id", "status", "detail" }], "next": [...] }`. Progress and the sign-in code go to standard error. |
| `--no-browser` | Print links instead of opening them. |
| `--skip-login`, `--skip-mcp`, `--skip-skill` | Leave out a step. |

Claude Code gets the server for your user (`claude mcp add --transport http --scope user`); Codex through `codex mcp add`, and its MCP login runs in your terminal (not with `--yes` or `--no-browser`); Cursor in `~/.cursor/mcp.json`, written in one step, keeping your other servers, with the original copied once to `mcp.json.bak` (a file that is not plain JSON is left alone); VS Code through `code --add-mcp`. Programs are run directly, never through a shell, with a timeout; on Windows, where Codex and VS Code are batch files that need a shell, setup prints their command instead. The exit code is `0` when you are signed in and at least one assistant is connected (or those steps were skipped), `1` otherwise, `2` for wrong usage.

## Account

| Command | |
| --- | --- |
| `spacecontext login [--test] [--no-browser]` | Sign in from the terminal: a code to approve in the console, the key comes back here. `--key -` saves a key you already have, typed without echo (`--key sc_…` works but stays in your shell history). |
| `spacecontext logout` | Forget the saved key. |
| `spacecontext whoami` | The account, the key in use (masked, as the console shows it) and where it comes from, its mode (test or live) and scopes. |
| `spacecontext wallet` | Balance, free scans left, price per scan, card on file and automatic recharge. Needs `scans:read`. |

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

Sources
  • Fuse box (Open-plan Living, Dining and Kitchen)

$ spacecontext ask spc_demo "dov'è il frigorifero?"
Dark refrigerator is in the Open-plan Living, Dining and Kitchen, at the left side of the kitchen work area. Condition: good.

Sources
  • Dark refrigerator (Open-plan Living, Dining and Kitchen)
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
spacecontext scan <video-file | frames-dir> (--space <space-id> | --name <name>) [--type <type>] [--language <code>]
                  [--format text|json|markdown|skill] [--out <path>] [--no-wait] [--compress | --no-compress]
spacecontext scan-status <scan-id> [--follow]
spacecontext cancel <scan-id>
```

`scan` uploads a video (`.mp4`, `.mov`, `.m4v`, `.3gp`, `.webm`, `.mkv`, up to 4 GB and 10 minutes) or a folder of photos (`.jpg`, `.png`, `.webp`, up to 120, 2 MB each, taken in name order), starts the analysis and follows it live, printing each stage in words (`Reading the video`, `Looking at the frames`, `Extracting the context`…). With `--name` it first creates a space (`--type` is one of `apartment`, `house`, `office`, `warehouse`, `vehicle`, `boat`, `camper`, `shop`, `garage`, `appliance`, `other`); with `--space` it scans an existing space again, and the new scan is checked against the previous one. `--language` is the language of the report: `en` (English, the default), `it` (Italiano), `es` (Español), `fr` (Français), `de` (Deutsch), `pt` (Português) or `nl` (Nederlands), whatever language is spoken. `--format` chooses what to print when it is done: a summary (`text`), the whole document (`json`), one Markdown page (`markdown`, to stdout or `--out <file>`) or an Agent Skill folder (`skill`, written to `--out <dir>`). With `--no-wait` it returns once the scan has started; `scan-status --follow` picks it up again and prints every change until the end.

At a terminal, the stage in progress is a live line with its elapsed time, and each finished stage stays as a ✓ line with how long it took; piped, each stage is one plain `› stage…` line. At the end, the CLI prints the space (areas and items, key locations, issues) and the commands to ask it, export it as a skill and read it again:

```text
$ spacecontext scan ./flat.mp4 --name "Seaside flat" --type apartment
◆ Scanning flat.mp4 (video, 48.2 MB) into a new space "Seaside flat"
✓ Space created  spc_3f9c…
✓ Uploaded flat.mp4  48.2 MB in 12s
✓ Scan started  scn_8a1b… · free scan
✓ Queued  2s
✓ Reading the video  21s
✓ Checking the frames  4s
✓ Looking at the frames  1m 04s
✓ Writing the report  38s
✓ Extracting the context  51s
✓ Saving  1s
✓ Scan complete in 3m 15s

Seaside flat  spc_3f9c… · api
Scan scn_8a1b… of 2026-10-11 · deep level, complete
5 areas · 42 items · 3 issues · 6 key locations · 9 facts
…
Next
  › Ask it: spacecontext ask spc_3f9c… "where is the fuse box?"
  › Give it to your agent: spacecontext skill spc_3f9c… --out ~/.claude/skills/seaside-flat
  › Read it again: spacecontext space spc_3f9c…
```

The limits are the ones the API states in `GET /v1`, read before anything is created (an API that does not state them takes 100 MB; when they cannot be read, nothing is checked or compressed unasked, and the API decides). A video over the limit is compressed to fit when `ffmpeg` and `ffprobe` are installed: an H.264 MP4 at the bitrate its duration allows (at most 8 Mbps, 720p under 2.5 Mbps), upright, uploaded and then deleted; a video over 10 minutes is refused before encoding. `--compress` re-encodes to a smaller H.264 file before uploading (useful on a slow connection), `--no-compress` never compresses. Without ffmpeg, a video over the limit is refused with how to install it. See [Scanning](scanning.md#automatic-compression).

```text
$ spacecontext scan ./IMG_0042.MOV --name "Seaside flat" --compress
◆ Scanning IMG_0042.MOV (video, 390.0 MB) into a new space "Seaside flat"
✓ Compressed IMG_0042.MOV  390.0 MB → 176.4 MB, H.264 up to 1080p, in 1m 52s
✓ Space created  spc_3f9c…
✓ Uploaded IMG_0042.MOV  176.4 MB in 59s
…
```

Sizes are checked before anything is created. If an upload fails, the scan is cancelled (nothing is charged); a space created with `--name` stays, and the CLI tells you its id. If you press Ctrl+C after the scan has started, the scan goes on on the server, and the CLI prints the `scan-status --follow` command that picks it up again.

`cancel` cancels a scan that has not started. See [Scanning](scanning.md) for recording tips and costs.
