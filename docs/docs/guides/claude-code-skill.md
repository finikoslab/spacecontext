---
title: 'Use a space in Claude Code'
description: 'Export a space as an Agent Skill folder and let Claude Code answer from it offline: the export command, the files it writes and how to keep it current.'
---

# Use a space in Claude Code

A space exported as a **skill** is a folder of files that Claude Code (and any agent that reads skills) opens only when a conversation needs it. It works offline and needs no connection to Space Context once exported.

## Export

```bash
npx spacecontext skill spc_3f… --out ~/.claude/skills/seaside-flat
```

For a project-only skill, export into the project instead: `--out .claude/skills/seaside-flat`.

```text
seaside-flat/
├── SKILL.md              # when to use it, and how to read the files
├── space.json            # the whole Space Document
└── references/
    ├── overview.md
    ├── areas/01-kitchen.md …
    ├── items.md          # with the names people use
    ├── key-locations.md  # water shut-off, fuse box, boiler…
    ├── how-to.md
    ├── issues.md
    ├── facts.md
    ├── qa.md
    └── frames.md
```

## Use

Ask Claude Code about the space; it loads the skill when the question matches its description:

> Where is the fuse box in the seaside flat, and how do I reset the boiler?

`SKILL.md` tells the agent to treat the files as data, to name the area, and to say "not documented" rather than guess.

## Keep it current

Re-export after a new scan: the folder is overwritten file by file. A skill exported with a key without `spaces:sensitive` contains no passwords or codes; add `--transcript` with a key that has the scope to include what was said in the video.

## Prefer a live connection?

Connect the [MCP server](../mcp/connect.md) instead: Claude Code then reads the latest version of every space you own, and can search across them.
