# @spacecontext/sdk

TypeScript client for the [Space Context](https://spacecontext.finikos.it/developers) API: turn a video of a space into structured context, then search it, ask it questions, compare scans and export it as an Agent Skill. No runtime dependencies; Node 22+, browsers, Deno, Cloudflare Workers.

```bash
npm install @spacecontext/sdk
```

```ts
import { SpaceContext, SpaceContextError } from '@spacecontext/sdk';
import { openAsBlob } from 'node:fs';

const sc = new SpaceContext({ apiKey: process.env.SPACECONTEXT_API_KEY });

// Scan a video (created, uploaded and started; the free scan first, then the wallet)
const space = await sc.spaces.create({ name: 'Seaside flat', space_type: 'apartment' });
const scan = await sc.scans.fromVideo(space.id, { data: await openAsBlob('tour.mp4'), contentType: 'video/mp4' });
await sc.scans.wait(scan.id, { onProgress: (s) => console.log(s.status, s.stage) });

// Use it
const document = await sc.spaces.get(space.id);
const { data } = await sc.search('where is the stopcock?');
const answer = await sc.spaces.ask(space.id, 'Is there a dishwasher?');
const skill = await sc.spaces.skill(space.id); // { name, files: [{ path, content }] }

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
- **Uploads:** pass a `Blob` (`fs.openAsBlob` streams from disk), `ArrayBuffer` or `Uint8Array`. Videos go straight to storage when the API offers a signed URL; the API key is only ever sent to the API itself.
- **Redirects** are never followed.
- **Types:** every schema of the [OpenAPI spec](../../openapi/openapi.json) is exported (`SpaceDocument`, `Scan`, `SearchResults`, … and `components`).

MIT © Finikos S.r.l.
