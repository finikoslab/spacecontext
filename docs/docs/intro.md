---
slug: /
title: 'Space Context for developers'
sidebar_label: 'Introduction'
description: 'Film a space once, and your agents know it. API, CLI and MCP server for structured context about physical spaces.'
---

# Space Context for developers

Your agents know your code, your documents and your calendar. They know nothing about the places you live and work in. **Film a space once, and they know it too.**

Space Context turns a video of a physical space (a flat, a holiday rental, an office, a van, an appliance) into a structured **Space Document**: every area, every item and where it is, its condition, what is broken, where the water shut-off and the fuse box are, how things work, with the original video frames as evidence. You read it, search it and ask it questions from your code, from the terminal or from an AI assistant.

## Three ways in

| | Best for | Start here |
| --- | --- | --- |
| **MCP server** | Giving Claude (or any MCP client) read access to your spaces | [Connect an assistant](mcp/connect.md) |
| **CLI** | Scanning a video and exporting an Agent Skill from the terminal | [Install the CLI](cli/install.md) |
| **API and SDK** | Building it into your product | [API overview](api/overview.md), [TypeScript SDK](sdk/typescript.md) |

All three use the same account as the Space Context iPhone app, and the same [API keys](account/api-keys.md) from the [console](account/console-and-login.md).

## What you can do

- **Scan** a video (MP4, MOV, M4V up to 100 MB and 10 minutes) or up to 120 photos. The analysis runs on our side; no ffmpeg needed. → [Scans](api/scans.md)
- **Read** a space as JSON, by section. → [The Space Document](api/space-document.md)
- **Search** across all your spaces, in any language: "where did I see a ladder?" → [Search and ask](api/search-and-ask.md)
- **Ask** one space a question and get a short answer with its sources and photos, or "not documented". → [Search and ask](api/search-and-ask.md)
- **Compare** two scans of the same space: items added, removed, moved, issues new or resolved. → [Skills and comparisons](api/skills-and-diff.md)
- **Export** a space as an Agent Skill folder that any agent can read. → [Use a space in Claude Code](guides/claude-code-skill.md)
- **Get notified** when a scan completes or fails. → [Webhooks](api/webhooks.md)

## Try it for free

A **test key** (`sc_test_…`) runs every flow for free on the demo space, two real scans of an apartment in Brisbane (photos at check-in, a narrated video at check-out): scans complete instantly, nothing is charged and none of your data is involved. Create one in the [console](https://spacecontext.app/developers/console) and follow the [quickstart](quickstart.md).

Your first **live** scan is free as well. After that, live scans are paid from a prepaid balance: see [Billing](account/billing.md).

## Use these docs from an agent

Every page of this documentation is also served as plain Markdown (the page's URL with `.md`), and the whole set comes in the formats agents read best:

- **`llms.txt`** — https://spacecontext.app/developers/docs/llms.txt: an index of every page with a one-line description. Give this URL to an agent; it fetches only the pages it needs.
- **`llms-full.txt`** — https://spacecontext.app/developers/docs/llms-full.txt: everything in one file, to paste into a conversation or add to a project's files.
- **The MCP server** — `https://mcp.spacecontext.app/mcp`: connect Claude or any MCP client to read your spaces themselves, not only the docs. → [Connect an assistant](mcp/connect.md)

For tooling: the [OpenAPI contract](https://spacecontext.app/developers/docs/openapi.json) (code generation, validation) and a [ZIP of every page](https://spacecontext.app/developers/docs/spacecontext-docs.zip) with the contract, for offline use.
