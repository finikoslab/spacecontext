---
title: 'Quickstart'
description: 'From zero to a searchable space in five minutes, with a free test key.'
---

# Quickstart

**Using a coding agent?** Paste the prompt in [Setup](setup.md) into Claude Code, Cursor or Codex, or run `npx spacecontext@latest setup` yourself: it signs you in, connects your assistants and installs the skill.

**No code at all?** Open the [console](https://spacecontext.app/developers/console/), sign in with Apple, Google, GitHub or your email, switch to **Test** and open the demo space: inventory, photos, questions and a comparison of two scans. Then add a card under **Billing → Add a card** (nothing is charged; live keys that can scan need one), switch to **Live**, open **New scan** and drop a video of a room: the first live scan of a new account is free (one free scan per card). **Connect AI** adds your spaces to Claude or ChatGPT in a minute.

![The Spaces page of the console in Test mode: the demo space, with its areas, items and issues, and a search box across every space](/docs/console/spaces.jpg)

The rest of this page does the same from the terminal. It takes about five minutes and costs nothing: it uses a **test key**, which works on the demo space.

The demo is real output, not a mock-up: a one-bedroom apartment in Brisbane scanned twice through the API, with five photos at check-in and a narrated video at check-out, checked against the check-in. The narration (Wi-Fi, fuse box, bins, a loose heater cable) is invented for the example; the photos are by Chris Olszewski on Wikimedia Commons (CC BY-SA 4.0).

## 1. Sign in from the terminal

You need Node.js 22 or later.

```bash
npx spacecontext login --test
```

The terminal shows a code and opens the [console](https://spacecontext.app/developers/console/): sign in with Apple, Google, GitHub or your email (the same account as the iPhone app), type the code, approve. The terminal receives a **test** key: free, unlimited, the demo space. → [Console and sign-in](account/console-and-login.md)

## 2. Use it

```bash
npx spacecontext spaces         # the demo space: spc_demo
npx spacecontext search "where is the fuse box?"
npx spacecontext ask spc_demo "where is the fuse box?"
```

`search` looks across every space you can read; `ask` answers from one space, with its sources.

## 3. Export it as an Agent Skill

```bash
npx spacecontext skill spc_demo --out ./brisbane-apartment-skill
```

The folder holds `SKILL.md`, `space.json` and one reference file per topic (areas, items, issues, key locations, how-to, facts). Point any agent that reads skills at it, for example `~/.claude/skills/` for Claude Code. → [Use a space in Claude Code](guides/claude-code-skill.md)

## 4. Run a scan

With a test key the whole scan flow runs, and the result is the demo space under the name you choose:

```bash
npx spacecontext scan ./tour.mp4 --name "Test flat"
```

![The demo space in the console: summary, issues with their evidence frames and severity, key locations, and the tabs Inventory, Ask, History & compare and Export](/docs/console/space.jpg)

## 5. Go live

When you are ready for your own spaces:

1. Add a card in the console under **Billing → Add a card**: a live key that can scan needs one. Stripe saves it and nothing is charged.
2. Sign in again for a **live** key (or create one in the console).
3. Scan a real video: the first live scan of a new account is free (one free scan per card, see [Billing](account/billing.md#add-a-card)).

```bash
npx spacecontext login                      # approve a live key in the console
npx spacecontext scan ./flat.mp4 --name "Seaside flat" --type apartment
```

A scan takes a few minutes. Then `search`, `ask` and `skill` work on it, and so does the [MCP server](mcp/connect.md) once you connect your assistant.

## Next steps

- [Connect Claude to your spaces](mcp/connect.md)
- [Recording tips for good scans](cli/scanning.md)
- [Call the API from your code](api/overview.md)
