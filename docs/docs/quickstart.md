---
title: 'Quickstart'
description: 'From zero to a searchable space in five minutes, with a free test key.'
---

# Quickstart

**No code at all?** Open the [console](https://spacecontext.finikos.it/developers/console), sign in with Apple, Google or your email, switch to **Test** and open the demo space: inventory, photos, questions and a comparison of two scans. Then switch to **Live**, open **New scan** and drop a video of a room: the first live scan is free. **Connect AI** adds your spaces to Claude or ChatGPT in a minute.

The rest of this page does the same from the terminal. It takes about five minutes and costs nothing: it uses a **test key**, which works on the demo space.

## 1. Create a test key

1. Open the [console](https://spacecontext.finikos.it/developers/console) and sign in with Apple, Google or your email: it is the same account as the iPhone app. → [Console and sign-in](account/console-and-login.md)
2. In **API keys**, create a key with mode **Test**. Copy it: it is shown only once.

## 2. Use it from the terminal

You need Node.js 22 or later.

```bash
npx spacecontext login          # paste the sc_test_… key when asked
npx spacecontext spaces         # the demo space: spc_demo
npx spacecontext search "where is the electrical panel?"
npx spacecontext ask spc_demo "where is the electrical panel?"
```

`search` looks across every space you can read; `ask` answers from one space, with its sources.

## 3. Export it as an Agent Skill

```bash
npx spacecontext skill spc_demo --out ./home-kitchen-skill
```

The folder holds `SKILL.md`, `space.json` and one reference file per topic (areas, items, issues, key locations, how-to, facts). Point any agent that reads skills at it, for example `~/.claude/skills/` for Claude Code. → [Use a space in Claude Code](guides/claude-code-skill.md)

## 4. Run a scan

With a test key the whole scan flow runs, and the result is the demo space under the name you choose:

```bash
npx spacecontext scan ./tour.mp4 --name "Test flat"
```

## 5. Go live

When you are ready for your own spaces:

1. Create a **Live** key in the console.
2. Scan a real video: your first live scan is free.

```bash
npx spacecontext login                      # paste the sc_live_… key
npx spacecontext scan ./flat.mp4 --name "Seaside flat" --type apartment
```

A scan takes a few minutes. Then `search`, `ask` and `skill` work on it, and so does the [MCP server](mcp/connect.md) once you connect your assistant.

## Next steps

- [Connect Claude to your spaces](mcp/connect.md)
- [Recording tips for good scans](cli/scanning.md)
- [Call the API from your code](api/overview.md)
