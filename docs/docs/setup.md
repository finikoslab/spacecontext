---
title: 'Setup'
description: 'Set up Space Context in two minutes: one command (or one prompt for your coding agent), or the steps by hand for Claude, Codex, Cursor, VS Code and the SDK.'
---

# Setup

One command, or the steps by hand, for the same result: your assistant connected to your spaces, the skill that tells it how to use them, and a key for the SDK, the CLI and the API.

## Set up with your agent

Paste this into **Claude Code**, **Cursor**, **Codex** or any coding agent:

```text
Set up Space Context for me. Run `npx spacecontext@latest setup --yes --json`, then follow its `next` steps; I will approve the sign-in in the browser.
```

The command prints a link and a code, then waits up to ten minutes while you open the link, type the code and approve (give the agent a long timeout for it). It then adds the MCP server to the Claude Code, Codex, Cursor and VS Code it finds, installs the skill and checks your card on file. Its JSON tells the agent what was done and what is left for you.

What the agent cannot do for you, on purpose: approving the sign-in, signing in to the MCP server inside each assistant, and adding a card. All three happen in your browser.

## Set up from a terminal

```bash
npx spacecontext@latest setup
```

The same command, run by you: it opens the browser for the sign-in, and for Codex it runs the MCP login in your terminal. Each step ends with ✓ done, – skipped or ✗ failed and one line on why; a step that fails never stops the others, and a failed one says what to run by hand.

| Step | What it does |
| --- | --- |
| Sign in | Uses the key the CLI already has (saved, or `SPACECONTEXT_API_KEY`) if the API accepts it; otherwise the device sign-in of [`login`](cli/install.md#sign-in). `--test` asks for a test key. The key is saved for the CLI and never printed. |
| Assistants | Claude Code (`claude mcp add`, user scope), Codex (`codex mcp add`), Cursor (adds the server to `~/.cursor/mcp.json`, keeping your other servers and a copy in `mcp.json.bak`) and VS Code (`code --add-mcp`). By default the ones it finds; `--client codex,cursor` or `--client all` to choose. A `spacecontext` server that already points elsewhere is kept (skipped), unless you pass `--yes`. |
| Skill | Saves the [skill](#3-install-the-skill) as `~/.claude/skills/spacecontext/SKILL.md`. A copy you have edited is kept unless you pass `--yes`. |
| Card | With a live key, reads the wallet: with no card on file (a saved card, or a top-up already paid), it opens **Billing** in the console (adding a card charges nothing); with a card but no funds and no free scan left, it says to add funds. It never asks for card details in the terminal. |
| Next | What is left to do, a few lines of SDK code and the docs. |

`--yes` runs without questions and without opening the browser (for agents); `--json` prints only a summary, `{ "steps": [{ "id", "status", "detail" }], "next": [...] }`, on standard output. `--no-browser` prints links instead of opening them; `--skip-login`, `--skip-mcp` and `--skip-skill` leave a step out. The exit code is `0` when you are signed in and at least one assistant is connected (or you skipped those steps), `1` otherwise. → [CLI commands](cli/commands.md#get-started)

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

Add a card in the console under **Billing → Add a card**: nothing is charged. The first live scan of a new account is free (one free scan per card: a card already used on another account brings none). After that, a live scan costs US$1.00 from a prepaid balance; failed scans are refunded to the balance. → [Billing](account/billing.md)
