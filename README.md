# Space Context — the context layer for the physical world

Your agents know your code, your documents and your calendar. They know nothing about the places you live and work in. **Film a space once, and your agent knows it**: every room, every item and where it is, what is broken, where the stopcock and the fuse box are, how the boiler works — with the original video frames as evidence.

This repository holds the open-source (MIT) tools to use Space Context from code and from AI assistants:

| Package | What it is |
| --- | --- |
| [`packages/sdk`](packages/sdk) — `@spacecontext/sdk` | TypeScript client for the REST API, generated from the OpenAPI spec |
| [`packages/cli`](packages/cli) — `spacecontext` | `npx spacecontext scan tour.mp4 --name "My flat"`, then search, ask, export a Skill |
| [`packages/mcp`](packages/mcp) — `@spacecontext/mcp` | Remote MCP server (Cloudflare Workers, OAuth): connect Claude or any MCP client to your spaces |
| [`openapi/openapi.json`](openapi/openapi.json) | The API contract |
| [`docs`](docs) | The documentation site (Docusaurus): docs.spacecontext.finikos.it |

The analysis pipeline itself (vision, fusion, the deep pass, the sensitive-value screening) runs in the Space Context API and is not part of this repository.

## What you get for a space

A **Space Document** (JSON, versioned schema): areas with type, level and condition; items with category, location, quantity, condition, brand/model, visible text and aliases; issues with severity and suggested action; key locations (water shut-off, electrical panel, boiler, router, extinguisher…); how-to instructions taken from the narration; facts (access, Wi-Fi, rules, contacts — sensitive ones redacted unless the key has `spaces:sensitive`); Q&A; and what the video did not cover. From it, the API derives:

- **Search** across all your spaces, in any language (`GET /v1/search`).
- **Answers with citations** (`POST /v1/spaces/{id}/ask`), saying "not documented" instead of guessing.
- **Comparisons** between two scans: items added, removed, moved, issues new or resolved.
- **Agent Skills**: a folder with `SKILL.md`, `space.json` and reference files, for any agent that reads skills; or the whole space as **one Markdown page** (`GET /v1/spaces/{id}/markdown`).
- **Real-time progress**: every scan is followed as an event stream (`GET /v1/scans/{id}/events`), by the SDK, the CLI and the MCP server.
- **Guided capture** (`POST /v1/frames/check`): one frame checked in about half a second while filming: usable or not, and which key locations (fuse box, stopcock, boiler, smoke detector…) it shows. Every scan runs the same check: unusable frames are left out, footage with nothing usable is refused before it is charged, and `coverage.checklist` says which key locations the recording did not film.

Text captured in a space is always treated as data: sentences addressed to an AI ("ignore your instructions…") are withheld before any model or agent reads them.

## Quick start

```bash
# 1. Create an API key in the console: https://spacecontext.finikos.it/developers/console
npx spacecontext login --test                # approve a code in the console: a free test key, the demo space
npx spacecontext check ./photos                 # usable frames, and the key locations still missing
npx spacecontext search "where is the stopcock?"
npx spacecontext scan tour.mp4 --name "Seaside flat"   # a live key analyses your video
npx spacecontext skill spc_… --out ~/.claude/skills/seaside-flat
```

```ts
import { SpaceContext } from '@spacecontext/sdk';

const sc = new SpaceContext(); // reads SPACECONTEXT_API_KEY
const { spaceId, document } = await sc.scan('./tour.mp4', { name: 'Seaside flat', onProgress: (p) => console.log(p.type) });
const answer = await sc.spaces.ask(spaceId, 'Where are the spare bulbs?');
const page = await sc.spaces.markdown(spaceId); // the whole space as one page
```

**MCP:** add `https://mcp.spacecontext.finikos.it/mcp` as a custom connector in Claude (or any MCP client that supports OAuth). You sign in with your Space Context email and choose whether the assistant may see sensitive values.

## Pricing and keys

- `sc_test_…` keys are free and unlimited: they return a hand-made demo space, never real data.
- `sc_live_…` keys: one free scan per account, then a prepaid wallet in USD (top up in the console). Reading spaces scanned with the iPhone app requires Space Context Pro.
- Keys are read-only by default for connectors; the console sets scopes and a monthly spending cap per key.

## Development

```bash
npm install
npm run check          # build, typecheck and test every package
npm run openapi:sync   # refresh openapi/openapi.json from the API (then: npm run generate -w @spacecontext/sdk)
```

Node 22 or later. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © Finikos S.r.l.
