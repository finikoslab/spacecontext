import { mkdtemp, mkdir, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, VERSION, type Io } from '../src/cli.js';
import { skillFilePath } from '../src/lib/files.js';

const KEY = 'sc_live_clitestkey123';
const BASE = 'https://api.example.test/v1';
const SCAN_ID = `scn_${'c'.repeat(32)}`;
const SPACE_ID = `spc_${'d'.repeat(32)}`;

type Call = { method: string; path: string; search: URLSearchParams; headers: Headers; body: unknown };
type Route = (call: Call) => Response | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const markdownPage = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
/** The API's event stream of a scan: each state, then the end. */
const stream = (states: unknown[]) =>
  new Response(states.map((state, index) => `event: scan\nid: ${index + 1}\ndata: ${JSON.stringify(state)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });

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
  return { io, calls, urls, routes, stdout: () => out.join(''), stderr: () => err.join('') };
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
    expect(h.stdout()).toContain('Usage  spacecontext <command> [options]');
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
    // The API it was checked with is saved with it: the key goes to no other.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ apiKey: KEY, baseUrl: BASE });
    expect(h.stdout()).toContain(`config.json, for ${BASE}`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    expect(await main(['whoami'], h.io)).toBe(0);
    expect(h.calls.at(-1)!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(h.stdout()).toContain('dev@example.com · Pro');
    // The key in use, masked as the console shows it, and where it comes from.
    expect(h.stdout()).toContain('sc_live_clit… · live');
    expect(h.stdout()).toContain('From     the saved key');
    expect(h.stdout()).not.toContain(KEY);

    expect(await main(['logout'], h.io)).toBe(0);
    expect(await main(['whoami'], h.io)).toBe(2);
  });

  it('signs in with a code approved in the console, opening the browser once', async () => {
    let polls = 0;
    const h = harness([
      (call) => (call.method === 'POST' && call.path === '/auth/device' ? json({ device_code: `scd_${'a'.repeat(43)}`, user_code: 'BCDF-2345', verification_url: 'https://spacecontext.example/developers/console/authorize/', expires_in: 600, interval: 0 }, 201) : undefined),
      (call) =>
        call.method === 'POST' && call.path === '/auth/device/token'
          ? polls++ < 1
            ? json({ error: { code: 'AUTHORIZATION_PENDING', message: 'Waiting', request_id: 'r', interval: 0 } }, 400)
            : json({ api_key: KEY, key: { id: 'key_1', name: 'CLI · CLI on mac', mode: 'test', prefix: KEY.slice(0, 12), scopes: ['spaces:read', 'scans:read'], monthly_cap_cents: null, created_at: '2026-10-09T10:00:00.000Z' }, user: { id: 'u1', email: 'dev@example.com', name: null, is_pro: false } })
          : undefined,
      me,
    ]);
    const opened: string[] = [];
    h.io.openBrowser = (url) => opened.push(url);

    expect(await main(['login', '--test'], h.io)).toBe(0);
    expect(JSON.parse(String(h.calls[0]!.body))).toMatchObject({ mode: 'test', name: expect.stringMatching(/^CLI on /) });
    expect(h.stderr()).toContain('2. Enter  BCDF-2345');
    expect(h.stderr()).toContain('https://spacecontext.example/developers/console/authorize/');
    expect(h.stderr()).not.toContain('code=BCDF');
    // A test key never needs a card.
    expect(h.stderr()).not.toContain('card on file');
    expect(opened).toEqual(['https://spacecontext.example/developers/console/authorize/']);
    expect(h.stdout()).toContain('Logged in as dev@example.com with a test key (spaces:read, scans:read)');
    // The API signed in to, here from SPACECONTEXT_BASE_URL, is saved with the key.
    expect(JSON.parse(await readFile(path.join(directory, 'config', 'config.json'), 'utf8'))).toEqual({ apiKey: KEY, baseUrl: BASE });
    expect(await main(['whoami'], h.io)).toBe(0);
    expect(await main(['logout'], h.io)).toBe(0);

    // Denied in the console: nothing saved, nothing opened with --no-browser.
    const denied = harness([
      (call) => (call.method === 'POST' && call.path === '/auth/device' ? json({ device_code: `scd_${'b'.repeat(43)}`, user_code: 'GHJK-6789', verification_url: 'https://spacecontext.example/developers/console/authorize/', expires_in: 600, interval: 0 }, 201) : undefined),
      (call) => (call.method === 'POST' && call.path === '/auth/device/token' ? json({ error: { code: 'ACCESS_DENIED', message: 'Denied', request_id: 'r' } }, 403) : undefined),
    ]);
    const openedDenied: string[] = [];
    denied.io.openBrowser = (url) => openedDenied.push(url);
    expect(await main(['login', '--no-browser'], denied.io)).toBe(1);
    expect(denied.stderr()).toContain('Error [ACCESS_DENIED]');
    // A live sign-in says that a key that can scan needs a card on file.
    expect(denied.stderr()).toContain('A live key that can scan needs a card on file (adding one charges nothing)');
    expect(openedDenied).toEqual([]);
    await expect(readFile(path.join(directory, 'config', 'config.json'))).rejects.toThrow();
  });

  it('reads the key of `login --key -` from a prompt that does not echo it, out of the shell history', async () => {
    const h = harness([me]);
    const asked: string[] = [];
    h.io.prompt = async (question) => {
      asked.push(question);
      return `  ${KEY}\n`;
    };
    expect(await main(['login', '--key', '-'], h.io)).toBe(0);
    expect(asked).toEqual(['API key (input hidden): ']);
    expect(h.calls.at(-1)!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(await readFile(path.join(directory, 'config', 'config.json'), 'utf8'))).toEqual({ apiKey: KEY, baseUrl: BASE });
    expect(h.stdout() + h.stderr()).not.toContain(KEY);

    // Nothing typed, or no terminal to type in: nothing sent, nothing saved.
    await rm(path.join(directory, 'config'), { recursive: true });
    const empty = harness([me]);
    empty.io.prompt = async () => '   ';
    expect(await main(['login', '--key', '-'], empty.io)).toBe(2);
    expect(empty.stderr()).toContain('No key entered');
    const piped = harness([me]);
    expect(await main(['login', '--key', '-'], piped.io)).toBe(2);
    expect(piped.stderr()).toContain('reads the key from a terminal');
    expect([...empty.calls, ...piped.calls]).toEqual([]);
    await expect(readFile(path.join(directory, 'config', 'config.json'))).rejects.toThrow();
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

  it('treats an empty SPACECONTEXT_API_KEY as unset, so the saved key and its base URL are used', async () => {
    const h = harness([me], { SPACECONTEXT_BASE_URL: '' });
    await main(['login', '--key', KEY, '--base-url', 'http://localhost:8787/v1'], h.io);
    for (const blank of ['', '   ']) {
      h.io.env.SPACECONTEXT_API_KEY = blank;
      expect(await main(['whoami'], h.io)).toBe(0);
      expect(h.calls.at(-1)!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(h.urls.at(-1)).toBe('http://localhost:8787/v1/me');
    }
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
    expect(h.stdout()).toContain('Under the bathroom sink.\n\nSources\n  • Stopcock (Bathroom)\n  • Bathroom\n');

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
      (call) => (call.method === 'GET' && call.path === `/scans/${SCAN_ID}/events` ? stream([scan('queued'), scan('processing', { stage: 'observing' }), scan('complete')]) : undefined),
      (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(document) : undefined),
      (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}/markdown` ? markdownPage('# Flat\n\nTwo rooms.\n') : undefined),
      (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}/skill` ? json({ name: 'space-flat', files: [{ path: 'SKILL.md', media_type: 'text/markdown', content: '# Flat' }] }) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['scan', 'frames', '--name', 'Flat', '--type', 'apartment'], h.io)).toBe(0);
    // The analysis is followed live, stage by stage, in words.
    expect(h.stderr()).toContain('› Queued…\n› Looking at the frames…\n');
    expect(h.stderr()).not.toContain('Complete…');
    expect(JSON.parse(String(h.calls[0]!.body))).toEqual({ name: 'Flat', space_type: 'apartment' });
    // Natural order: frame-2 before frame-10, with each file's own type.
    const uploads = h.calls.filter((call) => call.method === 'PUT');
    expect(uploads.map((call) => [call.path, call.headers.get('content-type')])).toEqual([
      [`/scans/${SCAN_ID}/frames/0`, 'image/png'],
      [`/scans/${SCAN_ID}/frames/1`, 'image/jpeg'],
    ]);
    expect(new Uint8Array(await (uploads[0]!.body as Blob).arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 2]));
    expect(h.stderr()).toContain(`✓ Scan started  ${SCAN_ID} · free scan`);
    expect(h.stderr()).toMatch(/✓ Scan complete in \d+s\n$/);
    expect(h.stdout()).toContain(`Flat  ${SPACE_ID} · api`);
    expect(h.stdout()).toContain('1 area · 1 item · 1 issue · 0 key locations · 0 facts');
    expect(h.stdout()).toContain('Kitchen  (1)\n  Oven');
    // What to do with the space next, as commands to copy.
    expect(h.stdout()).toContain(`Next\n  › Ask it: \`spacecontext ask ${SPACE_ID} "where is the fuse box?"\``);
    expect(h.stdout()).toContain(`\`spacecontext skill ${SPACE_ID} --out ~/.claude/skills/flat\``);

    // The same scan, printed as a Markdown page, or written as a Skill folder.
    const asMarkdown = harness(h.routes, { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['scan', 'frames', '--space', SPACE_ID, '--format', 'markdown'], asMarkdown.io)).toBe(0);
    expect(asMarkdown.stdout()).toBe('# Flat\n\nTwo rooms.\n');
    const asSkill = harness(h.routes, { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['scan', 'frames', '--space', SPACE_ID, '--format', 'skill', '--out', 'exported'], asSkill.io)).toBe(0);
    expect(await readFile(path.join(directory, 'exported', 'SKILL.md'), 'utf8')).toBe('# Flat');
    expect(await main(['scan', 'frames', '--space', SPACE_ID, '--format', 'pdf'], asSkill.io)).toBe(2);
  });

  it('follows a scan already started by polling when the account has all its event streams open', async () => {
    const frames = path.join(directory, 'frames');
    await mkdir(frames);
    await writeFile(path.join(frames, 'frame-1.jpg'), new Uint8Array([0xff, 0xd8, 1]));
    const busy = new Response(
      JSON.stringify({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'At most 10 event streams of an account can be open at once', request_id: 'req_busy', retry_after: 30, max_streams: 10 } }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } }
    );
    const h = harness([
      (call) => (call.method === 'POST' && call.path === `/spaces/${SPACE_ID}/scans` ? json(scan('awaiting_upload'), 201) : undefined),
      (call) => (call.method === 'PUT' && call.path.startsWith(`/scans/${SCAN_ID}/frames/`) ? json({ object: 'scan_frame', scan_id: SCAN_ID, bytes: 3 }) : undefined),
      (call) => (call.method === 'POST' && call.path === `/scans/${SCAN_ID}/start` ? json(scan('queued'), 202) : undefined),
      (call) => (call.method === 'GET' && call.path === `/scans/${SCAN_ID}/events` ? busy : undefined),
      (call) => (call.method === 'GET' && call.path === `/scans/${SCAN_ID}` ? json(scan('complete')) : undefined),
      (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(document) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['scan', 'frames', '--space', SPACE_ID], h.io)).toBe(0);
    expect(h.stderr()).not.toContain('RATE_LIMIT_EXCEEDED');
    expect(h.stdout()).toContain('Kitchen  (1)\n  Oven');
    expect(h.calls.filter((call) => call.path === `/scans/${SCAN_ID}/events`)).toHaveLength(1);
    expect(h.calls.some((call) => call.method === 'GET' && call.path === `/scans/${SCAN_ID}`)).toBe(true);
  });

  it('exports a space as one Markdown page, to stdout or to a file, and follows a scan', async () => {
    const h = harness([
      (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}/markdown` ? markdownPage(`# Flat ${call.search.get('include') ?? ''}\n`) : undefined),
      (call) => (call.method === 'GET' && call.path === `/scans/${SCAN_ID}/events` ? stream([scan('processing', { stage: 'enriching' }), scan('complete')]) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['markdown', SPACE_ID], h.io)).toBe(0);
    expect(h.stdout()).toBe('# Flat \n');
    expect(await main(['markdown', SPACE_ID, '--transcript', '--out', 'flat.md'], h.io)).toBe(0);
    expect(await readFile(path.join(directory, 'flat.md'), 'utf8')).toBe('# Flat transcript\n');
    expect(h.stderr()).toContain('Written to ');

    const following = harness(h.routes, { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['scan-status', SCAN_ID, '--follow'], following.io)).toBe(0);
    expect(following.stdout()).toBe(`${SCAN_ID} processing (enriching: Extracting the context)\n${SCAN_ID} complete\n`);
  });

  it('checks frames before a scan: which are usable, what they show, what is still missing', async () => {
    const frames = path.join(directory, 'shots');
    await mkdir(frames);
    await writeFile(path.join(frames, 'a-hall.jpg'), new Uint8Array([0xff, 0xd8, 1]));
    await writeFile(path.join(frames, 'b-blur.jpg'), new Uint8Array([0xff, 0xd8, 2]));
    const kinds = ['electrical_panel', 'water_shutoff', 'water_heater'];
    const answer = (marker: number) => ({
      object: 'frame_check',
      livemode: true,
      usable: marker === 1,
      quality: marker === 1 ? { score: 2.4, level: 'good' } : { score: 0.3, level: 'unusable' },
      shows_space: 0.99,
      key_locations: kinds.map((kind) => ({ kind, probability: marker === 1 && kind === 'electrical_panel' ? 0.93 : 0.05, seen: marker === 1 && kind === 'electrical_panel' })),
    });
    const markers: number[] = [];
    const route: Route = (call) => {
      if (call.method !== 'POST' || call.path !== '/frames/check') return undefined;
      expect(call.headers.get('content-type')).toBe('image/jpeg');
      return undefined;
    };
    const h = harness([
      route,
      (call) => {
        if (call.method !== 'POST' || call.path !== '/frames/check') return undefined;
        const marker = markers.length + 1;
        markers.push(marker);
        return json(answer(marker));
      },
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['check', 'shots'], h.io)).toBe(0);
    expect(h.stdout()).toContain('FILE        USABLE  QUALITY         SHOWS\n');
    expect(h.stdout()).toContain('a-hall.jpg  ✓ yes   good, 2.40      electrical panel\n');
    expect(h.stdout()).toContain('b-blur.jpg  ✗ no    unusable, 0.30\n');
    expect(h.stdout()).toContain('Usable: 1 of 2 frames');
    expect(h.stdout()).toContain('Seen: electrical panel (a-hall.jpg)');
    expect(h.stdout()).toContain('Not seen yet: water shutoff, water heater.');

    markers.length = 0;
    const j = harness([(call) => (call.path === '/frames/check' ? json(answer(markers.push(1))) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['check', path.join('shots', 'a-hall.jpg'), '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.stdout()).summary).toEqual({ frames: 1, usable: 1, seen: [{ kind: 'electrical_panel', file: 'a-hall.jpg', probability: 0.93 }], not_seen: ['water_shutoff', 'water_heater'] });

    await writeFile(path.join(directory, 'notes.txt'), 'not an image');
    expect(await main(['check', 'notes.txt'], harness([], { SPACECONTEXT_API_KEY: KEY }).io)).toBe(2);
  });

  it('prints the transcript asked for with --transcript, with the time of each segment', async () => {
    const said = {
      ...document,
      transcript: {
        text: 'This is the kitchen. The fuse box is behind the coats.',
        segments: [
          { id: 'seg_1', start_ms: 1200, end_ms: 3000, text: 'This is the kitchen.' },
          { id: 'seg_2', start_ms: 65_000, end_ms: 68_000, text: 'The fuse box is behind the coats.' },
        ],
      },
    };
    const h = harness([(call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(call.search.get('include') === 'transcript' ? said : document) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID, '--transcript'], h.io)).toBe(0);
    expect(h.calls[0]!.search.get('include')).toBe('transcript');
    expect(h.stdout()).toMatch(/\nTranscript\n  0:01 This is the kitchen\.\n  1:05 The fuse box is behind the coats\.\n$/);

    // Without segments, the text; without either, said so; without --transcript, nothing.
    const textOnly = harness([(call) => (call.path === `/spaces/${SPACE_ID}` ? json({ ...said, transcript: { text: said.transcript.text, segments: [] } }) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID, '--transcript'], textOnly.io)).toBe(0);
    expect(textOnly.stdout()).toContain('Transcript\n  This is the kitchen. The fuse box is behind the coats.\n');
    const silent = harness([(call) => (call.path === `/spaces/${SPACE_ID}` ? json({ ...said, transcript: { text: null, segments: [] } }) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID, '--transcript'], silent.io)).toBe(0);
    expect(silent.stdout()).toContain('Transcript\n  Nothing was said.\n');
    const plain = harness(h.routes, { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID], plain.io)).toBe(0);
    expect(plain.stdout()).not.toContain('Transcript');
  });

  it('shows which key locations a scan filmed', async () => {
    const withChecklist = {
      ...document,
      coverage: {
        warnings: [],
        not_documented: [],
        checklist: [
          { kind: 'electrical_panel', seen: true, probability: 0.9, evidence: [] },
          { kind: 'water_heater', seen: false, probability: 0.1, evidence: [] },
        ],
      },
    };
    const h = harness([(call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(withChecklist) : undefined)], { SPACECONTEXT_API_KEY: KEY });
    expect(await main(['space', SPACE_ID], h.io)).toBe(0);
    expect(h.stdout()).toContain('Key locations filmed: electrical panel\nNot filmed: water heater');
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
      (call) => (call.method === 'GET' && call.path === `/scans/${SCAN_ID}/events` ? stream([failed]) : undefined),
    ], { SPACECONTEXT_API_KEY: KEY });

    expect(await main(['scan', 'tour.mov', '--space', SPACE_ID, '--language', 'nl'], h.io)).toBe(1);
    // Not a live scan: nothing is charged, whatever the price.
    expect(h.stderr()).toContain(' · test mode, no charge');
    expect(JSON.parse(String(h.calls[0]!.body)).input).toMatchObject({ kind: 'video', language: 'nl', video: { content_type: 'video/quicktime', content_length: 4 } });
    expect(h.stderr()).toContain('Error [ANALYSIS_EMPTY]: Scan failed: No space recognised (refunded)');

    for (const args of [
      ['scan', 'tour.mov'],
      ['scan', 'tour.mov', '--space', SPACE_ID, '--name', 'Flat'],
      ['scan', 'missing.mp4', '--space', SPACE_ID],
      ['scan', 'tour.mov', '--space', SPACE_ID, '--language', 'ja'],
      ['scan', 'tour.mov', '--name', 'Flat', '--type', 'castle'],
    ]) {
      expect(await main(args, h.io), args.join(' ')).toBe(2);
    }
    expect(h.stderr()).toContain('--language must be one of en, it, es, fr, de, pt, nl');
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

  it('sends the saved key only to the API it was saved for, whatever --base-url or SPACECONTEXT_BASE_URL name', async () => {
    const h = harness([me], { SPACECONTEXT_BASE_URL: '' });
    delete h.io.env.SPACECONTEXT_BASE_URL;
    expect(await main(['login', '--key', KEY], h.io)).toBe(0);
    // Saved for the default API: no base URL saved.
    expect(JSON.parse(await readFile(path.join(directory, 'config', 'config.json'), 'utf8'))).toEqual({ apiKey: KEY });
    const checked = h.calls.length;

    expect(await main(['whoami', '--base-url', 'https://elsewhere.example/v1'], h.io)).toBe(2);
    expect(h.stderr()).toContain('The saved key is for https://api.spacecontext.app/v1: it is not sent to https://elsewhere.example/v1');
    expect(h.stderr()).toContain('drop --base-url to use the saved key');
    h.io.env.SPACECONTEXT_BASE_URL = 'https://staging.example/v1';
    expect(await main(['spaces'], h.io)).toBe(2);
    expect(h.stderr()).toContain('`spacecontext login --base-url https://staging.example/v1`');
    expect(h.stderr()).toContain('unset SPACECONTEXT_BASE_URL to use the saved key');
    expect(h.calls).toHaveLength(checked);

    // The same API written another way is the same API.
    h.io.env.SPACECONTEXT_BASE_URL = 'https://api.spacecontext.app/v1/';
    expect(await main(['whoami'], h.io)).toBe(0);
    expect(h.urls.at(-1)).toBe('https://api.spacecontext.app/v1/me');
    // A key given with the command goes where the command says.
    h.io.env.SPACECONTEXT_BASE_URL = 'https://staging.example/v1';
    expect(await main(['whoami', '--api-key', 'sc_live_stagingkey'], h.io)).toBe(0);
    expect(h.urls.at(-1)).toBe('https://staging.example/v1/me');
    expect(h.calls.at(-1)!.headers.get('authorization')).toBe('Bearer sc_live_stagingkey');
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
    expect(h.urls.at(-1)).toMatch(/^https:\/\/api\.spacecontext\.app\/v1\/me/);
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

    // A phone video in 4K: how to make it fit, not only that it does not.
    const video = path.join(directory, 'IMG_0042.MOV');
    await writeFile(video, '');
    await truncate(video, 390 * 1024 * 1024);
    expect(await main(['scan', 'IMG_0042.MOV', '--name', 'Flat'], h.io)).toBe(2);
    expect(h.stderr()).toContain('IMG_0042.MOV is 390.0 MB: a video can be up to 100 MB');
    expect(h.stderr()).toContain('Record at 1080p (iPhone: Settings > Camera > Record Video > 1080p)');
    expect(h.stderr()).toContain('`ffmpeg -i IMG_0042.MOV -vf scale=-2:1080 -c:v libx264 -crf 26 -c:a aac out.mp4`');
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

describe('the published package', () => {
  it('ships its licence, which npm does not take from the repository, and is built (with the SDK first) when packed', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[]; engines: { node: string }; scripts: Record<string, string> };
    expect(manifest.scripts.prepack).toBe('npm run build --prefix ../sdk && npm run build');
    expect(manifest.engines.node).toBe('>=22.12.0');
    expect(manifest.files).toContain('LICENSE');
    expect(await readFile(new URL('../LICENSE', import.meta.url), 'utf8')).toBe(await readFile(new URL('../../../LICENSE', import.meta.url), 'utf8'));
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
