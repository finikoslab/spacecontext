import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, VERSION, type Io } from '../src/cli.js';
import { skillFilePath } from '../src/files.js';

const KEY = 'sc_live_clitestkey123';
const BASE = 'https://api.example.test/v1';
const SCAN_ID = `scn_${'c'.repeat(32)}`;
const SPACE_ID = `spc_${'d'.repeat(32)}`;

type Call = { method: string; path: string; search: URLSearchParams; headers: Headers; body: unknown };
type Route = (call: Call) => Response | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'spacecontext-cli-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function harness(routes: Route[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const call: Call = { method: init.method ?? 'GET', path: url.pathname.replace(/^\/v1/, ''), search: url.searchParams, headers: new Headers(init.headers), body: init.body };
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
  return { io, calls, urls, stdout: () => out.join(''), stderr: () => err.join('') };
}

const me: Route = (call) =>
  call.method === 'GET' && call.path === '/me' ? json({ user: { id: 'u1', email: 'dev@example.com', is_pro: true }, key: { id: 'key_1', mode: 'live', scopes: ['spaces:read'] } }) : undefined;

function scan(status: string, extra: Record<string, unknown> = {}) {
  return {
    object: 'scan',
    id: SCAN_ID,
    space_id: SPACE_ID,
    livemode: true,
    status,
    stage: null,
    input: { kind: 'frames', language: 'en', frame_count: 2, video: null, has_transcript: false },
    charge: { kind: 'free_scan', price_cents: 100, refunded: false },
    error: null,
    upload: null,
    created_at: null,
    started_at: null,
    completed_at: null,
    ...extra,
  };
}

const document = {
  object: 'space_document',
  space: { id: SPACE_ID, source: 'api', name: 'Flat' },
  scan: { id: SCAN_ID, analyzed_at: '2026-10-05T10:00:00.000Z' },
  enrichment: { level: 'deep', status: 'complete' },
  summary: 'Two rooms.',
  stats: { areas: 1, items: 1, issues: 1, key_locations: 0, facts: 0 },
  areas: [{ id: 'area_1', name: 'Kitchen' }],
  items: [{ id: 'itm_1', area_id: 'area_1', name: 'Oven' }],
  issues: [{ id: 'iss_1', title: 'Loose tile', severity: 'low' }],
  coverage: { warnings: [], not_documented: [] },
};

describe('spacecontext CLI', () => {
  it('prints help and version, and rejects unknown commands and options', async () => {
    const h = harness([]);
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.stdout()).toContain('Usage: spacecontext <command>');
    expect(await main(['--version'], h.io)).toBe(0);
    expect(h.stdout()).toContain(VERSION);
    expect(await main([], h.io)).toBe(2);
    expect(await main(['fly'], h.io)).toBe(2);
    expect(await main(['spaces', '--bogus'], h.io)).toBe(2);
    expect(h.stderr()).toContain('Unknown command "fly"');
  });

  it('logs in with a key it has checked, stores it for the owner only, and logs out', async () => {
    const h = harness([me]);
    expect(await main(['whoami'], h.io)).toBe(2);
    expect(h.stderr()).toContain('spacecontext login');

    expect(await main(['login', '--key', KEY], h.io)).toBe(0);
    expect(h.stdout()).toContain('Logged in as dev@example.com with a live key');
    const file = path.join(directory, 'config', 'config.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ apiKey: KEY });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    expect(await main(['whoami'], h.io)).toBe(0);
    expect(h.calls.at(-1)!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(h.stdout()).toContain('dev@example.com (Pro)');

    expect(await main(['logout'], h.io)).toBe(0);
    expect(await main(['whoami'], h.io)).toBe(2);
  });

  it('does not save a key the API refuses', async () => {
    const h = harness([() => json({ error: { code: 'INVALID_TOKEN', message: 'Invalid token', request_id: 'req_9' } }, 401)]);
    expect(await main(['login', '--key', KEY], h.io)).toBe(1);
    expect(h.stderr()).toContain('Error [INVALID_TOKEN]: Invalid token (request req_9)');
    expect(h.stderr()).toContain('spacecontext login');
    await expect(readFile(path.join(directory, 'config', 'config.json'))).rejects.toThrow();
  });

  it('prefers --api-key, then the environment, then the saved key', async () => {
    const h = harness([me], { SPACECONTEXT_API_KEY: 'sc_live_fromenvironment' });
    await main(['login', '--key', KEY], h.io);
    await main(['whoami'], h.io);
    expect(h.calls.at(-1)!.headers.get('authorization')).toBe('Bearer sc_live_fromenvironment');
    await main(['whoami', '--api-key', 'sc_test_fromflag'], h.io);
    expect(h.calls.at(-1)!.headers.get('authorization')).toBe('Bearer sc_test_fromflag');
  });

  it('searches and asks, in text or JSON', async () => {
    const h = harness([
      (call) =>
        call.path === '/search'
          ? json({ object: 'search_results', query: call.search.get('q'), data: [{ space_id: SPACE_ID, space_name: 'Flat', scan_id: SCAN_ID, record_type: 'item', record_id: 'itm_1', title: 'Stopcock', area: 'Bathroom', text: 'Under the sink.', score: 0.9 }] })
          : undefined,
      (call) =>
        call.path === `/spaces/${SPACE_ID}/ask`
          ? json({ object: 'answer', space_id: SPACE_ID, scan_id: SCAN_ID, question: JSON.parse(String(call.body)).question, answer: 'Under the bathroom sink.', documented: true, citations: [{ record_type: 'item', record_id: 'itm_1', title: 'Stopcock', area: 'Bathroom', evidence: [] }, { record_type: 'area', record_id: 'area_1', title: 'Bathroom', area: 'Bathroom', evidence: [] }] })
          : undefined,
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['search', 'where', 'is', 'the', 'stopcock', '--limit', '3'], h.io)).toBe(0);
    expect(h.calls[0]!.search.get('q')).toBe('where is the stopcock');
    expect(h.calls[0]!.search.get('limit')).toBe('3');
    expect(h.stdout()).toContain('Stopcock — Bathroom  [Flat, item itm_1]');

    expect(await main(['ask', SPACE_ID, 'where is the stopcock?', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.stdout().slice(h.stdout().indexOf('{')))).toMatchObject({ answer: 'Under the bathroom sink.', question: 'where is the stopcock?' });

    expect(await main(['ask', SPACE_ID, 'where is the stopcock?'], h.io)).toBe(0);
    // An area cited as a source is not followed by its own name.
    expect(h.stdout()).toContain('Sources:\n  - Stopcock (Bathroom)\n  - Bathroom\n');

    expect(await main(['search', 'x', '--limit', 'ten'], h.io)).toBe(2);
    expect(await main(['ask', SPACE_ID], h.io)).toBe(2);
  });

  it('writes a skill folder, and refuses a bundle that would write outside it', async () => {
    const files = [
      { path: 'SKILL.md', media_type: 'text/markdown', content: '# Flat' },
      { path: 'references/items.md', media_type: 'text/markdown', content: '- Oven' },
    ];
    const good = harness([(call) => (call.path === `/spaces/${SPACE_ID}/skill` ? json({ object: 'skill', name: 'flat', space_id: SPACE_ID, scan_id: SCAN_ID, files }) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['skill', SPACE_ID], good.io)).toBe(0);
    expect(await readFile(path.join(directory, 'flat', 'references', 'items.md'), 'utf8')).toBe('- Oven');
    expect(await main(['skill', SPACE_ID, '--out', 'elsewhere/skill'], good.io)).toBe(0);
    expect(await readFile(path.join(directory, 'elsewhere', 'skill', 'SKILL.md'), 'utf8')).toBe('# Flat');

    const evil = harness([(call) => (call.path === `/spaces/${SPACE_ID}/skill` ? json({ object: 'skill', name: 'evil', space_id: SPACE_ID, scan_id: SCAN_ID, files: [files[0], { path: '../escaped.md', media_type: 'text/markdown', content: 'x' }] }) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['skill', SPACE_ID], evil.io)).toBe(1);
    expect(evil.stderr()).toContain('Refusing to write');
    // A bundle name that is not a plain slug is never used as a folder.
    // Unique names: a regression must not leave files that hide the next one.
    const outside = `outside-${crypto.randomUUID()}`;
    for (const name of [`../${outside}`, path.join(tmpdir(), `${outside}-abs`), 'a/b', '..']) {
      const named = harness([(call) => (call.path === `/spaces/${SPACE_ID}/skill` ? json({ object: 'skill', name, space_id: SPACE_ID, scan_id: SCAN_ID, files }) : undefined)], { SPACECONTEXT_API_KEY: KEY });
      expect(await main(['skill', SPACE_ID], named.io), name).toBe(1);
      expect(named.stderr()).toContain('pass --out');
    }
    await expect(readFile(path.join(directory, '..', outside, 'SKILL.md'))).rejects.toThrow();
    await expect(readFile(path.join(tmpdir(), `${outside}-abs`, 'SKILL.md'))).rejects.toThrow();
    // Nothing at all was written: paths are checked before any write.
    await expect(readdir(path.join(directory, 'evil'))).rejects.toThrow();
    await expect(readFile(path.join(directory, 'escaped.md'))).rejects.toThrow();
  });

  it('scans a folder of frames into a new space and waits for the result', async () => {
    const frames = path.join(directory, 'frames');
    await mkdir(frames);
    await writeFile(path.join(frames, 'frame-10.jpg'), new Uint8Array([0xff, 0xd8, 10]));
    await writeFile(path.join(frames, 'frame-2.png'), new Uint8Array([0x89, 0x50, 2]));
    await writeFile(path.join(frames, 'notes.txt'), 'ignored');

    const h = harness([
      (call) => (call.method === 'POST' && call.path === '/spaces' ? json({ object: 'space', id: SPACE_ID, name: JSON.parse(String(call.body)).name }, 201) : undefined),
      (call) => (call.method === 'POST' && call.path === `/spaces/${SPACE_ID}/scans` ? json(scan('awaiting_upload'), 201) : undefined),
      (call) => (call.method === 'PUT' && call.path.startsWith(`/scans/${SCAN_ID}/frames/`) ? json({ object: 'scan_frame', scan_id: SCAN_ID, bytes: 3 }) : undefined),
      (call) => (call.method === 'POST' && call.path === `/scans/${SCAN_ID}/start` ? json(scan('queued'), 202) : undefined),
      (call) => (call.method === 'GET' && call.path === `/scans/${SCAN_ID}` ? json(scan('complete')) : undefined),
      (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(document) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['scan', 'frames', '--name', 'Flat', '--type', 'apartment'], h.io)).toBe(0);
    expect(JSON.parse(String(h.calls[0]!.body))).toEqual({ name: 'Flat', space_type: 'apartment' });
    // Natural order: frame-2 before frame-10, with each file's own type.
    const uploads = h.calls.filter((call) => call.method === 'PUT');
    expect(uploads.map((call) => [call.path, call.headers.get('content-type')])).toEqual([
      [`/scans/${SCAN_ID}/frames/0`, 'image/png'],
      [`/scans/${SCAN_ID}/frames/1`, 'image/jpeg'],
    ]);
    expect(new Uint8Array(await (uploads[0]!.body as Blob).arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 2]));
    expect(h.stderr()).toContain('(free scan)');
    expect(h.stdout()).toContain('Flat  (');
    expect(h.stdout()).toContain('## Kitchen\nOven');
    expect(h.stdout()).toContain(`spacecontext ask ${SPACE_ID}`);
  });

  it('reports a failed scan and checks its arguments', async () => {
    const video = path.join(directory, 'tour.mov');
    await writeFile(video, new Uint8Array([0, 0, 0, 20]));
    const testStart = scan('queued', { livemode: false });
    const failed = scan('failed', { error: { code: 'ANALYSIS_EMPTY', message: 'No space recognised' }, charge: { kind: 'free_scan', price_cents: 100, refunded: true } });
    const h = harness([
      (call) => (call.method === 'POST' && call.path === `/spaces/${SPACE_ID}/scans` ? json(scan('awaiting_upload', { input: { kind: 'video', language: 'en', frame_count: null, video: { content_type: 'video/quicktime', content_length: 4 }, has_transcript: false }, upload: { kind: 'video', method: 'PUT', url: `${BASE}/scans/${SCAN_ID}/video`, headers: { 'Content-Type': 'video/quicktime' } } }), 201) : undefined),
      (call) => (call.method === 'PUT' && call.path === `/scans/${SCAN_ID}/video` ? json({ object: 'scan_video', scan_id: SCAN_ID, bytes: 4 }) : undefined),
      (call) => (call.method === 'POST' && call.path === `/scans/${SCAN_ID}/start` ? json(testStart, 202) : undefined),
      (call) => (call.method === 'GET' && call.path === `/scans/${SCAN_ID}` ? json(failed) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['scan', 'tour.mov', '--space', SPACE_ID], h.io)).toBe(1);
    // Not a live scan: nothing is charged, whatever the price.
    expect(h.stderr()).toContain('(test mode, no charge)');
    expect(JSON.parse(String(h.calls[0]!.body)).input).toMatchObject({ kind: 'video', video: { content_type: 'video/quicktime', content_length: 4 } });
    expect(h.stderr()).toContain('Error [ANALYSIS_EMPTY]: Scan failed: No space recognised (refunded)');

    for (const args of [
      ['scan', 'tour.mov'],
      ['scan', 'tour.mov', '--space', SPACE_ID, '--name', 'Flat'],
      ['scan', 'missing.mp4', '--space', SPACE_ID],
      ['scan', 'tour.mov', '--space', SPACE_ID, '--language', 'fr'],
      ['scan', 'tour.mov', '--name', 'Flat', '--type', 'castle'],
    ]) {
      expect(await main(args, h.io), args.join(' ')).toBe(2);
    }
    await writeFile(path.join(directory, 'notes.txt'), 'x');
    expect(await main(['scan', 'notes.txt', '--space', SPACE_ID], h.io)).toBe(2);
  });
});

describe('spacecontext CLI, housekeeping', () => {
  it('lists scans, cancels a scan and deletes a space', async () => {
    const h = harness([
      (call) => (call.path === `/spaces/${SPACE_ID}/scans` ? json({ data: [{ object: 'scan', id: SCAN_ID, space_id: SPACE_ID, analyzed_at: '2026-10-05T10:00:00.000Z', areas: 3, items: 14, issues: 2, current: true }] }) : undefined),
      (call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['scans', SPACE_ID], h.io)).toBe(0);
    expect(h.stdout()).toContain(`${SCAN_ID} (current)`);
    expect(await main(['cancel', SCAN_ID, '--json'], h.io)).toBe(0);
    expect(h.stdout()).toContain(`"cancelled": "${SCAN_ID}"`);
    expect(await main(['delete-space', SPACE_ID], h.io)).toBe(0);
    expect(h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([`/scans/${SCAN_ID}`, `/spaces/${SPACE_ID}`]);
  });

  it('prints a comparison in words, telling what is gone from what was not seen', async () => {
    const none = { from: [], to: [] };
    const diff = {
      object: 'space_diff', space_id: SPACE_ID, from: { scan_id: 'scn_before', analyzed_at: null }, to: { scan_id: SCAN_ID, analyzed_at: null },
      level: 'deep', linked: true,
      summary: {},
      areas: { added: [], removed: [], condition_changed: [] },
      items: {
        added: [{ name: 'Toaster', canonical_name: 'toaster', area: 'Kitchen', quantity: 1, evidence: none }],
        removed: [{ name: 'Kettle', canonical_name: 'kettle', area: 'Kitchen', quantity: 1, note: 'The counter is empty.', evidence: none }],
        not_seen: [{ name: 'Umbrella stand', canonical_name: 'umbrella stand', area: 'Hall', quantity: 1, evidence: none }],
        moved: [], quantity_changed: [],
        condition_changed: [{ name: 'Oven', canonical_name: 'oven', area: 'Kitchen', quantity: 1, from_condition: 'good', to_condition: 'damaged', evidence: none }],
      },
      issues: { new: [], resolved: [{ title: 'Dripping tap', area: 'Kitchen', severity: 'low', note: null, evidence: none }], not_seen: [] },
    };
    const empty = { ...diff, linked: false, items: { added: [], removed: [], not_seen: [], moved: [], quantity_changed: [], condition_changed: [] }, issues: { new: [], resolved: [], not_seen: [] } };
    const h = harness([
      (call) => (call.path === `/spaces/${SPACE_ID}/diff` ? json(call.search.get('to') ? empty : diff) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['diff', SPACE_ID, '--from', 'scn_before'], h.io)).toBe(0);
    const out = h.stdout();
    expect(out).toContain('the later scan was checked against the earlier one');
    expect(out).toContain('Items added (1)\n  + Toaster — Kitchen');
    expect(out).toContain('Items gone (seen: the place is empty) (1)\n  - Kettle — Kitchen: The counter is empty.');
    expect(out).toContain('Items not seen in the later scan (gone, or not filmed) (1)\n  ? Umbrella stand — Hall');
    expect(out).toContain('Oven — Kitchen: good → damaged');
    expect(out).toContain('✓ Dripping tap — Kitchen');
    expect(out).not.toContain('"object"');

    expect(await main(['diff', SPACE_ID, '--from', 'scn_before', '--to', SCAN_ID], h.io)).toBe(0);
    expect(h.stdout()).toContain('matched by content');
    expect(h.stdout()).toContain('No differences found.');
    expect(await main(['diff', SPACE_ID], h.io)).toBe(2);
  });

  it('prints JSON on logout with --json', async () => {
    const h = harness([]);
    expect(await main(['logout', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({ logged_out: true });
  });

  it('sends a key from the environment to the default API, never to the URL saved with another key', async () => {
    const h = harness([me], { SPACECONTEXT_BASE_URL: '' });
    delete h.io.env.SPACECONTEXT_BASE_URL;
    await main(['login', '--key', KEY, '--base-url', 'http://localhost:8787/v1'], h.io);
    await main(['whoami'], h.io);
    const saved = h.calls.at(-1)!;
    expect(saved.headers.get('authorization')).toBe(`Bearer ${KEY}`);

    h.io.env.SPACECONTEXT_API_KEY = 'sc_live_otherkeyfromenv';
    await main(['whoami'], h.io);
    expect(h.calls.at(-1)!.headers.get('authorization')).toBe('Bearer sc_live_otherkeyfromenv');
    expect(h.urls.at(-1)).toMatch(/^https:\/\/api\.spacecontext\.finikos\.it\/v1\/me/);
    expect(h.urls.at(-2)).toMatch(/^http:\/\/localhost:8787\/v1\/me/);
  });

  it('refuses oversized files before creating anything, and says when a space was left without a scan', async () => {
    const frames = path.join(directory, 'big');
    await mkdir(frames);
    await writeFile(path.join(frames, 'frame-1.jpg'), new Uint8Array(2 * 1024 * 1024 + 1));
    const h = harness([], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['scan', 'big', '--name', 'Flat'], h.io)).toBe(2);
    expect(h.stderr()).toContain('larger than 2 MB');
    expect(h.calls).toEqual([]);

    const ok = path.join(directory, 'ok');
    await mkdir(ok);
    await writeFile(path.join(ok, 'frame-1.jpg'), new Uint8Array([0xff, 0xd8]));
    const failing = harness([
      (call) => (call.method === 'POST' && call.path === '/spaces' ? json({ object: 'space', id: SPACE_ID, name: 'Flat' }, 201) : undefined),
      (call) => (call.method === 'POST' && call.path === `/spaces/${SPACE_ID}/scans` ? json(scan('awaiting_upload'), 201) : undefined),
      (call) => (call.method === 'PUT' ? json({ error: { code: 'INVALID_CONTENT_TYPE', message: 'Not an image', request_id: 'r' } }, 415) : undefined),
      (call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['scan', 'ok', '--name', 'Flat'], failing.io)).toBe(1);
    expect(failing.calls.some((call) => call.method === 'DELETE' && call.path === `/scans/${SCAN_ID}`)).toBe(true);
    expect(failing.stderr()).toContain(`spacecontext delete-space ${SPACE_ID}`);
  });
});

describe('skill file paths', () => {
  it('accepts plain relative paths only', () => {
    const root = path.join(directory, 'skill');
    expect(skillFilePath(root, 'references/items.md')).toBe(path.join(root, 'references', 'items.md'));
    for (const bad of ['', '../x.md', 'a/../../x.md', '/etc/passwd', 'a//b.md', './a.md', 'a\\..\\b.md', 'a\0b']) {
      expect(() => skillFilePath(root, bad), JSON.stringify(bad)).toThrow(/Refusing/);
    }
  });
});
