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
    expect(h.stdout()).toContain('vehicle\n  Usually there: Identification plate, Dashboard, Engine bay\n  If there is one: Spare wheel');
    expect(h.stdout()).toContain('boat\n  Usually there: Identification plate');

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

describe('review: hostile values, colourless output, the API of the key, older APIs', () => {
  const HOSTILE_KIND = 'engine\u001b]52;c;cGF5\u0007_bay‮';
  const hostileCheck = (spaceType: string | null) =>
    json({
      object: 'frame_check',
      livemode: true,
      space_type: spaceType,
      usable: true,
      quality: { score: 2, level: 'good\u001b[2J' },
      shows_space: 0.97,
      area: spaceType ? { value: 'boot\u009b31m⁦', probability: 0.9 } : null,
      key_locations: [
        { kind: HOSTILE_KIND, probability: 0.95, seen: true },
        { kind: `spare\u001b[H_wheel`, probability: 0.1, seen: false },
      ],
    });

  async function onePhoto(): Promise<void> {
    await mkdir(path.join(directory, 'car'), { recursive: true });
    await writeFile(path.join(directory, 'car', 'a.jpg'), new Uint8Array([0xff, 0xd8, 1]));
  }

  it('check never prints the controls hidden in kinds, areas or labels, without --type', async () => {
    await onePhoto();
    const h = harness([(call) => (call.path === '/frames/check' ? hostileCheck(null) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['check', 'car'], h.io), h.stderr()).toBe(0);
    expect(h.stdout()).not.toMatch(UNSAFE);
    expect(h.stdout()).toContain('Seen: engine]52;c;cGF5 bay (a.jpg)');
    expect(h.stdout()).toContain('Not seen yet: spare[H wheel.');
  });

  it('check --type never prints them either, from the profile or the answer', async () => {
    await onePhoto();
    const profile = { ...VEHICLE, key_locations: [{ kind: HOSTILE_KIND, label: 'Engine\u001b]0;pwn\u0007 bay‮', hint: 'x', expected: true }], areas: [{ value: 'trunk', label: 'Boot\u009b2J' }] };
    const h = harness([
      (call) => (call.path === '/capture-profiles/vehicle' ? json(profile) : undefined),
      (call) => (call.path === '/frames/check' ? hostileCheck('vehicle') : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['check', 'car', '--type', 'vehicle'], h.io), h.stderr()).toBe(0);
    expect(h.stdout()).not.toMatch(UNSAFE);
    expect(h.stderr()).not.toMatch(UNSAFE);
    expect(h.stdout()).toContain('Engine]0;pwn bay');
    expect(h.stdout()).toContain('boot31m');
  });

  it('check --type says so when the API ignored the type (an API older than the CLI)', async () => {
    await onePhoto();
    const h = harness([profiles, (call) => (call.path === '/frames/check' ? json({ object: 'frame_check', livemode: true, usable: true, quality: { score: 2, level: 'good' }, shows_space: 0.9, key_locations: [{ kind: 'electrical_panel', probability: 0.9, seen: true }] }) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['check', 'car', '--type', 'vehicle'], h.io), h.stderr()).toBe(0);
    expect(h.stderr()).toContain('The API did not check for a vehicle (it may be older than this CLI)');
    expect(h.stdout()).not.toContain('AREA');
    expect(h.stdout()).toContain('Seen: electrical panel (a.jpg)');
  });

  it('checklist without --type says "usually there" and "if there is one" in words, never cut, without colour', async () => {
    const long = { ...VEHICLE, key_locations: [...VEHICLE.key_locations, { kind: 'first_aid', label: 'A first-aid kit with a very long label that a narrow table would cut', hint: 'h', expected: false }] };
    const h = harness([(call) => (call.path === '/capture-profiles' ? json({ object: 'list', data: [long] }) : undefined)]);
    h.io.terminal = { stdin: false, stdout: false, stderr: false };
    h.io.columns = 40;
    expect(await main(['checklist'], h.io), h.stderr()).toBe(0);
    const out = h.stdout();
    expect(out).not.toContain('\u001b[');
    expect(out).toContain('vehicle\n  Usually there: Identification plate, Dashboard, Engine bay\n  If there is one: Spare wheel, A first-aid kit with a very long label that a narrow table would cut');
    expect(out).toContain('spacecontext checklist --type <type> gives a hint for each');
    expect(out).not.toContain('Dimmed');
  });

  it('checklist reads the API of the saved key only when that key is the one in use', async () => {
    await mkdir(path.join(directory, 'config'), { recursive: true });
    await writeFile(path.join(directory, 'config', 'config.json'), JSON.stringify({ apiKey: KEY, baseUrl: 'https://other.example.test/v1' }), { mode: 0o600 });
    const urls: string[] = [];
    const answer = (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(json(VEHICLE));
    };
    const saved = harness([]);
    saved.io.fetch = answer as typeof fetch;
    saved.io.env = { SPACECONTEXT_CONFIG_DIR: path.join(directory, 'config') };
    expect(await main(['checklist', '--type', 'vehicle'], saved.io), saved.stderr()).toBe(0);
    expect(urls.at(-1)).toMatch(/^https:\/\/other\.example\.test\/v1\/capture-profiles\/vehicle/);

    const fromEnv = harness([]);
    fromEnv.io.fetch = answer as typeof fetch;
    fromEnv.io.env = { SPACECONTEXT_CONFIG_DIR: path.join(directory, 'config'), SPACECONTEXT_API_KEY: 'sc_live_anotherkey123' };
    expect(await main(['checklist', '--type', 'vehicle'], fromEnv.io), fromEnv.stderr()).toBe(0);
    expect(urls.at(-1)).toMatch(/^https:\/\/api\.spacecontext\.app\/v1\/capture-profiles\/vehicle/);

    const fromFlag = harness([]);
    fromFlag.io.fetch = answer as typeof fetch;
    fromFlag.io.env = { SPACECONTEXT_CONFIG_DIR: path.join(directory, 'config') };
    expect(await main(['checklist', '--type', 'vehicle', '--api-key', 'sc_live_anotherkey123'], fromFlag.io), fromFlag.stderr()).toBe(0);
    expect(urls.at(-1)).toMatch(/^https:\/\/api\.spacecontext\.app\/v1\//);
  });

  it('checklist: an unknown type on the API is a version gap, not an id or a key to check', async () => {
    const h = harness([(call) => (call.path === '/capture-profiles/vehicle' ? json({ error: { code: 'NOT_FOUND', message: 'Unknown type', request_id: 'r' } }, 404) : undefined)]);
    expect(await main(['checklist', '--type', 'vehicle'], h.io)).toBe(1);
    expect(h.stderr()).toContain('The API does not know this type of space: it may be older than this CLI');
    expect(h.stderr()).not.toContain('spacecontext spaces');
  });

  it('space: a document checked before capture profiles keeps one list, even with a profile', async () => {
    const older = {
      object: 'space_document',
      space: { id: SPACE_ID, source: 'app', name: 'Car', space_type: 'vehicle' },
      scan: { id: 'scn_1', analyzed_at: null },
      enrichment: { level: 'deep', status: 'complete' },
      summary: null,
      stats: { areas: 0, items: 0, issues: 0, key_locations: 0, facts: 0 },
      areas: [],
      items: [],
      issues: [],
      key_locations: [],
      coverage: { warnings: [], not_documented: [], checklist: [{ kind: 'electrical_panel', seen: false, probability: 0.1, evidence: [] }, { kind: 'router', seen: true, probability: 0.9, evidence: [] }] },
    };
    const h = harness([profiles, (call) => (call.path === `/spaces/${SPACE_ID}` ? json(older) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID], h.io), h.stderr()).toBe(0);
    expect(h.stdout()).toContain('Key locations filmed: router\nNot filmed: electrical panel');
    expect(h.stdout()).not.toContain('usually there');
  });

  it('scan: the summary at the end shows the coverage by profile and the verified evidence', async () => {
    const frames = path.join(directory, 'frames');
    await mkdir(frames);
    await writeFile(path.join(frames, 'frame-1.jpg'), new Uint8Array([0xff, 0xd8, 1]));
    const SCAN_ID = `scn_${'c'.repeat(32)}`;
    const scanState = (status: string, extra: Record<string, unknown> = {}) => ({
      object: 'scan', id: SCAN_ID, space_id: SPACE_ID, livemode: true, status, stage: null,
      input: { kind: 'frames', language: 'en', frame_count: 1, video: null, has_transcript: false },
      charge: { kind: 'free_scan', price_cents: 100, refunded: false }, error: null, upload: null, created_at: null, started_at: null, completed_at: null, ...extra,
    });
    const events = (states: unknown[]) => new Response(states.map((state, index) => `event: scan\nid: ${index + 1}\ndata: ${JSON.stringify(state)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    const verified = { status: 'verified', probability: 0.95, frame_id: 'frame-0' };
    const document = {
      object: 'space_document',
      space: { id: SPACE_ID, source: 'api', name: 'Company car', space_type: 'vehicle' },
      scan: { id: SCAN_ID, analyzed_at: '2026-10-13T10:00:00.000Z' },
      enrichment: { level: 'deep', status: 'complete' },
      summary: null,
      stats: { areas: 1, items: 1, issues: 0, key_locations: 1, facts: 0 },
      areas: [{ id: 'area_1', name: 'Cabin' }],
      items: [{ id: 'itm_1', area_id: 'area_1', name: 'Seats', verification: verified }],
      issues: [],
      key_locations: [{ id: 'kl_1', kind: 'instrument_panel', label: 'Dashboard', verification: { status: 'unconfirmed', probability: 0.4, frame_id: 'frame-0' } }],
      coverage: { warnings: [], not_documented: [], checklist: VEHICLE.key_locations.map((entry) => ({ kind: entry.kind, seen: entry.kind === 'instrument_panel', probability: 0.5, evidence: [] })) },
    };
    const h = harness([
      profiles,
      (call) => (call.method === 'POST' && call.path === '/spaces' ? json({ object: 'space', id: SPACE_ID, name: 'Company car' }, 201) : undefined),
      (call) => (call.method === 'POST' && call.path === `/spaces/${SPACE_ID}/scans` ? json(scanState('awaiting_upload'), 201) : undefined),
      (call) => (call.method === 'PUT' && call.path.startsWith(`/scans/${SCAN_ID}/frames/`) ? json({ object: 'scan_frame', scan_id: SCAN_ID, bytes: 3 }) : undefined),
      (call) => (call.method === 'POST' && call.path === `/scans/${SCAN_ID}/start` ? json(scanState('queued'), 202) : undefined),
      (call) => (call.method === 'GET' && call.path === `/scans/${SCAN_ID}/events` ? events([scanState('processing', { stage: 'verifying' }), scanState('complete')]) : undefined),
      (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(document) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['scan', 'frames', '--name', 'Company car', '--type', 'vehicle'], h.io), h.stderr()).toBe(0);
    expect(h.stderr()).toContain('› Verifying the evidence…');
    expect(h.stdout()).toContain('Key locations filmed: Dashboard\nNot filmed, usually there: Identification plate, Engine bay\nNot filmed, if there is one: Spare wheel');
    expect(h.stdout()).toContain('Evidence: 1 of 2 records verified on their photo · 1 unconfirmed');
    expect(h.stdout()).toContain('Dashboard (unconfirmed on its photo)');
  });
});
