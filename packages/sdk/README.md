# @spacecontext/sdk

TypeScript client for the [Space Context](https://spacecontext.app/developers/) API: turn a video of a space into structured context, then search it, ask it questions, compare scans and export it as an Agent Skill. No runtime dependencies; Node 22+, browsers, Deno, Cloudflare Workers.

```bash
npm install @spacecontext/sdk
```

```ts
import { openAsBlob } from 'node:fs';
import { SpaceContext, SpaceContextError } from '@spacecontext/sdk';

const sc = new SpaceContext({ apiKey: process.env.SPACECONTEXT_API_KEY });

// A video in, the space's document out: created, uploaded, analysed, followed live.
const { spaceId, document, markdown } = await sc.scan('./tour.mp4', {
  name: 'Seaside flat',
  type: 'apartment',
  format: 'markdown',
  onProgress: (p) => console.log(p.type === 'scan' ? p.label : p.type),
});

// Use it
const { data } = await sc.search('where is the stopcock?');
const answer = await sc.spaces.ask(spaceId, 'Is there a dishwasher?');
const skill = await sc.spaces.skill(spaceId); // { name, files: [{ path, content }] }
for await (const scan of sc.scans.events('scn_…')) console.log(scan.status, scan.stage); // real time

// While filming: is this frame usable, and which key locations does it show?
const check = await sc.frames.check(await openAsBlob('frame.jpg'), 'image/jpeg');

try {
  await sc.spaces.ask('app_…', 'Where is the boiler?');
} catch (error) {
  if (error instanceof SpaceContextError && error.code === 'ENRICHMENT_PENDING') {
    // a space scanned with the app is being screened for sensitive values: retry in a minute
  }
}
```

## Behaviour

- **Keys:** `sc_test_…` (free, demo data) or `sc_live_…`. Falls back to `SPACECONTEXT_API_KEY` and `SPACECONTEXT_BASE_URL`.
- **Errors:** every failure is a `SpaceContextError` with `status`, a stable `code` (branch on it), `requestId` and `details`. `NETWORK_ERROR` and `TIMEOUT` come from the client.
- **Retries:** a `429` is retried after `Retry-After` when the wait is within `maxRetryDelayMs` (default 60 s), otherwise returned at once; `502–504` and network errors only for requests that are safe to repeat (not `cancel` nor `delete`). Scan creation sends an `Idempotency-Key`, reused on retry. `maxRetries` defaults to 2.
- **One call:** `sc.scan(source, { name | space, format, onProgress })` takes a path (video, image or folder of photos; Node only), a `Blob`/`File` with its type, `{ video, contentType }` or `{ frames }`, and returns `{ spaceId, scan, document }` plus `markdown` or `skill`. The steps are also available one by one (`spaces.create`, `scans.fromVideo`, `scans.fromFrames`, `scans.wait`, `scans.events`).
- **Real time:** `scans.events(id)` and `scans.wait(id)` follow the API's event stream, reconnecting until the deadline if it ends early or the connection drops; they poll only where streaming is not possible.
- **Uploads:** pass a `Blob` (`fs.openAsBlob` streams from disk), `ArrayBuffer` or `Uint8Array`. Videos go straight to storage when the API offers a signed URL; the API key is only ever sent to the API itself.
- **Redirects** are never followed.
- **Evidence frames:** `evidenceFrame(url)` downloads a frame from a signed URL of this API, without sending the key. The demo space's frames (test keys) are public files on `https://spacecontext.app/demo/brisbane/`: it refuses them (`INVALID_URL`); fetch them directly.
- **Types:** every schema of the [OpenAPI spec](https://api.spacecontext.app/v1/openapi.json) is exported (`SpaceDocument`, `Scan`, `SearchResults`, … and `components`).

MIT © Finikos S.r.l.
