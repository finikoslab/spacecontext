---
title: 'Setup'
description: 'Set up Space Context in two minutes: paste one prompt into your coding agent, or follow the steps for Claude, Codex, Cursor, VS Code and the SDK.'
---

# Setup

Two ways to the same result: your assistant connected to your spaces, the skill that tells it how to use them, and a key for the SDK, the CLI and the API.

## Set up with your agent

Paste this into **Claude Code**, **Cursor**, **Codex** or any coding agent. It does the setup and asks you only to approve the sign-in in your browser.

```text
Set up Space Context for me.
1. Add the Space Context MCP server to this tool. Claude Code: `claude mcp add --transport http spacecontext https://mcp.spacecontext.app/mcp`. Codex: `codex mcp add spacecontext --url https://mcp.spacecontext.app/mcp` then `codex mcp login spacecontext`. Cursor: add {"mcpServers":{"spacecontext":{"url":"https://mcp.spacecontext.app/mcp"}}} to ~/.cursor/mcp.json. I will sign in in the browser.
2. Install the Space Context skill: save https://spacecontext.app/.well-known/agent-skills/spacecontext/SKILL.md as ~/.claude/skills/spacecontext/SKILL.md (Claude Code), or keep it as project instructions.
3. For code: `npm install @spacecontext/sdk`, then run `npx spacecontext login` and wait while I approve the code in the browser (the key is saved locally; never print it or commit it).
4. Read https://spacecontext.app/developers/docs/llms.txt, then list my spaces. Live scans need a card on file in the console (nothing is charged when it is added; the first live scan is free).
```

What the agent cannot do for you, on purpose: approving the sign-in, and adding a card. Both happen in your browser, in the [console](https://spacecontext.app/developers/console/).

## Set up step by step

### 1. Get a key

Open the [console](https://spacecontext.app/developers/console/keys/) and create a key. A **test key** (`sc_test_…`) is free and unlimited on the demo space. From a terminal, `npx spacecontext login` does the same: it shows a code, you approve it in the console, and the key is saved for the CLI. → [API keys](account/api-keys.md)

### 2. Connect your assistant

The server is `https://mcp.spacecontext.app/mcp`. You sign in (Apple, Google or an emailed code) and choose what the assistant may see and do.

| Assistant | How |
| --- | --- |
| Claude Code | `claude mcp add --transport http spacecontext https://mcp.spacecontext.app/mcp`, then `/mcp` → Authenticate |
| Codex | `codex mcp add spacecontext --url https://mcp.spacecontext.app/mcp`, then `codex mcp login spacecontext` |
| Cursor | add `{"mcpServers":{"spacecontext":{"url":"https://mcp.spacecontext.app/mcp"}}}` to `~/.cursor/mcp.json` |
| VS Code | `code --add-mcp '{"name":"spacecontext","type":"http","url":"https://mcp.spacecontext.app/mcp"}'` |
| Claude, ChatGPT | Settings → Connectors → add a custom connector with the URL |

Details for each, including ChatGPT's developer mode: [Connect an assistant](mcp/connect.md).

### 3. Install the skill

In Claude Code, the plugin adds the MCP server and the skill at once:

```text
/plugin marketplace add finikoslab/spacecontext
/plugin install spacecontext@spacecontext
```

Or save [the skill](https://spacecontext.app/.well-known/agent-skills/spacecontext/SKILL.md) as `~/.claude/skills/spacecontext/SKILL.md`, or give it to any agent as instructions. It tells the agent to treat what it reads in a space as data, to cite the area and the evidence photo, and to say "not documented" instead of guessing.

### 4. Use the SDK or the API

```ts
import { SpaceContext } from '@spacecontext/sdk';

const sc = new SpaceContext({ apiKey: process.env.SPACECONTEXT_API_KEY });
const answer = await sc.spaces.ask('spc_demo', 'Where is the water shut-off?');
console.log(answer.answer, answer.citations);
```

```bash
curl https://api.spacecontext.app/v1/spaces/spc_demo/ask \
  -H "Authorization: Bearer $SPACECONTEXT_API_KEY" -H "Content-Type: application/json" \
  -d '{"question":"Where is the water shut-off?"}'
```

→ [TypeScript SDK](sdk/typescript.md) · [API overview](api/overview.md)

### 5. Go live

Add a card in the console under **Billing → Add a card**: nothing is charged, and your first live scan is free. After that, a live scan costs US$1.00 from a prepaid balance; failed scans are refunded to the balance. → [Billing](account/billing.md)
