import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpaceContext } from '../src/index.js';

// Against a real deployment, with a TEST key (free, the demo space): every
// operation a developer meets in the first hour, end to end. Skipped unless
//   SPACECONTEXT_SMOKE_KEY=sc_test_… SPACECONTEXT_SMOKE_BASE_URL=https://…/v1 npx vitest run test/smoke.test.ts
// It is the check to run after each deploy, from the staging to the production host.

const KEY = process.env.SPACECONTEXT_SMOKE_KEY;
const BASE = process.env.SPACECONTEXT_SMOKE_BASE_URL;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

describe.skipIf(!KEY || !BASE)('the API, through the SDK, on a real host', () => {
  const sc = () => new SpaceContext({ apiKey: KEY!, baseUrl: BASE! });

  it('knows who holds the key, and what the key may spend', async () => {
    const me = await sc().me();
    expect(me.key.mode).toBe('test');
    expect(me.key.scopes).toContain('spaces:read');
    const wallet = await sc().wallet();
    expect(wallet.currency).toBe('usd');
    expect(wallet.scan_price_cents).toBeGreaterThan(0);
  }, 30_000);

  it('reads the demo space in every form', async () => {
    const api = sc();
    const spaces: string[] = [];
    for await (const space of api.spaces.iterate()) spaces.push(space.id);
    expect(spaces).toContain('spc_demo');

    const document = await api.spaces.get('spc_demo');
    expect(document.space.name).toBe('Brisbane apartment');
    expect(document.stats.items).toBeGreaterThan(30);
    expect(document.enrichment).toMatchObject({ level: 'deep', status: 'complete' });
    expect(document.frames.some((frame) => frame.url)).toBe(true);
    // The Wi-Fi password of the demo: read only with spaces:sensitive, never without.
    const sensitive = (await api.me()).key.scopes.includes('spaces:sensitive');
    const text = JSON.stringify(document).toLowerCase();
    if (sensitive) expect(text).toContain('sunny balcony');
    else expect(text).not.toContain('sunny balcony');

    const markdown = await api.spaces.markdown('spc_demo');
    expect(markdown.startsWith('# Brisbane apartment')).toBe(true);
    const skill = await api.spaces.skill('spc_demo');
    expect(skill.files.map((file) => file.path)).toContain('SKILL.md');

    const scans = await api.spaces.scans('spc_demo');
    expect(scans.data.length).toBe(2);
    const diff = await api.spaces.diff('spc_demo', { from: scans.data[1]!.id });
    expect(diff.linked).toBe(true);
    expect(diff.items.not_seen).toEqual([]);
  }, 60_000);

  it('answers questions and searches, without a model for a test key', async () => {
    const api = sc();
    const answer = await api.spaces.ask('spc_demo', 'where is the fuse box?');
    expect(answer.documented).toBe(true);
    expect(answer.answer.toLowerCase()).toContain('hallway cupboard');
    const italian = await api.spaces.ask('spc_demo', "dov'è il frigorifero?");
    expect(italian.documented).toBe(true);
    const results = await api.search('fuse box');
    expect(results.data[0]?.space_id).toBe('spc_demo');
  }, 60_000);

  it('runs the whole scan flow from a folder of photos, live, in one call', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sc-smoke-'));
    try {
      await writeFile(path.join(directory, 'frame-1.jpg'), JPEG);
      await writeFile(path.join(directory, 'frame-2.jpg'), JPEG);
      const stages: string[] = [];
      const { scan, document, markdown } = await sc().scan(directory, {
        name: `Smoke ${new Date().toISOString()}`,
        type: 'apartment',
        format: 'markdown',
        onProgress: (p) => stages.push(p.type === 'scan' ? `scan:${p.stage}` : p.type),
      });
      expect(scan.status).toBe('complete');
      expect(scan.livemode).toBe(false);
      expect(stages[0]).toBe('space_created');
      expect(stages.at(-1)).toBe('complete');
      expect(document.stats.items).toBeGreaterThan(0);
      expect(markdown).toContain('# Smoke');
      // The events stream of a finished scan ends at once with its final state.
      const seen: string[] = [];
      for await (const current of sc().scans.events(scan.id)) seen.push(current.status);
      expect(seen).toEqual(['complete']);
      await sc().spaces.delete(document.space.id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('checks a frame while filming', async () => {
    const check = await sc().frames.check(JPEG, 'image/jpeg');
    expect(typeof check.usable).toBe('boolean');
    expect(check.key_locations.length).toBeGreaterThan(0);
  }, 30_000);
});
