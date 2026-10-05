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
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
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
  return { io, calls, stdout: () => out.join(''), stderr: () => err.join('') };
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
          ? json({ object: 'answer', space_id: SPACE_ID, scan_id: SCAN_ID, question: JSON.parse(String(call.body)).question, answer: 'Under the bathroom sink.', documented: true, citations: [{ record_type: 'item', record_id: 'itm_1', title: 'Stopcock', area: 'Bathroom', evidence: [] }] })
          : undefined,
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['search', 'where', 'is', 'the', 'stopcock', '--limit', '3'], h.io)).toBe(0);
    expect(h.calls[0]!.search.get('q')).toBe('where is the stopcock');
    expect(h.calls[0]!.search.get('limit')).toBe('3');
    expect(h.stdout()).toContain('Stopcock — Bathroom  [Flat, item itm_1]');

    expect(await main(['ask', SPACE_ID, 'where is the stopcock?', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.stdout().slice(h.stdout().indexOf('{')))).toMatchObject({ answer: 'Under the bathroom sink.', question: 'where is the stopcock?' });

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

describe('skill file paths', () => {
  it('accepts plain relative paths only', () => {
    const root = path.join(directory, 'skill');
    expect(skillFilePath(root, 'references/items.md')).toBe(path.join(root, 'references', 'items.md'));
    for (const bad of ['', '../x.md', 'a/../../x.md', '/etc/passwd', 'a//b.md', './a.md', 'a\\..\\b.md', 'a\0b']) {
      expect(() => skillFilePath(root, bad), JSON.stringify(bad)).toThrow(/Refusing/);
    }
  });
});
