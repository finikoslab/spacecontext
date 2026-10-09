---
title: 'Connect an assistant'
description: 'Add the Space Context MCP server to Claude, Claude Code, Cursor, VS Code or any MCP client that supports OAuth.'
---

# Connect an assistant (MCP)

The Space Context MCP server gives an AI assistant access to your spaces: it can list them, search them, read them by section or as one page, ask them questions, compare scans and look at the evidence photos. By default it is **read-only**: it cannot change, delete or scan anything, and cannot spend money. When you connect, you can also let it **scan spaces** for you (and check photos): each scan then uses your free scan or is paid from your balance, and the assistant can tell you the price first.

**Server URL:**

```text
https://mcp.spacecontext.finikos.it/mcp
```

It speaks MCP over Streamable HTTP and authorizes with OAuth 2.1 (dynamic client registration and client ID metadata documents), so any client that supports remote MCP servers with OAuth can connect. There is no key to paste: you sign in with Apple, Google or your email.

![Connect AI in the console: the server URL to copy, the steps for Claude, Claude Code, ChatGPT and Cursor, the assistants already connected, and questions to ask](/docs/console/connect.jpg)

## What happens when you connect

1. Your assistant opens a Space Context page in the browser.
2. You sign in with Apple, with Google, or with your email and the one-time code we send you. It is the same account as the iPhone app.
3. You choose whether the assistant may also see **sensitive values** (Wi-Fi passwords, door and alarm codes, the narration of your videos), and whether it may **scan spaces** for you. By default it may do neither.
4. You approve. Space Context creates an API key for this connection only, named after your assistant and marked **MCP** in the [console](../account/api-keys.md).

To disconnect, remove the connector in your assistant, or revoke its key in the console: the assistant is then asked to sign in again on its next request.

## Claude (claude.ai and Claude Desktop)

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Name it `Space Context` and paste the server URL.
4. Click **Connect** and complete the sign-in.

On Team and Enterprise plans, an owner may need to add the connector for the organization first. Then, in a chat, enable Space Context from the tools menu and ask, for example: *"In my seaside flat, where is the water shut-off?"*

## Claude Code

```bash
claude mcp add --transport http spacecontext https://mcp.spacecontext.finikos.it/mcp
```

Then run `/mcp` in Claude Code and choose **Authenticate** for `spacecontext`. To give Claude Code a space without a connection, you can also export it as a [skill](../guides/claude-code-skill.md).

## ChatGPT

1. Open **Settings → Apps & Connectors → Advanced** and turn on **Developer mode**.
2. **Create** a connector: name `Space Context`, the server URL above, authentication **OAuth**.
3. Sign in with Apple, Google or your email, choose what the assistant may do, and approve.

## Cursor

Add the server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "spacecontext": { "url": "https://mcp.spacecontext.finikos.it/mcp" }
  }
}
```

Cursor shows a **Login** button for the server in its MCP settings.

## VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "spacecontext": { "type": "http", "url": "https://mcp.spacecontext.finikos.it/mcp" }
  }
}
```

## Other clients

Use the server URL with the client's "remote MCP server" or "custom connector" option. The OAuth metadata is published at:

- `https://mcp.spacecontext.finikos.it/.well-known/oauth-protected-resource/mcp`
- `https://mcp.spacecontext.finikos.it/.well-known/oauth-authorization-server`

## Which spaces the assistant sees

| Space | Visible |
| --- | --- |
| Spaces created with the API or the CLI (live) | Yes |
| Spaces scanned with the iPhone app | With Space Context Pro |
| Spaces scanned with the app, not yet screened | Only after screening, unless you granted sensitive values: the first read starts it, and it takes a minute or two |

## Good to know

- Space content is returned as **data, never as instructions**, and the server tells the assistant so. Text in a video that tries to address an AI is withheld before it reaches the assistant.
- Requests count against the same [limits](../limits.md) as API keys. A tool that hits a limit tells the assistant how long to wait instead of hanging.
- To create a new scan, let the assistant do it (tick **scan spaces** when connecting: it creates the scan, tells you where to upload the video, starts it and follows it), or use the [CLI](../cli/install.md) or the [API](../api/scans.md); then the assistant sees it.

Next: [the tools in detail](tools.md).
