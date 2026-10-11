import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.js';
import { COMMAND_HELP } from '../src/terminal/help.js';
import { closest, colorEnabled, duration, Status, styleFor, table } from '../src/terminal/ui.js';

/** How the CLI looks: help, errors and their next steps, terminals and pipes, NO_COLOR, and --json left alone. */

const KEY = 'sc_live_outputtestkey0123456789';
const TEST_KEY = 'sc_test_outputtestkey0123456789';
const BASE = 'https://api.example.test/v1';
const SCAN_ID = `scn_${'c'.repeat(32)}`;
const SPACE_ID = `spc_${'d'.repeat(32)}`;
const SGR = /\u001b\[[0-9;]*m/;

type Call = { method: string; path: string };
type Route = (call: Call) => Response | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (code: string, status: number, extra: Record<string, unknown> = {}) => json({ error: { code, message: `${code} message`, request_id: 'req_out', ...extra } }, status);
const stream = (states: unknown[]) =>
  new Response(states.map((state, index) => `event: scan\nid: ${index + 1}\ndata: ${JSON.stringify(state)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

function scan(status: string, extra: Record<string, unknown> = {}) {
  return {
    object: 'scan', id: SCAN_ID, space_id: SPACE_ID, livemode: true, status, stage: null,
    input: { kind: 'frames', language: 'en', frame_count: 1, video: null, has_transcript: false },
    charge: { kind: 'free_scan', price_cents: 100, refunded: false }, error: null, upload: null, created_at: null, started_at: null, completed_at: null,
    ...extra,
  };
}

const document = {
  object: 'space_document',
  space: { id: SPACE_ID, source: 'api', name: 'Seaside flat' },
  scan: { id: SCAN_ID, analyzed_at: '2026-10-11T10:00:00.000Z' },
  enrichment: { level: 'deep', status: 'complete' },
  summary: 'A flat by the sea.',
  stats: { areas: 1, items: 2, issues: 1, key_locations: 1, facts: 0 },
  areas: [{ id: 'area_1', name: 'Hallway' }],
  items: [{ id: 'itm_1', area_id: 'area_1', name: 'Coat rack' }, { id: 'itm_2', area_id: 'area_1', name: 'Fuse box' }],
  issues: [{ id: 'iss_1', area_id: 'area_1', title: 'Scuffed wall', severity: 'low' }],
  key_locations: [{ id: 'loc_1', kind: 'electrical_panel', label: 'Fuse box', area_id: 'area_1', location: 'behind the coats' }],
  coverage: { warnings: [], not_documented: [], checklist: [] },
};

/** A whole scan of one photo into an existing space. */
const scanRoutes: Route[] = [
  (call) => (call.method === 'POST' && call.path === `/spaces/${SPACE_ID}/scans` ? json(scan('awaiting_upload'), 201) : undefined),
  (call) => (call.method === 'PUT' ? json({ object: 'scan_frame', scan_id: SCAN_ID, bytes: 3 }) : undefined),
  (call) => (call.method === 'POST' && call.path === `/scans/${SCAN_ID}/start` ? json(scan('queued'), 202) : undefined),
  (call) => (call.path === `/scans/${SCAN_ID}/events` ? stream([scan('queued'), scan('processing', { stage: 'observing' }), scan('complete')]) : undefined),
  (call) => (call.method === 'GET' && call.path === `/spaces/${SPACE_ID}` ? json(document) : undefined),
];

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'spacecontext-output-'));
  await mkdir(path.join(directory, 'photos'));
  await writeFile(path.join(directory, 'photos', 'frame-1.jpg'), new Uint8Array([0xff, 0xd8, 1]));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function harness(routes: Route[], options: { env?: Record<string, string>; terminal?: Io['terminal']; onCall?: (call: Call) => void } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  let clock = 0;
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: { SPACECONTEXT_CONFIG_DIR: path.join(directory, 'config'), SPACECONTEXT_BASE_URL: BASE, HOME: directory, ...options.env },
    cwd: directory,
    prompt: null,
    openBrowser: null,
    now: () => (clock += 1500),
    columns: 80,
    ...(options.terminal ? { terminal: options.terminal } : {}),
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call = { method: init.method ?? 'GET', path: new URL(String(input)).pathname.replace(/^\/v1/, '') };
      calls.push(call);
      options.onCall?.(call);
      for (const route of routes) {
        const response = route(call);
        if (response) return response;
      }
      return apiError('NOT_FOUND', 404);
    }) as typeof fetch,
  };
  return { io, calls, stdout: () => out.join(''), stderr: () => err.join('') };
}

const TTY = { stdin: true, stdout: true, stderr: true };

describe('help', () => {
  it('lists every command by group, with examples, and shows each command on its own', async () => {
    const h = harness([]);
    expect(await main([], h.io)).toBe(2);
    const help = h.stdout();
    expect(help.split('\n')[0]).toBe('◆ Space Context  CLI 0.2.0');
    for (const group of ['Get started', 'Scan a space', 'Read a space', 'Export', 'Account', 'Examples', 'Options']) expect(help).toContain(`\n${group}\n`);
    for (const [name, command] of Object.entries(COMMAND_HELP)) {
      expect(help).toContain(`  ${name.padEnd(12)}  ${command.summary}\n`);
      const one = harness([]);
      expect(await main([name, '--help'], one.io), name).toBe(0);
      expect(one.stdout()).toContain(`◆ spacecontext ${name}\n  ${command.summary}\n`);
      expect(one.stdout()).toContain(`  spacecontext ${command.usage[0]}`);
      for (const line of one.stdout().split('\n')) expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(80);
    }
    // The help fits a terminal of 80 columns, and is plain text when piped.
    for (const line of help.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(help).not.toMatch(SGR);

    const topic = harness([]);
    expect(await main(['help', 'scan'], topic.io)).toBe(0);
    expect(topic.stdout()).toContain('--no-wait');
    expect(topic.stdout()).toContain('Video: .mp4 .mov .m4v .3gp .webm .mkv, up to 4 GB and 10 minutes');
    expect(topic.stdout()).toContain('A bigger video is compressed to fit (H.264 MP4) when ffmpeg is\n  installed; --compress makes any video smaller first, for a slow connection.');
    expect(topic.stdout()).toMatch(/--compress +Re-encode to a smaller H\.264 file before uploading\n/);
    expect(topic.stdout()).toMatch(/--no-compress +Never compress: a video over the limit is refused\n/);
    expect(topic.stdout()).not.toContain('100 MB');
    expect(topic.stdout()).not.toContain('1080p');
    expect(topic.stdout()).toContain('Languages: en English, it Italiano, es Español, fr Français, de Deutsch,\n             pt Português, nl Nederlands\n');
    expect(await main(['help', 'teleport'], topic.io)).toBe(2);
    expect(topic.stderr()).toContain('No command "teleport"');
  });

  it('suggests the command or option meant, and refuses options a command does not take', async () => {
    const h = harness([]);
    expect(await main(['scna', 'video.mp4'], h.io)).toBe(2);
    expect(h.stderr()).toContain('✗ Unknown command "scna"\n  › Did you mean `spacecontext scan`?\n');
    expect(await main(['spaces', '--limt', '3'], h.io)).toBe(2);
    expect(h.stderr()).toContain('✗ Unknown option --limt\n  › Did you mean --limit?\n');
    expect(await main(['spaces', '--limit', '3'], h.io)).toBe(2);
    expect(h.stderr()).toContain('✗ spaces does not take --limit\n  › `spacecontext spaces --help` shows its options\n');
    expect(await main(['login', '--key'], h.io)).toBe(2);
    expect(h.stderr()).toContain('✗ --key needs a value');
    // Names every object has are not commands.
    for (const name of ['constructor', 'toString', '__proto__']) expect(await main([name], h.io), name).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('shows the usage and the next step when an argument is missing', async () => {
    const h = harness([], { env: { SPACECONTEXT_API_KEY: KEY } });
    expect(await main(['ask'], h.io)).toBe(2);
    expect(h.stderr()).toBe(
      '✗ Missing space id\n  Usage: spacecontext ask <space-id> <question…>\n  › `spacecontext spaces` lists your space ids\n  › `spacecontext ask --help` shows its options\n'
    );
    const scanUsage = harness([], { env: { SPACECONTEXT_API_KEY: KEY } });
    expect(await main(['scan', 'photos'], scanUsage.io)).toBe(2);
    expect(scanUsage.stderr()).toContain('Usage: spacecontext scan <video|photos-dir> --name <name> [options]\n         spacecontext scan <video|photos-dir> --space <space-id> [options]\n');

    const signedOut = harness([]);
    expect(await main(['spaces'], signedOut.io)).toBe(2);
    expect(signedOut.stderr()).toBe(
      '✗ Not signed in: no API key\n  › Sign in: `spacecontext login` (or `spacecontext login --test` for a free test key)\n  › Or set SPACECONTEXT_API_KEY, or pass --api-key\n'
    );
    // A key that is not one is refused without being echoed.
    const malformed = harness([]);
    expect(await main(['spaces', '--api-key', 'hunter2-secret'], malformed.io)).toBe(2);
    expect(malformed.stderr()).toContain('--api-key is not a Space Context key');
    expect(malformed.stderr()).not.toContain('hunter2');
    expect([...signedOut.calls, ...malformed.calls]).toEqual([]);
  });
});

describe('errors say what to do next', () => {
  it('names the console page, the command to run, or the variable to fix', async () => {
    const cases: Array<{ args: string[]; response: Response; env?: Record<string, string>; expected: string[] }> = [
      { args: ['scan', 'photos', '--space', SPACE_ID], response: apiError('PAYMENT_METHOD_REQUIRED', 402), expected: ['https://spacecontext.app/developers/console/billing/', '`spacecontext login --test`'] },
      { args: ['scan', 'photos', '--space', SPACE_ID], response: apiError('INSUFFICIENT_FUNDS', 402), expected: ['Top up the balance in the console: https://spacecontext.app/developers/console/billing/', '`spacecontext wallet`'] },
      { args: ['whoami'], response: apiError('INVALID_TOKEN', 401), expected: ['which wins over the saved one', 'fix or unset it, then run `spacecontext login`'] },
      { args: ['whoami', '--api-key', KEY], response: apiError('INVALID_TOKEN', 401), env: { SPACECONTEXT_API_KEY: '' }, expected: ['Check the key given with --api-key'] },
      { args: ['space', 'spc_missing'], response: apiError('NOT_FOUND', 404), expected: ['`spacecontext spaces` lists the spaces this key can read'] },
      { args: ['space', 'spc_missing'], response: apiError('NOT_FOUND', 404), env: { SPACECONTEXT_API_KEY: TEST_KEY }, expected: ['A test key sees only the demo (spc_demo)'] },
      { args: ['space', '--transcript', SPACE_ID], response: apiError('INSUFFICIENT_SCOPE', 403, { required_scopes: ['spaces:sensitive'] }), expected: ['need a key with spaces:sensitive', 'https://spacecontext.app/developers/console/keys/'] },
      { args: ['search', 'ladder'], response: apiError('RATE_LIMIT_EXCEEDED', 429, { daily_limit: 1000 }), expected: ['resets at midnight UTC'] },
    ];
    for (const { args, response, env, expected } of cases) {
      const routes: Route[] = args[0] === 'scan' ? [scanRoutes[0]!, scanRoutes[1]!, (call) => (call.path.endsWith('/start') ? response.clone() : undefined), () => new Response(null, { status: 204 })] : [() => response.clone()];
      const h = harness(routes, { env: { SPACECONTEXT_API_KEY: KEY, ...env } });
      expect(await main(args, h.io), args.join(' ')).toBe(1);
      const code = (await response.clone().json()).error.code as string;
      expect(h.stderr()).toContain(`✗ Error [${code}]: ${code} message (request req_out)\n  › `);
      for (const text of expected) expect(h.stderr(), args.join(' ')).toContain(text);
    }
  });

  it('tells how to follow a scan that goes on after Ctrl+C', async () => {
    const handlers: Array<() => void> = [];
    const h = harness(scanRoutes, {
      env: { SPACECONTEXT_API_KEY: KEY },
      // Ctrl+C while the scan is being followed.
      onCall: (call) => {
        if (call.path === `/scans/${SCAN_ID}/events`) for (const handler of [...handlers].reverse()) handler();
      },
    });
    h.io.onInterrupt = (handler) => {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    };
    expect(await main(['scan', 'photos', '--space', SPACE_ID], h.io)).toBe(0);
    expect(h.stderr()).toContain(`! Stopped following. The scan goes on on the server:\n  › \`spacecontext scan-status ${SCAN_ID} --follow\`\n`);
    // Not the message for an interrupted upload.
    expect(h.stderr()).not.toContain('Interrupted during the upload');
    // Every handler is removed once the command is done.
    expect(handlers).toEqual([]);
  });
});

describe('terminals, pipes and --json', () => {
  it('prints plain lines when piped: no colours, no spinner, nothing rewritten', async () => {
    const h = harness(scanRoutes, { env: { SPACECONTEXT_API_KEY: KEY } });
    expect(await main(['scan', 'photos', '--space', SPACE_ID], h.io)).toBe(0);
    expect(h.stderr()).toBe(
      [
        `◆ Scanning photos (1 photo, 1 KB) into ${SPACE_ID}`,
        '› Uploading 1 photo…',
        '✓ Uploaded 1 photo  1 KB in 2s',
        `✓ Scan started  ${SCAN_ID} · free scan`,
        '› Queued…',
        '› Looking at the frames…',
        '✓ Scan complete in 12s',
        '',
      ].join('\n')
    );
    expect(h.stdout()).toContain('Key locations\n  Fuse box — behind the coats, Hallway\n');
    expect(h.stdout()).toContain('Issues\n  low     Scuffed wall — Hallway\n');
    expect(h.stdout() + h.stderr()).not.toMatch(/\u001b|\r/);
  });

  it('draws a live status line with colours at a terminal, and no colours with NO_COLOR', async () => {
    const h = harness(scanRoutes, { env: { SPACECONTEXT_API_KEY: KEY }, terminal: TTY });
    expect(await main(['scan', 'photos', '--space', SPACE_ID], h.io)).toBe(0);
    const err = h.stderr();
    // A spinner line, rewritten in place, then a ✓ line with the step's time.
    expect(err).toContain('\r\u001b[2K');
    expect(err).toContain('Looking at the frames…');
    expect(err).toContain('\u001b[32m✓\u001b[39m Looking at the frames  \u001b[2m');
    expect(err).toContain('\u001b[1mScan complete\u001b[22m');
    expect(h.stdout()).toContain('\u001b[1mSeaside flat\u001b[22m');

    const plain = harness(scanRoutes, { env: { SPACECONTEXT_API_KEY: KEY, NO_COLOR: '1' }, terminal: TTY });
    expect(await main(['scan', 'photos', '--space', SPACE_ID], plain.io)).toBe(0);
    expect(plain.stdout() + plain.stderr()).not.toMatch(SGR);
    // Still a terminal: the status line still moves.
    expect(plain.stderr()).toContain('\r\u001b[2K');

    // A terminal that cannot take it, and CI logs: plain lines only.
    const envs: Array<Record<string, string>> = [{ TERM: 'dumb' }, { CI: 'true', NO_COLOR: '1' }];
    for (const env of envs) {
      const dumb = harness(scanRoutes, { env: { SPACECONTEXT_API_KEY: KEY, ...env }, terminal: TTY });
      expect(await main(['scan', 'photos', '--space', SPACE_ID], dumb.io)).toBe(0);
      expect(dumb.stdout() + dumb.stderr(), JSON.stringify(env)).not.toMatch(/\u001b|\r/);
      expect(dumb.stderr()).toContain('› Looking at the frames…\n');
    }
  });

  it('keeps --json exactly the API response, with nothing on stderr, even at a terminal', async () => {
    const h = harness(scanRoutes, { env: { SPACECONTEXT_API_KEY: KEY }, terminal: TTY });
    // The exit code is 0, never what writing to stdout returned (`true` made Node throw).
    expect(await main(['scan', 'photos', '--space', SPACE_ID, '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual(document);
    expect(h.stdout()).toBe(`${JSON.stringify(document, null, 2)}\n`);
    expect(h.stderr()).toBe('');

    const spaces = [{ object: 'space', id: SPACE_ID, source: 'api', name: 'Seaside flat', space_type: 'apartment', created_at: 'x', updated_at: 'x', latest_scan: null }];
    const list = harness([(call) => (call.path === '/spaces' ? json({ object: 'list', data: spaces, next_cursor: null }) : undefined)], { env: { SPACECONTEXT_API_KEY: KEY }, terminal: TTY });
    expect(await main(['spaces', '--json'], list.io)).toBe(0);
    expect(list.stdout()).toBe(`${JSON.stringify(spaces, null, 2)}\n`);
    expect(list.stderr()).toBe('');
  });

  it('lists spaces as a table, cutting long names to the terminal only', async () => {
    const name = 'A very long name for a holiday home by the sea with a garden';
    const spaces = [
      { object: 'space', id: 'spc_demo', source: 'api', name: 'Brisbane apartment', space_type: 'apartment', created_at: 'x', updated_at: 'x', latest_scan: { id: 'scn_1', analyzed_at: '2026-10-05T10:00:00Z', areas: 6, items: 48, issues: 3 } },
      { object: 'space', id: SPACE_ID, source: 'api', name, space_type: 'house', created_at: 'x', updated_at: 'x', latest_scan: null },
    ];
    const routes: Route[] = [(call) => (call.path === '/spaces' ? json({ object: 'list', data: spaces, next_cursor: null }) : undefined)];
    const piped = harness(routes, { env: { SPACECONTEXT_API_KEY: KEY } });
    expect(await main(['spaces'], piped.io)).toBe(0);
    const lines = piped.stdout().split('\n');
    expect(lines[0]).toMatch(/^ID {2,}NAME {2,}SCANNED {2,}ITEMS {2}ISSUES$/);
    expect(lines[1]).toMatch(/^spc_demo {2,}Brisbane apartment {2,}2026-10-05 {5}48 {7}3$/);
    expect(lines[2]).toContain(`${SPACE_ID}  ${name}  no scan`);
    expect(piped.stdout()).toContain('2 spaces · spacecontext space <id> shows one');

    const narrow = harness(routes, { env: { SPACECONTEXT_API_KEY: KEY, NO_COLOR: '1' }, terminal: TTY });
    expect(await main(['spaces'], narrow.io)).toBe(0);
    expect(narrow.stdout()).toMatch(/ A very long[^ ]* ?[^ ]*… /);
    for (const line of narrow.stdout().split('\n')) expect(line.length).toBeLessThan(80);
  });
});

describe('terminal helpers', () => {
  it('decides colours from NO_COLOR, FORCE_COLOR, TERM and the stream', () => {
    const io = (env: Record<string, string>, stderr = true): Io => ({ stdout: () => {}, stderr: () => {}, env, cwd: '/', prompt: null, terminal: { stdin: false, stdout: false, stderr } });
    expect(colorEnabled(io({}), 'stderr')).toBe(true);
    expect(colorEnabled(io({}), 'stdout')).toBe(false);
    expect(colorEnabled(io({ NO_COLOR: '1' }), 'stderr')).toBe(false);
    // NO_COLOR set but empty does not count (no-color.org).
    expect(colorEnabled(io({ NO_COLOR: '' }), 'stderr')).toBe(true);
    expect(colorEnabled(io({ TERM: 'dumb' }), 'stderr')).toBe(false);
    expect(colorEnabled(io({ FORCE_COLOR: '1' }, false), 'stderr')).toBe(true);
    expect(colorEnabled(io({ FORCE_COLOR: '0' }), 'stderr')).toBe(false);
    expect(colorEnabled(io({ FORCE_COLOR: '1', NO_COLOR: '1' }), 'stderr')).toBe(false);
  });

  it('formats durations, tables and typos', () => {
    expect([0, 4_400, 59_600, 61_000, 3_725_000].map(duration)).toEqual(['0s', '4s', '1m 00s', '1m 01s', '1h 02m']);
    const s = styleFor({ stdout: () => {}, stderr: () => {}, env: {}, cwd: '/', prompt: null }, 'stdout');
    expect(table(s, ['A', 'NAME', 'N'], [['x', 'a long name here', '7'], ['yy', 'short', '12']], { right: [2] })).toBe('A   NAME               N\nx   a long name here   7\nyy  short             12\n');
    expect(table(s, ['A', 'NAME'], [['x', 'a long name here']], { shrink: 1, width: 16 })).toBe('A  NAME\nx  a long name…\n');
    expect(closest('scna', ['scan', 'scans', 'space'])).toBe('scan');
    expect(closest('wallett', ['wallet', 'whoami'])).toBe('wallet');
    expect(closest('teleport', ['scan', 'space'])).toBeNull();
  });

  it('prints one plain line per step when piped, and a ✓ line per step at a terminal', () => {
    let clock = 0;
    const lines: string[] = [];
    const base = { stdout: () => {}, stderr: (text: string) => lines.push(text), env: {}, cwd: '/', prompt: null, now: () => (clock += 1000) };
    const piped = new Status(base);
    piped.step('Queued');
    piped.step('Looking at the frames');
    piped.step('Quick', { plain: false });
    piped.complete();
    piped.complete('Done', 'detail');
    expect(lines.join('')).toBe('› Queued…\n› Looking at the frames…\n✓ Done  detail\n');

    lines.length = 0;
    const live = new Status({ ...base, terminal: { stdin: true, stdout: true, stderr: true }, env: { NO_COLOR: '1' } });
    live.step('Queued');
    live.step('Observing');
    live.fail();
    live.stop();
    const text = lines.join('');
    expect(text).toContain('\r\u001b[2K✓ Queued  ');
    expect(text).toContain('\r\u001b[2K✗ Observing  ');
    expect(text.endsWith('\n')).toBe(true);
  });
});
