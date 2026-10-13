import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.js';

/** Guided capture (checklist, check --type) and verified evidence in the CLI's output. */

const KEY = 'sc_live_clitestkey123';
const BASE = 'https://api.example.test/v1';
const SPACE_ID = `spc_${'d'.repeat(32)}`;
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

type Call = { method: string; path: string; search: URLSearchParams; headers: Headers };
type Route = (call: Call) => Response | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'spacecontext-capture-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function harness(routes: Route[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = { method: init.method ?? 'GET', path: url.pathname.replace(/^\/v1/, ''), search: url.searchParams, headers: new Headers(init.headers) };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    return json({ error: { code: 'NOT_FOUND', message: `no route for ${call.method} ${call.path}`, request_id: 'req_test' } }, 404);
  }) as typeof globalThis.fetch;
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: { SPACECONTEXT_CONFIG_DIR: path.join(directory, 'config'), SPACECONTEXT_BASE_URL: BASE, ...env },
    cwd: directory,
    prompt: null,
    fetch,
  };
  return { io, calls, stdout: () => out.join(''), stderr: () => err.join('') };
}

const VEHICLE = {
  object: 'capture_profile',
  space_type: 'vehicle',
  language: 'en',
  key_locations: [
    { kind: 'identification_plate', label: 'Identification plate', hint: 'The VIN plate, close enough to read', expected: true },
    { kind: 'instrument_panel', label: 'Dashboard', hint: 'With the odometer lit', expected: true },
    { kind: 'engine_bay', label: 'Engine bay', hint: 'Bonnet open', expected: true },
    { kind: 'spare_wheel', label: 'Spare wheel', hint: 'In the boot, with the jack', expected: false },
  ],
  areas: [
    { value: 'interior_front', label: 'Front seats and dashboard' },
    { value: 'trunk', label: 'Boot' },
  ],
};
const profiles: Route = (call) => {
  if (call.method !== 'GET') return undefined;
  if (call.path === '/capture-profiles/vehicle') return json({ ...VEHICLE, language: call.search.get('language') ?? 'en' });
  if (call.path === '/capture-profiles') return json({ object: 'list', data: [VEHICLE, { ...VEHICLE, space_type: 'boat', key_locations: VEHICLE.key_locations.slice(0, 1) }] });
  return undefined;
};

describe('checklist', () => {
  it('prints what to film for a type of space, with no key and without sending one', async () => {
    const h = harness([profiles]);
    expect(await main(['checklist', '--type', 'vehicle'], h.io), h.stderr()).toBe(0);
    const out = h.stdout();
    expect(out).toContain('What to film: vehicle');
    expect(out).toContain('Usually there\n  Identification plate\n    The VIN plate, close enough to read\n  Dashboard');
    expect(out).toContain('If there is one\n  Spare wheel\n    In the boot, with the jack');
    expect(out).toContain('Areas\n  Front seats and dashboard, Boot');
    expect(h.calls[0]!.path).toBe('/capture-profiles/vehicle');
    expect(h.calls[0]!.search.get('language')).toBe('en');
    expect(h.calls.every((call) => call.headers.get('authorization') === null)).toBe(true);
  });

  it('lists every type, prints JSON as the API sent it, and takes a language', async () => {
    const h = harness([profiles]);
    expect(await main(['checklist'], h.io)).toBe(0);
    expect(h.stdout()).toMatch(/TYPE\s+KEY LOCATIONS TO FILM/);
    expect(h.stdout()).toMatch(/vehicle\s+Identification plate, Dashboard, Engine bay, Spare wheel/);
    expect(h.stdout()).toContain('boat');

    const j = harness([profiles]);
    expect(await main(['checklist', '--type', 'vehicle', '--language', 'it', '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.stdout())).toMatchObject({ space_type: 'vehicle', language: 'it' });
    expect(j.calls[0]!.search.get('language')).toBe('it');
  });

  it('refuses an unknown type, language or argument', async () => {
    const h = harness([profiles]);
    expect(await main(['checklist', '--type', 'castle'], h.io)).toBe(2);
    expect(h.stderr()).toContain('--type must be one of');
    expect(await main(['checklist', '--language', 'xx'], h.io)).toBe(2);
    expect(await main(['checklist', 'vehicle'], h.io)).toBe(2);
    expect(await main(['checklist', '--space', SPACE_ID], h.io)).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('prints labels and hints without the controls a terminal acts on', async () => {
    const hostile = { ...VEHICLE, key_locations: [{ kind: 'engine_bay', label: 'Engine\u001b]52;c;cGF5\u0007 bay‮', hint: 'Open\u009b2J it', expected: true }] };
    const h = harness([(call) => (call.path === '/capture-profiles/vehicle' ? json(hostile) : undefined)]);
    expect(await main(['checklist', '--type', 'vehicle'], h.io)).toBe(0);
    expect(h.stdout()).not.toMatch(UNSAFE);
    const j = harness([(call) => (call.path === '/capture-profiles/vehicle' ? json(hostile) : undefined)]);
    expect(await main(['checklist', '--type', 'vehicle', '--json'], j.io)).toBe(0);
    expect(j.stdout()).not.toMatch(UNSAFE);
    expect(JSON.parse(j.stdout()).key_locations[0].label).toBe(hostile.key_locations[0]!.label);
  });

  it('reads the profiles from the API of the saved key, never sending the key', async () => {
    const h = harness([profiles], { SPACECONTEXT_BASE_URL: '' });
    await mkdir(path.join(directory, 'config'), { recursive: true });
    await writeFile(path.join(directory, 'config', 'config.json'), JSON.stringify({ apiKey: KEY, baseUrl: BASE }), { mode: 0o600 });
    expect(await main(['checklist', '--type', 'vehicle'], h.io), h.stderr()).toBe(0);
    expect(h.calls[0]!.headers.get('authorization')).toBeNull();
  });
});

describe('check --type', () => {
  it('checks with the type of space: its key locations by name, the area, what is usually there and missing', async () => {
    const shots = path.join(directory, 'car');
    await mkdir(shots);
    await writeFile(path.join(shots, 'a-dash.jpg'), new Uint8Array([0xff, 0xd8, 1]));
    await writeFile(path.join(shots, 'b-boot.jpg'), new Uint8Array([0xff, 0xd8, 2]));
    let n = 0;
    const checks: Route = (call) => {
      if (call.method !== 'POST' || call.path !== '/frames/check') return undefined;
      expect(call.search.get('space_type')).toBe('vehicle');
      n += 1;
      return json({
        object: 'frame_check',
        livemode: true,
        space_type: 'vehicle',
        usable: true,
        quality: { score: 2.2, level: 'good' },
        shows_space: 0.98,
        area: n === 1 ? { value: 'interior_front', probability: 0.9 } : { value: 'trunk', probability: 0.4 },
        key_locations: VEHICLE.key_locations.map((entry) => ({ kind: entry.kind, probability: n === 1 && entry.kind === 'instrument_panel' ? 0.95 : 0.1, seen: n === 1 && entry.kind === 'instrument_panel' })),
      });
    };
    const h = harness([profiles, checks], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['check', 'car', '--type', 'vehicle'], h.io), h.stderr()).toBe(0);
    const out = h.stdout();
    expect(out).toMatch(/FILE\s+USABLE\s+QUALITY\s+AREA\s+SHOWS/);
    expect(out).toMatch(/a-dash\.jpg\s+✓ yes\s+good, 2\.20\s+Front seats and dashboard\s+Dashboard/);
    // An area under 0.6 is not shown.
    expect(out).toMatch(/b-boot\.jpg\s+✓ yes\s+good, 2\.20\s+—/);
    expect(out).toContain('Seen: Dashboard (a-dash.jpg)');
    expect(out).toContain('Not seen yet, usually there: Identification plate, Engine bay.');
    expect(out).toContain('Not seen yet, if there is one: Spare wheel.');
    expect(await main(['check', 'car', '--type', 'castle'], h.io)).toBe(2);
  });
});

describe('space: coverage by profile and verified evidence', () => {
  const v = (status: 'verified' | 'unconfirmed' | 'not_visual' | null) =>
    status ? { status, probability: status === 'not_visual' ? null : status === 'verified' ? 0.95 : 0.3, frame_id: status === 'not_visual' ? null : 'frame-1' } : null;
  const document = {
    object: 'space_document',
    space: { id: SPACE_ID, source: 'api', name: 'Company car', space_type: 'vehicle' },
    scan: { id: 'scn_1', analyzed_at: '2026-10-13T10:00:00.000Z' },
    enrichment: { level: 'deep', status: 'complete' },
    summary: null,
    stats: { areas: 1, items: 3, issues: 1, key_locations: 1, facts: 0 },
    areas: [{ id: 'area_1', name: 'Cabin' }],
    items: [
      { id: 'itm_1', area_id: 'area_1', name: 'Seats', verification: v('verified') },
      { id: 'itm_2', area_id: 'area_1', name: 'Mats', verification: v('verified') },
      { id: 'itm_3', area_id: 'area_1', name: 'Phone holder', verification: v('not_visual') },
    ],
    issues: [{ id: 'iss_1', title: 'Scratched door', severity: 'low', verification: v('unconfirmed') }],
    key_locations: [{ id: 'kl_1', kind: 'instrument_panel', label: 'Dashboard', location: 'Front', verification: v('verified') }],
    coverage: {
      warnings: [],
      not_documented: [],
      checklist: [
        { kind: 'identification_plate', seen: false, probability: 0.1, evidence: [] },
        { kind: 'instrument_panel', seen: true, probability: 0.97, evidence: [] },
        { kind: 'engine_bay', seen: true, probability: 0.9, evidence: [] },
        { kind: 'spare_wheel', seen: false, probability: 0.0, evidence: [] },
      ],
    },
  };

  it('splits what was not filmed by the profile, and says how much was verified on its photo', async () => {
    const h = harness([profiles, (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(document) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID], h.io), h.stderr()).toBe(0);
    const out = h.stdout();
    expect(out).toContain('Key locations filmed: Dashboard, Engine bay\nNot filmed, usually there: Identification plate\nNot filmed, if there is one: Spare wheel');
    expect(out).toContain('Evidence: 3 of 5 records verified on their photo · 1 unconfirmed · 1 not visual (from the narration, or a fault)');
    expect(out).toContain('Scratched door (unconfirmed on its photo)');
    // The profile is read without the key.
    const profileCall = h.calls.find((call) => call.path === '/capture-profiles/vehicle')!;
    expect(profileCall.headers.get('authorization')).toBeNull();
  });

  it('falls back to one list when the profile cannot be read, and says nothing of verification on older documents', async () => {
    const older = { ...document, items: document.items.map((item) => ({ ...item, verification: null })), issues: [], key_locations: [] };
    const h = harness([(call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(older) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID], h.io), h.stderr()).toBe(0);
    expect(h.stdout()).toContain('Key locations filmed: instrument panel, engine bay');
    expect(h.stdout()).toContain('Not filmed: identification plate, spare wheel');
    expect(h.stdout()).not.toContain('Evidence:');
  });

  it('keeps --json as the API sent it, without reading the profile', async () => {
    const h = harness([profiles, (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(document) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID, '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.stdout()).items[0].verification).toEqual({ status: 'verified', probability: 0.95, frame_id: 'frame-1' });
    expect(h.calls.some((call) => call.path.startsWith('/capture-profiles'))).toBe(false);
  });
});
