<p align="center"><img src="https://spacecontext.app/icon/icon-512.png" width="64" height="64" alt="Space Context"></p>

# spacecontext

[![npm](https://img.shields.io/npm/v/spacecontext?logo=npm)](https://www.npmjs.com/package/spacecontext)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/finikoslab/spacecontext/blob/HEAD/LICENSE)
[![Node >= 22.12](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Docs](https://img.shields.io/badge/docs-spacecontext.app-7C3AED)](https://spacecontext.app/developers/docs/cli/install/)

[Space Context](https://spacecontext.app/developers/) from the terminal. Film a space once, then search it, ask it questions, compare scans and hand it to your agents as an Agent Skill or a Markdown page.

```bash
npx spacecontext --help              # every command, by group
npx spacecontext scan --help         # one command: its options and examples
```

Needs Node.js 22.12 or later. Run it with `npx`, or install it with `npm install -g spacecontext`. Videos are analysed on the server, so you don't need ffmpeg; with ffmpeg installed, `scan` compresses a video too big for the API to fit, and `--compress` makes any video smaller before uploading it.

## Set up everything at once

```bash
npx spacecontext@latest setup
```

It signs you in, adds the MCP server to the Claude Code, Codex, Cursor and VS Code it finds, installs the Space Context skill in `~/.claude/skills/spacecontext/`, checks that live scans have a card on file, and ends with what is left to do. Every step reports done, skipped or failed, and none stops the others. A coding agent runs it as `npx spacecontext@latest setup --yes --json`: no questions, no browser, a JSON summary with the next steps.

## Try it on the demo, for free

```bash
npx spacecontext login --test       # a code to approve in the console; a free test key comes back
npx spacecontext spaces             # the demo space: spc_demo
npx spacecontext ask spc_demo "where is the fuse box?"
npx spacecontext skill spc_demo --out ./brisbane-apartment-skill
```

```text
The fuse box is in the Open-plan Living, Dining and Kitchen, in the hallway cupboard behind the coats.

Sources
  • Fuse box (Open-plan Living, Dining and Kitchen)
```

The demo space contains two real scans of an apartment in Brisbane (photos at check-in, a narrated video at check-out). Test keys are free and unlimited, and a test scan runs the whole flow and returns the demo content.

## Scan your own space

```bash
npx spacecontext login                                   # a live key: a new account's first live scan is free (one per card)
npx spacecontext check ./photos                          # optional: usable frames, key locations still missing
npx spacecontext scan ./flat.mp4 --name "Seaside flat" --type apartment
npx spacecontext search "where is the water shut-off?"
npx spacecontext skill spc_… --out ~/.claude/skills/seaside-flat
```

`scan` uploads a video (`.mp4`, `.mov`, `.m4v`, `.3gp`, `.webm`, `.mkv`, up to 4 GB and 10 minutes) or a folder of photos (`.jpg`, `.png`, `.webp`, up to 120, 2 MB each, taken in name order). The video's limits are the ones the API states (an API that does not state them is taken to accept 100 MB), and the video is read from disk as it uploads. When `ffmpeg` and `ffprobe` are installed, a bigger video is re-encoded to an H.264 MP4 that fits (the bitrate from its duration, at most 8 Mbit/s, upright, a temporary copy deleted after the upload), and one over 10 minutes is refused before encoding; `--compress` re-encodes to a smaller H.264 file before uploading (useful on a slow connection), `--no-compress` never compresses. It then starts the analysis and follows it live: at a terminal, a status line with the stage in progress and its elapsed time, and a ✓ line for each stage done ("Reading the video", "Looking at the frames", "Extracting the context"…). At the end it prints the space and the commands to ask it, export it as a skill and read it again. Press Ctrl+C after the start and the scan goes on on the server; the CLI tells you how to follow it again. After the free scan, each live scan costs $1.00 from your prepaid balance, and failed scans are refunded. If an upload fails, the scan is cancelled and nothing is charged. A live key that can scan needs a card on file in the console first: adding one charges nothing.

## Commands

| Command | |
| --- | --- |
| `setup [--client <list>] [--test] [--yes] [--json] [--no-browser] [--skip-login] [--skip-mcp] [--skip-skill]` | Sign in, connect Claude Code, Codex, Cursor and VS Code (`--client claude-code,codex,cursor,vscode` or `all`), install the skill, check the card on file. `--yes` for agents (no questions, no browser); exit code `0` when signed in and at least one assistant is connected |
| `login [--test] [--no-browser] [--key -]` | Sign in: approve a code in the console, and the key comes back to the terminal |
| `logout`, `whoami` | Forget the saved key; show the account, the key in use (masked) and where it comes from, its mode and scopes |
| `wallet` | Balance, free scans left, price per scan, card on file |
| `spaces [--source app\|api]` | Every space the key can read: `app_…` from the iPhone app, `spc_…` from the API |
| `space <space-id> [--transcript]` | A summary of a space; `--json` for the whole Space Document |
| `search <question…> [--space <id>] [--limit <1-25>]` | Search every space, in any language |
| `ask <space-id> <question…>` | A short answer with its sources |
| `skill <space-id> [--out <dir>] [--transcript]` | Write the space as an Agent Skill folder |
| `markdown <space-id> [--out <file>] [--transcript]` | The space as one Markdown page |
| `scans <space-id>` | The scan history of a space |
| `diff <space-id> --from <scan-id> [--to <scan-id>]` | What changed between two scans, with confirmed changes kept apart from what wasn't filmed |
| `scan <video\|frames-dir> (--space <id> \| --name <name>)` | Upload, start and follow a scan. Options: `--type`, `--language en\|it\|es\|fr\|de\|pt\|nl`, `--format text\|json\|markdown\|skill`, `--out`, `--no-wait` |
| `check <image\|frames-dir>` | Before a scan: which frames are usable, and which key locations (fuse box, stopcock, boiler…) they show. Free |
| `scan-status <scan-id> [--follow]` | Where a scan is; `--follow` prints every change until it ends |
| `cancel <scan-id>` | Cancel a scan that hasn't started; nothing is charged |
| `delete-space <space-id>` | Delete a space created through the API, with its scans and files |

`--transcript` adds what was said in the video and needs a key with `spaces:sensitive`. Space types for `--type` are `apartment`, `house`, `office`, `warehouse`, `vehicle`, `boat`, `camper`, `shop`, `garage`, `appliance` and `other`.

## Keys and sign-in

`login` shows a code and opens the console. There you sign in with Apple, Google, GitHub or your email, type the code, choose what the key may do and approve. A live key that can scan (`scans:write`) needs a card on file, and the console asks you to add one (nothing is charged); test keys and read-only keys need none. The key comes back to the terminal without passing through the browser. Approve only a code you're looking at in your own terminal: that's why the code is never carried in a link.

The key is saved in `~/.config/spacecontext/config.json` (or `$XDG_CONFIG_HOME/spacecontext/`), readable only by your user. Every command uses the first key it finds in this order:

1. `--api-key sc_…`
2. `SPACECONTEXT_API_KEY` (an empty value counts as unset)
3. the key saved by `login`

To save a key you already have, run `login --key -`: it asks for the key without echoing it. `--key sc_…` works too, but leaves the key in your shell history. `--base-url` and `SPACECONTEXT_BASE_URL` point the CLI at another API. A base URL saved by `login` is used only with the key saved alongside it.

## Scripts and CI

Every command accepts `--json` and prints the API's JSON on standard output, while progress goes to standard error (with `--json`, only errors do). Exit codes are `0` for success, `1` when the request failed and `2` for wrong usage. Errors show the API's code and request id, then what to do next:

```text
✗ Error [INSUFFICIENT_FUNDS]: The wallet does not cover this scan (request 8f0c2b9e-…)
  › Top up the balance in the console: https://spacecontext.app/developers/console/billing/
  › `spacecontext wallet` shows the balance and the price of a scan
```

Colours and the live status line appear only at a terminal: piped or redirected output is plain lines, and `NO_COLOR=1` turns colours off.

Use a test key in CI: it's free and never touches real data.

## Links

[Install and sign in](https://spacecontext.app/developers/docs/cli/install/) · [Commands](https://spacecontext.app/developers/docs/cli/commands/) · [Recording tips](https://spacecontext.app/developers/docs/cli/scanning/) · [Check-in and check-out](https://spacecontext.app/developers/docs/guides/check-in-check-out/) · [A space in Claude Code](https://spacecontext.app/developers/docs/guides/claude-code-skill/) · [Source](https://github.com/finikoslab/spacecontext/tree/HEAD/packages/cli)

[MIT](https://github.com/finikoslab/spacecontext/blob/HEAD/LICENSE) © Finikos S.r.l.
