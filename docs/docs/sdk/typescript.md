---
title: 'TypeScript SDK'
description: 'The @spacecontext/sdk client for Node, Deno and Cloudflare Workers.'
---

# TypeScript SDK

`@spacecontext/sdk` is a typed client for the API, generated from its OpenAPI contract. No runtime dependencies; it runs in Node.js 22+, Deno and Cloudflare Workers.

```bash
npm install @spacecontext/sdk
```

```ts
import { SpaceContext, SpaceContextError } from '@spacecontext/sdk';

const sc = new SpaceContext({ apiKey: process.env.SPACECONTEXT_API_KEY });
```

`apiKey` defaults to `SPACECONTEXT_API_KEY`, `baseUrl` to `SPACECONTEXT_BASE_URL` then the production API. `sc.mode` tells whether the key is `test` or `live`.

## Reading

```ts
for await (const space of sc.spaces.iterate()) console.log(space.id, space.name);

const document = await sc.spaces.get('spc_…');                     // Space Document
const items = document.items.filter((item) => item.category === 'appliance');

const { data } = await sc.search('spare light bulbs', { limit: 5 });
const answer = await sc.spaces.ask('spc_…', 'Is there a dishwasher?');
const diff = await sc.spaces.diff('spc_…', { from: 'scn_old…' });
const skill = await sc.spaces.skill('spc_…');                      // { name, files: [{ path, content }] }
```

## Scanning

```ts
import { openAsBlob } from 'node:fs';

const space = await sc.spaces.create({ name: 'Seaside flat', space_type: 'apartment' });

// Video: created, uploaded and started in one call. The file is streamed from disk.
const scan = await sc.scans.fromVideo(space.id, { data: await openAsBlob('flat.mp4'), contentType: 'video/mp4', language: 'en' });

// Or photos, in order:
// await sc.scans.fromFrames(space.id, [{ data: await openAsBlob('1.jpg'), contentType: 'image/jpeg', timestampMs: 0 }, …]);

const done = await sc.scans.wait(scan.id, { onProgress: (s) => console.log(s.status, s.stage) });
if (done.status !== 'complete') throw new Error(done.error?.message);
```

If an upload fails, `fromVideo` and `fromFrames` cancel the scan (nothing is charged) and throw. The lower-level calls are there too: `scans.create`, `scans.uploadFrame`, `scans.uploadVideo`, `scans.start`, `scans.get`, `scans.cancel`.

## Errors

Every failure is a `SpaceContextError`:

```ts
try {
  await sc.spaces.ask('app_…', 'Where is the boiler?');
} catch (error) {
  if (error instanceof SpaceContextError) {
    error.status;      // HTTP status, 0 when there was no answer
    error.code;        // 'ENRICHMENT_PENDING', 'INSUFFICIENT_FUNDS', … or 'NETWORK_ERROR', 'TIMEOUT'
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

- `429` is retried after `Retry-After`; `502`–`504` and network errors only for requests that are safe to repeat. Scan creation sends an `Idempotency-Key`, reused on retry; `cancel` and `delete` are never repeated.
- The API key is sent only to the API's own origin and path: never to a storage upload URL, an evidence URL or another host. Redirects are never followed.

## Types

Every schema of the contract is exported: `SpaceDocument`, `SpaceSummary`, `Scan`, `SearchResults`, `SpaceAnswer`, `SkillBundle`, `SpaceDiff`, `Wallet`, and the raw `components`, `paths` and `operations` from the OpenAPI document.
