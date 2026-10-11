<div align="center">

<img src="docs/static/img/favicon.svg" width="72" height="72" alt="Space Context logo">

# Space Context

**The context layer for the physical world.**

Film a space once, and your agent knows it: every room, item, key location and issue,<br>
each with the original video frame as evidence.

[![npm @spacecontext/sdk](https://img.shields.io/npm/v/@spacecontext/sdk?label=%40spacecontext%2Fsdk&logo=npm)](https://www.npmjs.com/package/@spacecontext/sdk)
[![npm spacecontext](https://img.shields.io/npm/v/spacecontext?label=spacecontext&logo=npm)](https://www.npmjs.com/package/spacecontext)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](packages/sdk)<br>
[![MCP server](https://img.shields.io/badge/MCP-remote%20server-7C3AED)](https://spacecontext.app/developers/docs/mcp/connect/)
[![OpenAPI 3.1](https://img.shields.io/badge/OpenAPI-3.1-6BA539?logo=openapiinitiative&logoColor=white)](https://api.spacecontext.app/v1/openapi.json)
[![Docs](https://img.shields.io/badge/docs-spacecontext.app-7C3AED)](https://spacecontext.app/developers/docs/)
[![llms.txt](https://img.shields.io/badge/llms.txt-for%20agents-7C3AED)](https://spacecontext.app/developers/docs/llms.txt)

[Docs](https://spacecontext.app/developers/docs/) · [Quickstart](https://spacecontext.app/developers/docs/quickstart/) · [API reference](https://spacecontext.app/developers/docs/api/reference/) · [Console](https://spacecontext.app/developers/console/) · [MCP server](https://spacecontext.app/developers/docs/mcp/connect/)

</div>

## What it is

Agents know your code, your documents and your calendar. They know nothing about the places you live and work in.

Space Context fills that gap. Record a phone video of a space, narrated or not, and it becomes a **Space Document**, structured JSON that your agents can read:

- **Inventory by room**: items with location, quantity, condition, brand, model and visible text.
- **Key locations**: fuse box, water shut-off, boiler, router, smoke detectors, meters.
- **How-tos** taken from the narration ("fill the water tank at the back, then press the large button").
- **Issues** with severity and a suggested action, and **facts** (access, Wi-Fi, rules, contacts).
- **Evidence**: every record points to the original video frames it comes from.

Then you can **compare** two scans (check-in and check-out), **ask** a space questions and get answers with citations, **search** across all your spaces in any language, and **export** a space as an Agent Skill or a Markdown page.

It works for any space: a home, a short-term rental, a move-in or move-out, an office, a vehicle, an appliance. It uses the same account as the [Space Context iPhone app](https://apps.apple.com/app/id6774555358), and spaces scanned with the app can be read through the API on every account.

### What an agent gets back

"Where is the water shut-off?" asked of a space (`POST /v1/spaces/{id}/ask`):

```json
{
  "object": "answer",
  "space_id": "spc_3f…", "scan_id": "scn_8a…",
  "question": "Where is the water shut-off?",
  "answer": "Under the bathroom sink, behind the cupboard door.",
  "documented": true,
  "citations": [
    {
      "record_type": "key_location", "record_id": "loc_1",
      "title": "Main water valve", "area": "Bathroom",
      "evidence": [{ "frame_id": "frame-14", "timestamp_ms": 41200, "url": "https://api.spacecontext.app/v1/media/…" }]
    }
  ]
}
```

The answer comes only from the space's records. If they don't contain it, `documented` is `false` and the answer says so instead of guessing. The evidence `url` is a short-lived signed link to the frame the camera captured 41 seconds into the video.

## Try it in 60 seconds

The **demo space** (`spc_demo`) contains two real scans of an apartment in Brisbane: photos at check-in, then a narrated video at check-out. Test keys (`sc_test_…`) can read it for free, with no limit and no payment.

**0. Claude Code plugin.** Once this repository is public: `/plugin marketplace add finikoslab/spacecontext`, then `/plugin install spacecontext@spacecontext` (the MCP server and a Space Context skill; run `/mcp` to sign in).

**1. Connect your assistant (MCP).** In Claude, open **Settings → Connectors → Add custom connector** and paste:

```text
https://mcp.spacecontext.app/mcp
```

In Claude Code, run `claude mcp add --transport http --scope user spacecontext https://mcp.spacecontext.app/mcp`, then `/mcp` → Authenticate. Codex, ChatGPT, Cursor and VS Code are covered in [Connect an assistant](https://spacecontext.app/developers/docs/mcp/connect/). You sign in with Apple, Google or an emailed code. The connection is read-only unless you allow scanning, which needs a card on file. It sees the spaces of your account (the demo is for test keys), so use the paths below to explore the demo first.

**2. CLI.**

```bash
npx spacecontext login --test          # approve the code in the console; a free test key comes back
npx spacecontext ask spc_demo "where is the fuse box?"
npx spacecontext search "where is the fuse box?"
npx spacecontext skill spc_demo --out ./brisbane-apartment-skill
```

```text
The fuse box is in the Open-plan Living, Dining and Kitchen, in the hallway cupboard behind the coats.

Sources
  • Fuse box (Open-plan Living, Dining and Kitchen)
```

**3. SDK.** Create a test key in the [console](https://spacecontext.app/developers/console/keys/) (**API keys**, mode **Test**), set it as `SPACECONTEXT_API_KEY` and install with `npm install @spacecontext/sdk`:

```ts
import { SpaceContext } from '@spacecontext/sdk';

const sc = new SpaceContext(); // reads SPACECONTEXT_API_KEY

const answer = await sc.spaces.ask('spc_demo', 'Where is the fuse box?');
const document = await sc.spaces.get('spc_demo'); // the whole Space Document
console.log(answer.answer, document.key_locations.map((k) => `${k.label}: ${k.location}`));

// Your own space, from a video: created, uploaded, analysed and followed live in one call.
const { spaceId } = await sc.scan('./tour.mp4', { name: 'Seaside flat', onProgress: (p) => console.log(p.type) });
```

**4. curl.** With the same key:

```bash
curl -X POST https://api.spacecontext.app/v1/spaces/spc_demo/ask \
  -H "Authorization: Bearer $SPACECONTEXT_API_KEY" -H "Content-Type: application/json" \
  -d '{"question": "Where is the fuse box?"}'
```

When you're ready to scan your own spaces, add a card in the console (nothing is charged: a live key that can scan needs one), sign in with `npx spacecontext login` to get a live key and scan a video. The first live scan of a new account is free (one free scan per card). Full walkthrough: [Quickstart](https://spacecontext.app/developers/docs/quickstart/).

## What you get

| | How | Docs |
| --- | --- | --- |
| **Scan** a video (MP4, MOV, M4V) or up to 120 photos; the analysis runs server-side, no ffmpeg needed | `sc.scan()`, `spacecontext scan`, `POST /v1/spaces/{id}/scans` | [Scans](https://spacecontext.app/developers/docs/api/scans/) |
| **Read** a space as a versioned JSON document, by section | `GET /v1/spaces/{id}` | [The Space Document](https://spacecontext.app/developers/docs/api/space-document/) |
| **Search** every space in any language ("rubinetto dell'acqua" finds "water shut-off valve") | `GET /v1/search` | [Search and ask](https://spacecontext.app/developers/docs/api/search-and-ask/) |
| **Ask** one space and get a short answer with citations and photos, or "not documented" | `POST /v1/spaces/{id}/ask` | [Search and ask](https://spacecontext.app/developers/docs/api/search-and-ask/) |
| **Compare** two scans: added, moved, changed, and "gone" only when a frame shows the empty place | `GET /v1/spaces/{id}/diff` | [Check-in and check-out](https://spacecontext.app/developers/docs/guides/check-in-check-out/) |
| **Export** a space as an Agent Skill folder or one Markdown page | `GET /v1/spaces/{id}/skill`, `…/markdown` | [A space in Claude Code](https://spacecontext.app/developers/docs/guides/claude-code-skill/) |
| **Follow** a scan live as Server-Sent Events | `GET /v1/scans/{id}/events` | [Scans](https://spacecontext.app/developers/docs/api/scans/) |
| **Check frames** while filming: usable or not, which key locations are still missing | `POST /v1/frames/check` | [Guided capture](https://spacecontext.app/developers/docs/guides/guided-capture/) |
| **Webhooks** for `scan.completed`, `scan.failed`, `wallet.auto_recharge_failed` | Console → Webhooks | [Webhooks](https://spacecontext.app/developers/docs/api/webhooks/) |

## Pricing

| | Price |
| --- | --- |
| Test keys, on the demo space | Free, within the [limits](https://spacecontext.app/developers/docs/limits/) |
| First live scan of a new account | Free, one free scan per card: a card already used on another Space Context account (even a deleted one) brings none |
| Each live scan after that | **US$1.00**, from a prepaid balance |
| Failed scans | Refunded automatically |
| Reading, search, questions and frame checks | Included, within the [limits](https://spacecontext.app/developers/docs/limits/) |
| Spaces scanned with the iPhone app | Readable at no cost |
| Live scans, and live keys that can scan | Need a card on file: saved in the console without a charge, or a top-up already paid |

You top up the balance by card through Stripe ($10 to $500 per payment), with optional automatic top-up and a monthly spending cap per key. Every top-up comes with an invoice. See [Billing](https://spacecontext.app/developers/docs/account/billing/).

## Limits

| | Limit |
| --- | --- |
| Video | Up to 100 MB and 10 minutes |
| Photos | 120 per scan, JPEG, PNG or WebP, 2 MB each |
| Requests | 120 per minute per key |
| Search | 20 per minute, 1 000 per day per account |
| Questions (`ask`) | 20 per minute, 200 answered per day per account |
| Frame checks | 2 000 per day per account |
| Scans processing at once | 10 per account |
| New spaces, new scans | 200 spaces and 500 scans per day per account, in each mode (test keys included); reset at midnight UTC |
| Open event streams (`GET /v1/scans/{id}/events`) | 10 per account at once, test and live together; the SDK, the CLI and the MCP server poll instead when all are in use |

Every limit is listed in [Limits](https://spacecontext.app/developers/docs/limits/).

## Security and privacy

- **Keys** are shown once and stored hashed. Each key has scopes: `spaces:read`, `scans:read`, `scans:write`, and the opt-in `spaces:sensitive`. A key without `spaces:sensitive` gets passwords, door and alarm codes, and the narration redacted from documents, answers, skills and exports. Search results never contain them, whatever the key.
- **Prompt injection from the physical world**: text in a video that addresses an AI ("ignore your previous instructions…", on a sign or said on camera) is withheld before any model or agent reads it, and the document notes this in `coverage.warnings`. This is a safety net, not a guarantee, so agents should still treat space content as untrusted data.
- **Storage**: videos, frames and documents are stored on Cloudflare, with files in R2 in the EU jurisdiction. Source videos are deleted once their frames are extracted. Frames are kept as evidence and served through short-lived signed links.
- **Webhooks** are signed (HMAC-SHA256 over the timestamp and the body) and sent only to public HTTPS hosts. Redirects are never followed.
- **MCP connections** each get their own key, which you can revoke from the console. The assistant never sees the key.

Details: [Security and privacy](https://spacecontext.app/developers/docs/security-and-privacy/). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Packages

| Path | What it is |
| --- | --- |
| [`packages/sdk`](packages/sdk) · [`@spacecontext/sdk`](https://www.npmjs.com/package/@spacecontext/sdk) | TypeScript client typed from the contract: one call from a video to a document. No runtime dependencies; runs in Node 22+, Deno, Workers and browsers |
| [`packages/cli`](packages/cli) · [`spacecontext`](https://www.npmjs.com/package/spacecontext) | The terminal: sign in, scan, search, ask, compare, export a Skill or Markdown |
| [`packages/mcp`](packages/mcp) | The remote MCP server (Cloudflare Workers, OAuth 2.1), hosted at `mcp.spacecontext.app`. Not published to npm: deploy your own or use the hosted one |
| [`openapi/openapi.json`](openapi/openapi.json) | The API contract (OpenAPI 3.1), generated by the API |
| [`docs`](docs) | The documentation source, published at [spacecontext.app/developers/docs](https://spacecontext.app/developers/docs/) |
| [`examples`](examples) | [`scan-one-call.ts`](examples/scan-one-call.ts) (a video to a document) and [`where-is-it.ts`](examples/where-is-it.ts) (search, then ask) |

The analysis pipeline (vision, fusion, the deep pass and sensitive-value screening) runs in the hosted Space Context API and is not part of this repository.

## For agents

- **[llms.txt](https://spacecontext.app/developers/docs/llms.txt)**: an index of every docs page. There's also [llms-full.txt](https://spacecontext.app/developers/docs/llms-full.txt) with everything in one file, and every page is served as Markdown (its URL with `.md`).
- **[OpenAPI 3.1 contract](https://api.spacecontext.app/v1/openapi.json)**, for code generation and validation. `GET https://api.spacecontext.app/v1` returns links to the contract, the docs, `llms.txt` and the MCP server.
- **MCP server** at `https://mcp.spacecontext.app/mcp` (Streamable HTTP, OAuth 2.1), with a [server card](https://mcp.spacecontext.app/.well-known/mcp/server-card.json) listing its tools, resources and prompts.
- **Agent Skill**: `npx spacecontext skill <space-id> --out ~/.claude/skills/<name>` writes any space as a skill folder (`SKILL.md`, `space.json`, `references/`). The folder tells the agent to treat its content as data, cite the area, and say "not documented" instead of guessing.

## Contributing

```bash
npm install
npm run check          # build, typecheck and test every package
```

Node 22 or later. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, the security invariants and how the contract and SDK types are regenerated. Bugs and requests: [issues](https://github.com/finikoslab/spacecontext/issues).

## License

[MIT](LICENSE) © Finikos S.r.l.
