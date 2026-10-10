# @spacecontext/sdk

[![npm](https://img.shields.io/npm/v/@spacecontext/sdk?logo=npm)](https://www.npmjs.com/package/@spacecontext/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/finikoslab/spacecontext/blob/HEAD/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Types included](https://img.shields.io/badge/types-included-3178C6?logo=typescript&logoColor=white)](https://spacecontext.app/developers/docs/sdk/typescript/)
[![Docs](https://img.shields.io/badge/docs-spacecontext.app-7C3AED)](https://spacecontext.app/developers/docs/sdk/typescript/)

The TypeScript client for [Space Context](https://spacecontext.app/developers/), the context layer for the physical world. Turn a video of a space into a structured **Space Document**, then read it, search it, ask it questions, compare scans and export it as an Agent Skill or a Markdown page.

- **One call** from a video (or a folder of photos) to the document, with progress reported as the analysis runs.
- **Typed from the [OpenAPI contract](https://api.spacecontext.app/v1/openapi.json)**: every schema is exported.
- **No runtime dependencies.** Runs in Node.js 22+, Deno, Cloudflare Workers and browsers.

## Install

```bash
npm install @spacecontext/sdk
```

You need an API key. A **test key** (`sc_test_…`) is free and unlimited, and reads the demo space `spc_demo`: two real scans of an apartment in Brisbane. Create one in the [console](https://spacecontext.app/developers/console/), or run `npx spacecontext login --test`.

## Quick start

```ts
import { SpaceContext } from '@spacecontext/sdk';

const sc = new SpaceContext(); // apiKey defaults to SPACECONTEXT_API_KEY

const answer = await sc.spaces.ask('spc_demo', 'Where is the fuse box?');
console.log(answer.answer);                      // a short answer from the space's records
console.log(answer.citations.map((c) => c.area)); // the records it cites, with evidence frames

const document = await sc.spaces.get('spc_demo'); // the whole Space Document
for (const location of document.key_locations) console.log(`${location.label}: ${location.location}`);
```

## From a video to a document, in one call

```ts
const { spaceId, document, markdown } = await sc.scan('./flat.mp4', {
  name: 'Seaside flat',
  type: 'apartment',
  format: 'markdown', // or 'skill'; the document is always returned
  onProgress: (p) => console.log(p.type === 'scan' ? p.label : p.type),
});

console.log(document.stats.items, 'items');
```

`scan()` accepts a path (a video, an image or a folder of photos; Node only), a `Blob` or `File` with its type, `{ video, contentType }` or `{ frames: [...] }`. Pass `space: 'spc_…'` instead of `name` to scan an existing space again: the new scan is checked against the previous one. It creates the space, uploads, starts the scan, follows its event stream and returns `{ spaceId, scan, document }`, plus `markdown` or `skill` if you asked for one.

A scan that fails throws a `SpaceContextError` whose `code` is the scan's own error (`FOOTAGE_UNUSABLE`, `ANALYSIS_EMPTY`…), and its charge is refunded. With a test key the whole flow runs for free and returns the demo content under the name you chose. With a live key, the account's free scan is used first (a new account has one, one free scan per card) and each scan after that costs US$1.00 from your prepaid balance ([Billing](https://spacecontext.app/developers/docs/account/billing/)).

## Methods

Each method maps to one documented operation, and the last argument is always optional `{ signal }`.

| Method | |
| --- | --- |
| `sc.spaces.list({ limit, cursor, source })`, `sc.spaces.iterate({ source })` | One page of spaces, or every space (`for await`) |
| `sc.spaces.get(id, { include })` | The current Space Document (`include: 'transcript'` needs `spaces:sensitive`) |
| `sc.spaces.create({ name, space_type })`, `sc.spaces.delete(id)` | Create or delete a space made through the API |
| `sc.spaces.scans(id)`, `sc.spaces.scan(id, scanId)` | The scan history, and a past scan as recorded |
| `sc.spaces.ask(id, question)` | A short answer with citations, or `documented: false` |
| `sc.search(query, { spaceId, limit })` | Records across every space, in any language |
| `sc.spaces.diff(id, { from, to })` | What changed between two scans |
| `sc.spaces.skill(id)`, `sc.spaces.markdown(id)` | The space as an Agent Skill (`{ name, files }`) or one Markdown page |
| `sc.scans.fromVideo(spaceId, { data, contentType })`, `sc.scans.fromFrames(spaceId, frames)` | Create, upload and start a scan; cancelled if an upload fails |
| `sc.scans.events(id)`, `sc.scans.wait(id, { onProgress })` | Follow a scan live (async iterator), or wait for its final state |
| `sc.scans.create`, `uploadFrame`, `uploadVideo`, `start`, `get`, `cancel` | The scan steps one by one |
| `sc.frames.check(bytes, 'image/jpeg')` | Is this frame usable, and which key locations does it show (guided capture) |
| `sc.me()`, `sc.wallet()` | The key's account, mode and scopes; the balance, free scans left and price |
| `sc.evidenceFrame(url)` | Download an evidence frame from a signed URL of the API, without sending the key |

`describeScan(scan)` turns a status and stage into a label ("Looking at the frames", "Extracting the context"…). The demo space's frames are public files on `https://spacecontext.app/demo/brisbane/`: fetch them directly, as `evidenceFrame` refuses them with `INVALID_URL`.

## Sign in from a tool

The CLI's `login` is in the SDK too, for any tool that has no key yet:

```ts
import { deviceSignIn } from '@spacecontext/sdk';

const { api_key } = await deviceSignIn({
  name: 'My tool on this laptop',
  onCode: ({ userCode, verificationUrl }) => console.log(`Open ${verificationUrl} and enter ${userCode}`),
});
```

The person types the code in the console and approves it, and the key arrives in your tool. A live key that can scan needs a card on file: without one, the console asks the person to add it (nothing is charged) or to approve a key without `scans:write`. The key never travels through the browser, and the code is never put in a link. `startDeviceSignIn()` and `waitForDeviceSignIn()` are the two halves.

## Errors

Every failure is a `SpaceContextError`:

```ts
import { SpaceContextError } from '@spacecontext/sdk';

try {
  await sc.spaces.ask('app_…', 'Where is the boiler?');
} catch (error) {
  if (error instanceof SpaceContextError && error.code === 'ENRICHMENT_PENDING') {
    // a space scanned with the iPhone app is being screened for sensitive values: retry in a minute
  }
}
```

`status` is the HTTP status (0 when there was no answer), `code` is stable and safe to branch on (`NETWORK_ERROR` and `TIMEOUT` come from the client), `requestId` is what to quote to support, `details` carries every field of the error, and `retryAfter` is in seconds. See [all error codes](https://spacecontext.app/developers/docs/api/errors/).

## Options

```ts
new SpaceContext({ apiKey, baseUrl, maxRetries, maxRetryDelayMs, timeoutMs, fetch });
```

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `SPACECONTEXT_API_KEY` | `sc_live_…` or `sc_test_…`; `sc.mode` says which |
| `baseUrl` | `SPACECONTEXT_BASE_URL`, then `https://api.spacecontext.app/v1` | Must be https (except localhost) |
| `maxRetries` | 2 | Retries of a request refused for load or lost on the network |
| `maxRetryDelayMs` | 60 000 | A `429` asking for a longer wait (daily limits) is returned at once |
| `timeoutMs` | 60 000 | Per request; uploads have no timeout |
| `fetch` | global `fetch` | A custom fetch, for tests or proxies |

## Behaviour and safety

- **Retries**: a `429` is retried after `Retry-After`. `502`–`504` and network errors are retried only for requests that are safe to repeat. Scan creation sends an `Idempotency-Key`, reused on retry, and `cancel` and `delete` are never repeated.
- **Following a scan**: `scans.events`, `scans.wait` and `scan()` follow the event stream and reconnect when it ends early. When no stream can be had (a proxy that does not stream, all 10 of the account's open streams in use, the stream failing), they poll `GET /scans/{id}` instead, every `intervalMs` (default 3 s) and less often, up to every 15 s, while nothing changes. At `timeoutMs` (default 20 minutes) they throw `TIMEOUT` with the last state in `details.scan`, even while the stream only sends pings, and close the stream.
- **The key stays with the API**: it is sent only to the API's own origin and path, never to a storage upload URL, an evidence URL or another host. Redirects are never followed.
- **Uploads**: pass a `Blob` (in Node, `fs.openAsBlob` streams a file from disk), an `ArrayBuffer` or a `Uint8Array`. Videos go straight to storage when the API offers a signed URL.
- **Browsers**: the API is meant for servers, scripts and agents, and accepts browser calls only from Space Context's own sites. Keep keys out of web pages.
- **Types**: `SpaceDocument`, `SpaceSummary`, `Scan`, `SearchResults`, `SpaceAnswer`, `SkillBundle`, `SpaceDiff`, `Wallet`, `FrameCheck` and the raw `components`, `paths` and `operations` of the contract.

## Links

[SDK guide](https://spacecontext.app/developers/docs/sdk/typescript/) · [Quickstart](https://spacecontext.app/developers/docs/quickstart/) · [The Space Document](https://spacecontext.app/developers/docs/api/space-document/) · [API reference](https://spacecontext.app/developers/docs/api/reference/) · [Limits](https://spacecontext.app/developers/docs/limits/) · [Source](https://github.com/finikoslab/spacecontext/tree/HEAD/packages/sdk)

[MIT](https://github.com/finikoslab/spacecontext/blob/HEAD/LICENSE) © Finikos S.r.l.
