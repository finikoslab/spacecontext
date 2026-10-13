---
title: 'TypeScript SDK'
description: 'The @spacecontext/sdk client for Node.js, Deno and Cloudflare Workers: one call from a video to the Space Document, reading, scanning, exports and errors.'
---

# TypeScript SDK

`@spacecontext/sdk` is a client for the API, typed from its OpenAPI contract. No runtime dependencies; it runs in Node.js 22.12+, Deno and Cloudflare Workers.

```bash
npm install @spacecontext/sdk
```

```ts
import { SpaceContext, SpaceContextError } from '@spacecontext/sdk';

const sc = new SpaceContext({ apiKey: process.env.SPACECONTEXT_API_KEY });
```

`apiKey` defaults to `SPACECONTEXT_API_KEY`, `baseUrl` to `SPACECONTEXT_BASE_URL` then the production API. `sc.mode` tells whether the key is `test` or `live`.

## One call

From a video to the space's document, following the analysis as it runs:

```ts
const { document, markdown } = await sc.scan('./flat.mp4', {
  name: 'Seaside flat',
  type: 'apartment',
  format: 'markdown',                       // also 'skill'; the document is always returned
  onProgress: (p) => console.log(p.type === 'scan' ? p.label : p.type),
});

console.log(document.items.length, 'items');
console.log(markdown);                      // one readable page of the whole space
```

`scan()` takes a path (a video, an image, or a folder of photos; Node only), a `Blob`/`File` with its type, `{ video, contentType }` or `{ frames: [...] }`. A video is MP4, MOV, M4V, 3GP, WebM or Matroska (`.mp4`, `.mov`, `.m4v`, `.3gp`, `.webm`, `.mkv`, or the types in `VIDEO_CONTENT_TYPES`), up to 4 GB and 10 minutes. `sc.limits()` reads the API's own limits from `GET /v1` (`{ maxVideoBytes, maxVideoSeconds, maxPhotos }`, kept for an hour; an API that does not state them takes 100 MB), and a bigger video is refused before anything is created (the CLI compresses it when ffmpeg is installed). When the limits cannot be read, `limits()` is `null` and nothing is guessed: the API decides when the scan is declared. A video from a path is read from disk as it uploads, never into memory. Pass `space: 'spc_…'` instead of `name` to scan an existing space again: the new scan is checked against the previous one. It creates the space, uploads, starts, streams the scan's events to `onProgress` (`space_created` with `spaceId`, `uploading`, `uploaded`, `started`, one `scan` per change of status or stage with its `stage` and `label`, `complete`) and returns `{ spaceId, scan, document }`, plus `markdown` or `skill` when asked. A scan that fails throws a `SpaceContextError` whose `code` is the scan's error (`FOOTAGE_UNUSABLE`, `ANALYSIS_EMPTY`…), with the scan in `details.scan`; its charge is refunded.

Other options: `externalId` (with `name`: the same id returns the same space), `language` (the language of the report: `en`, `it`, `es`, `fr`, `de`, `pt` or `nl`, default `en`, listed in `REPORT_LANGUAGES`; the narration can be in any language), `transcript` (with photos; videos are transcribed by the API), `recordedAt`, `device`, `timeoutMs` (default 20 minutes, then `TIMEOUT` while the scan goes on) and `signal`.

## Reading

```ts
for await (const space of sc.spaces.iterate()) console.log(space.id, space.name);

const document = await sc.spaces.get('spc_…');                     // Space Document
const items = document.items.filter((item) => item.category === 'appliance');

const { data } = await sc.search('spare light bulbs', { limit: 5 });
const answer = await sc.spaces.ask('spc_…', 'Is there a dishwasher?');
const diff = await sc.spaces.diff('spc_…', { from: 'scn_old…' });
const skill = await sc.spaces.skill('spc_…');                      // { name, files: [{ path, content }] }

const me = await sc.me();                                          // the account and the key's mode and scopes
const wallet = await sc.wallet();                                  // balance_cents, free scans left, scan_price_cents
const limits = await sc.limits();                                  // the largest and longest video, the most photos, on this API
const check = await sc.frames.check(bytes, 'image/jpeg', { spaceType: 'vehicle' }); // usable? which key locations? which area?
const profile = await sc.captureProfiles.get('vehicle');           // what to film for a type of space (sent without the key)
```

## Guided capture and verified evidence

```ts
import { fetchCaptureProfile, summarizeCoverage, summarizeVerification } from '@spacecontext/sdk';

const profile = await fetchCaptureProfile('boat', { language: 'it' }); // public: no key, no client
const coverage = summarizeCoverage(document, profile);  // seen, missingExpected, missingOptional
const evidence = summarizeVerification(document);       // verified, unconfirmed, notVisual, unchecked
```

`fetchCaptureProfiles()` and `fetchCaptureProfile(type)` read the [capture profiles](../guides/guided-capture.md) with no key (from `SPACECONTEXT_BASE_URL` or the production API). `summarizeCoverage` reads the document's `coverage.checklist`; with the type's profile it splits what was not filmed into the key locations usually there and those only "if there is one". `summarizeVerification` counts the records [checked again on their own photo](../guides/verified-evidence.md). `SPACE_TYPES` lists the eleven types of space.

## Scanning

```ts
import { describeScan, fileBody } from '@spacecontext/sdk';

const space = await sc.spaces.create({ name: 'Seaside flat', space_type: 'apartment' });

// Video: created, uploaded and started in one call. fileBody reads the file from disk as it
// uploads (a Blob, or a stream of its exact length from 4 GiB, which fs.openAsBlob miscounts).
const scan = await sc.scans.fromVideo(space.id, { data: await fileBody('flat.mp4'), contentType: 'video/mp4', language: 'en' });

// Or photos, in order:
// await sc.scans.fromFrames(space.id, [{ data: await fileBody('1.jpg'), contentType: 'image/jpeg', timestampMs: 0 }, …]);

const done = await sc.scans.wait(scan.id, { onProgress: (s) => console.log(s.status, s.stage) });
if (done.status !== 'complete') throw new Error(done.error?.message);

// Or every change as it happens, as an async iterator:
for await (const current of sc.scans.events(scan.id)) console.log(describeScan(current).label);
```

`wait` and `events` follow the API's event stream (`GET /scans/{id}/events`), reconnecting if it ends early or the connection drops. When no stream can be had (a proxy that does not stream, all 10 of the account's open streams in use, the stream failing), they poll `GET /scans/{id}` instead, every `intervalMs` (default 3 s) and less often, up to every 15 s, while nothing changes. At `timeoutMs` (default 20 minutes) they throw `TIMEOUT` with the last state in `details.scan`, even while the stream only sends pings, and close the stream. `describeScan(scan)` turns a status and stage into a label (`Looking at the frames`, `Extracting the context`, `Verifying the evidence`…).

If an upload fails, `fromVideo` and `fromFrames` cancel the scan (nothing is charged) and throw. The lower-level calls are there too: `scans.create`, `scans.uploadFrame`, `scans.uploadVideo`, `scans.start`, `scans.get`, `scans.cancel`.

## Exports

```ts
const page = await sc.spaces.markdown('spc_…');                 // one Markdown page, text
const skill = await sc.spaces.skill('spc_…');                   // { name, files: [{ path, content }] }
```

Both are built from exactly the document the key may read: a key without `spaces:sensitive` gets them redacted, and 409 `ENRICHMENT_PENDING` until the space is screened.

`sc.evidenceFrame(url)` downloads an evidence frame from a signed URL of the API (a document's `frames`, an answer's citations), without sending the key. It fetches nothing else: the frames of the demo space (test keys) are public files on `https://spacecontext.app/demo/brisbane/` and are refused with `INVALID_URL`; fetch those directly.

## Sign in from a tool

The CLI's `login` is in the SDK too, for any tool without a browser session:

```ts
import { deviceSignIn } from '@spacecontext/sdk';

const { api_key, user } = await deviceSignIn({
  name: 'My tool on this laptop',
  onCode: ({ userCode, verificationUrl }) => console.log(`Open ${verificationUrl} and enter ${userCode}`),
});
```

It asks the API for a code, shows it, and polls until the person approves it in the console; the key arrives here, never through the browser, and the code is never put in a link. `startDeviceSignIn()` and `waitForDeviceSignIn()` are the two halves. A `name` longer than 60 characters is cut; a poll that gets no answer is made again until the code expires, and every failure is a `SpaceContextError` (`NETWORK_ERROR` when the API cannot be reached). A live key that can scan needs a card on file: without one, the console asks the person to add it (nothing is charged) or to approve a key without `scans:write`.

## Errors

Every failure is a `SpaceContextError`:

```ts
try {
  await sc.spaces.ask('app_…', 'Where is the boiler?');
} catch (error) {
  if (error instanceof SpaceContextError) {
    error.status;      // HTTP status, 0 when there was no answer
    error.code;        // 'ENRICHMENT_PENDING', 'INSUFFICIENT_FUNDS', … or 'NETWORK_ERROR', 'TIMEOUT', 'FILE_READ_ERROR'
    error.requestId;   // quote it to support
    error.details;     // every field of the error, e.g. balance_cents
    error.retryAfter;  // seconds, from Retry-After
  }
}
```

See [all error codes](../api/errors.md).

## Retries and safety

| Option | Default | |
| --- | --- | --- |
| `maxRetries` | 2 | Retries of a request refused for load or lost on the network |
| `maxRetryDelayMs` | 60 000 | A `429` asking to wait longer is returned at once (daily limits) |
| `timeoutMs` | 60 000 | Per request; uploads have no timeout |
| `fetch` | global `fetch` | A custom fetch, for tests or proxies |

- `429 RATE_LIMIT_EXCEEDED` is retried after `Retry-After` (`SCANS_IN_PROGRESS`, ten scans running, is returned at once); `502`–`504` and network errors only for requests that are safe to repeat. Scan creation sends an `Idempotency-Key`, reused on retry; `cancel` and `delete` are never repeated after a network error or a `5xx`.
- The API key is sent only to the API's own origin and path: never to a storage upload URL, an evidence URL or another host. Redirects are never followed.

## Types

Every schema of the contract is exported: `SpaceDocument`, `SpaceSummary`, `Scan`, `SearchResults`, `SpaceAnswer`, `SkillBundle`, `SpaceDiff`, `Wallet`, `FrameCheck`, `CaptureProfile`, `SpaceVerification`, `KeyLocationKind`, and the raw `components`, `paths` and `operations` from the OpenAPI document; `ScanSource`, `ScanOptions`, `ScanProgress` and `ScanResult` describe `scan()`.
