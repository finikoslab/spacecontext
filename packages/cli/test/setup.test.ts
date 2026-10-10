import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.js';
import { BILLING_URL, bundledSkill, MCP_URL, SKILL_URL } from '../src/setup.js';
import { findExecutable, needsShell, runProgram, writeFileAtomic, type RunOptions, type RunResult } from '../src/system.js';

const LIVE_KEY = 'sc_live_setupkey0123456789';
const TEST_KEY = 'sc_test_setupkey0123456789';
const BASE = 'https://api.example.test/v1';
const REMOTE_SKILL = '---\nname: spacecontext\ndescription: Spaces you filmed.\n---\n\n# Space Context (from the site)\n';

type Call = { method: string; path: string; headers: Headers; body: unknown };
type Route = (call: Call) => Response | undefined;
type Ran = { file: string; args: string[]; options: RunOptions };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (code: string, status: number) => json({ error: { code, message: code, request_id: 'req_setup' } }, status);

let directory: string;
let home: string;
let configDir: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'spacecontext-setup-'));
  home = path.join(directory, 'home');
  configDir = path.join(directory, 'config');
  await mkdir(home);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The API: /me answers for the key it is given; the wallet and the device sign-in as asked. */
function api(options: { wallet?: Record<string, unknown> | Response; device?: 'approve' | 'deny'; approvedKey?: string; revoked?: string[] } = {}): Route[] {
  const approvedKey = options.approvedKey ?? LIVE_KEY;
  const mode = (key: string) => (key.startsWith('sc_test_') ? 'test' : 'live');
  return [
    (call) => {
      if (call.method !== 'GET' || call.path !== '/me') return undefined;
      const key = call.headers.get('authorization')!.slice('Bearer '.length);
      if (options.revoked?.includes(key)) return apiError('INVALID_TOKEN', 401);
      return json({ user: { id: 'u1', email: 'dev@example.com', is_pro: false }, key: { id: 'key_1', mode: mode(key), scopes: ['spaces:read', 'scans:read'] } });
    },
    (call) => {
      if (call.method !== 'GET' || call.path !== '/wallet') return undefined;
      if (options.wallet instanceof Response) return options.wallet;
      return json({
        object: 'wallet',
        currency: 'usd',
        balance_cents: 0,
        free_scans_remaining: 1,
        scan_price_cents: 100,
        auto_recharge: { enabled: false, threshold_cents: null, amount_cents: null, payment_method_saved: false, last_error: null },
        ...options.wallet,
      });
    },
    (call) =>
      call.method === 'POST' && call.path === '/auth/device'
        ? json({ device_code: `scd_${'a'.repeat(43)}`, user_code: 'BCDF-2345', verification_url: 'https://spacecontext.example/developers/console/authorize/', expires_in: 600, interval: 0 }, 201)
        : undefined,
    (call) => {
      if (call.method !== 'POST' || call.path !== '/auth/device/token') return undefined;
      if (options.device === 'deny') return apiError('ACCESS_DENIED', 403);
      return json({
        api_key: approvedKey,
        key: { id: 'key_2', name: 'CLI · CLI on host', mode: mode(approvedKey), prefix: approvedKey.slice(0, 12), scopes: ['spaces:read', 'scans:read', 'scans:write'], monthly_cap_cents: null, created_at: '2026-10-10T10:00:00.000Z' },
        user: { id: 'u1', email: 'dev@example.com', name: null, is_pro: false },
      });
    },
  ];
}

type Harness = {
  io: Io;
  ran: Ran[];
  calls: Call[];
  opened: string[];
  stdout: () => string;
  stderr: () => string;
};

/**
 * Everything setup touches is fake or temporary: the API and the site (fetch),
 * the programs on PATH (`which`), the programs it runs (`run`), the browser, and
 * a home directory of its own.
 */
function harness(
  options: {
    routes?: Route[];
    programs?: Record<string, string>;
    respond?: (ran: Ran) => Partial<RunResult> | undefined;
    skill?: string | 'offline' | Response;
    env?: Record<string, string>;
    terminal?: Io['terminal'];
    platform?: NodeJS.Platform;
  } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const ran: Ran[] = [];
  const calls: Call[] = [];
  const opened: string[] = [];
  const routes = options.routes ?? api();
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === SKILL_URL) {
      const skill = options.skill ?? REMOTE_SKILL;
      if (skill === 'offline') throw new TypeError('fetch failed');
      return skill instanceof Response ? skill : new Response(skill, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
    }
    expect(url.startsWith(`${BASE}/`), url).toBe(true);
    const call: Call = { method: init.method ?? 'GET', path: new URL(url).pathname.replace(/^\/v1/, ''), headers: new Headers(init.headers), body: init.body };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    return apiError('NOT_FOUND', 404);
  }) as typeof globalThis.fetch;
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: { HOME: home, SPACECONTEXT_CONFIG_DIR: configDir, SPACECONTEXT_BASE_URL: BASE, ...options.env },
    cwd: directory,
    prompt: null,
    fetch,
    openBrowser: (url) => opened.push(url),
    run: async (file, args, runOptions) => {
      const entry = { file, args: [...args], options: runOptions };
      ran.push(entry);
      const result: RunResult = { code: 0, output: '', timedOut: false, stopped: false, ...options.respond?.(entry) };
      if (result.output) runOptions.onOutput?.(result.output);
      return result;
    },
    which: async (program) => options.programs?.[program] ?? null,
    platform: options.platform ?? 'linux',
    ...(options.terminal ? { terminal: options.terminal } : {}),
  };
  return { io, ran, calls, opened, stdout: () => out.join(''), stderr: () => err.join('') };
}

const ALL_PROGRAMS = { claude: '/usr/local/bin/claude', codex: '/usr/local/bin/codex', code: '/usr/local/bin/code' };

/** How the real clients answer: Codex starts its own OAuth login after adding a server that supports it. */
function clients(overrides: Partial<Record<string, Partial<RunResult>>> = {}) {
  return (ran: Ran): Partial<RunResult> | undefined => {
    const command = `${path.basename(ran.file)} ${ran.args.slice(0, 2).join(' ')}`;
    if (overrides[command]) return overrides[command];
    if (command === 'claude mcp add') return { output: `Added HTTP MCP server spacecontext with URL: ${MCP_URL} to user config\n` };
    if (command === 'codex mcp list') return { output: '[]' };
    if (command === 'codex mcp add') return { code: null, stopped: true, output: "Added global MCP server 'spacecontext'.\nDetected OAuth support. Starting OAuth flow…\n" };
    return { output: '' };
  };
}

function summary(h: Harness): { steps: Array<{ id: string; status: string; detail: string }>; next: string[] } {
  return JSON.parse(h.stdout());
}

/** What `claude mcp get spacecontext` prints for an HTTP server. */
const claudeGet = (url: string, scope = 'User config (available in all your projects)') =>
  `spacecontext:\n  Scope: ${scope}\n  Status: ! Needs authentication\n  Type: http\n  URL: ${url}\n\nTo remove this server, run: claude mcp remove "spacecontext" -s user\n`;

const cursorFile = () => path.join(home, '.cursor', 'mcp.json');
const skillFile = () => path.join(home, '.claude', 'skills', 'spacecontext', 'SKILL.md');

describe('spacecontext setup', () => {
  it('signs in, connects every assistant found, installs the skill and asks for a card, with a JSON summary for agents', async () => {
    await mkdir(path.join(home, '.cursor'));
    const h = harness({ programs: ALL_PROGRAMS, respond: clients() });

    expect(await main(['setup', '--yes', '--json'], h.io)).toBe(0);

    // stdout carries the summary and nothing else.
    const result = summary(h);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ['sign-in', 'done'],
      ['mcp:claude-code', 'done'],
      ['mcp:codex', 'done'],
      ['mcp:cursor', 'done'],
      ['mcp:vscode', 'done'],
      ['skill', 'done'],
      ['card', 'skipped'],
    ]);
    expect(result.steps[0]!.detail).toContain('Signed in as dev@example.com (live, spaces:read, scans:read, scans:write)');

    // 1. The device sign-in: the code is shown on stderr, no browser with --yes, and the key goes only to the config file.
    expect(h.calls.filter((call) => call.path.startsWith('/auth/device')).map((call) => call.path)).toEqual(['/auth/device', '/auth/device/token']);
    expect(JSON.parse(String(h.calls[0]!.body))).toMatchObject({ mode: 'live' });
    expect(h.stderr()).toContain('enter this code:  BCDF-2345');
    expect(h.opened).toEqual([]);
    const config = path.join(configDir, 'config.json');
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ apiKey: LIVE_KEY });
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect(h.stdout() + h.stderr()).not.toContain(LIVE_KEY);
    expect(JSON.stringify(h.ran)).not.toContain(LIVE_KEY);

    // 2. Each client's own command, with an argument array and a timeout; Codex is stopped once the server is saved.
    expect(h.ran.map((ran) => [ran.file, ...ran.args])).toEqual([
      ['/usr/local/bin/claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'spacecontext', MCP_URL],
      ['/usr/local/bin/codex', 'mcp', 'list', '--json'],
      ['/usr/local/bin/codex', 'mcp', 'add', 'spacecontext', '--url', MCP_URL],
      ['/usr/local/bin/code', '--add-mcp', JSON.stringify({ name: 'spacecontext', type: 'http', url: MCP_URL })],
    ]);
    for (const ran of h.ran) {
      expect(ran.options.timeoutMs).toBeGreaterThan(0);
      expect(ran.options.stdin ?? 'ignore').toBe('ignore');
    }
    expect(h.ran[2]!.options.stopWhen?.test("Added global MCP server 'spacecontext'.")).toBe(true);
    expect(JSON.parse(await readFile(cursorFile(), 'utf8'))).toEqual({ mcpServers: { spacecontext: { url: MCP_URL } } });

    // 3. The published skill.
    expect(await readFile(skillFile(), 'utf8')).toBe(REMOTE_SKILL);

    // 4. No card on file: the link, never a card prompt, and no browser with --yes.
    expect(result.next).toContain(`Live scans need a card on file (a saved card, or a top-up already paid) — add a card or funds in Billing: ${BILLING_URL}`);

    // 5. What is left for the person, then the SDK and the docs.
    expect(result.next).toEqual(
      expect.arrayContaining([
        expect.stringContaining('run /mcp and choose Authenticate'),
        expect.stringContaining('codex mcp login spacecontext'),
        expect.stringContaining('Cursor: open its MCP settings'),
        expect.stringContaining('MCP: List Servers'),
        expect.stringContaining(`Settings → Connectors → add a custom connector with ${MCP_URL}`),
        expect.stringContaining('Docs: https://spacecontext.app/developers/docs/'),
      ])
    );
    const code = result.next.find((item) => item.startsWith('Code: npm install @spacecontext/sdk'))!;
    expect(code.split('\n').slice(1)).toHaveLength(4);
    expect(code).toContain("sc.spaces.ask('<space-id>'");
    expect(code).toContain('npx spacecontext spaces');
    // The step lines went to stderr, as they happened.
    expect(h.stderr()).toContain('✓ Claude Code  MCP server added (user scope)');
    expect(h.stderr()).not.toContain('\u001b[');
  });

  it('finds an earlier setup in place and changes nothing', async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ apiKey: LIVE_KEY }));
    await mkdir(path.join(home, '.cursor'));
    const cursorConfig = `${JSON.stringify({ mcpServers: { spacecontext: { url: MCP_URL } } })}\n`;
    await writeFile(cursorFile(), cursorConfig);
    await mkdir(path.dirname(skillFile()), { recursive: true });
    await writeFile(skillFile(), REMOTE_SKILL);
    const h = harness({
      programs: ALL_PROGRAMS,
      routes: api({ wallet: { balance_cents: 1250, auto_recharge: { enabled: false, payment_method_saved: true } } }),
      respond: clients({
        'claude mcp add': { code: 1, output: 'MCP server spacecontext already exists in user config\n' },
        'claude mcp get': { output: claudeGet(MCP_URL) },
        'codex mcp list': { output: JSON.stringify([{ name: 'spacecontext', enabled: true, transport: { type: 'streamable_http', url: MCP_URL }, auth_status: 'o_auth' }]) },
      }),
    });

    expect(await main(['setup'], h.io)).toBe(0);
    const out = h.stdout();
    expect(out).toContain('✓ Sign in      Signed in as dev@example.com (the saved key: live, spaces:read, scans:read)');
    expect(out).toContain('✓ Claude Code  MCP server already added');
    expect(out).toContain('✓ Codex        MCP server already added and signed in');
    expect(out).toContain('✓ Cursor       Already in ~/.cursor/mcp.json');
    expect(out).toContain('✓ Skill        Up to date in ~/.claude/skills/spacecontext/SKILL.md');
    expect(out).toContain('✓ Card         Card on file: US$12.50, 1 free scan left');
    expect(out).toContain('\nNext:\n  • Claude Code: restart it if it is running');
    expect(out).not.toContain('codex mcp login');
    // The SDK snippet, indented under its item.
    expect(out).toContain("\n      import { SpaceContext } from '@spacecontext/sdk';\n");
    // No sign-in, no Codex add, no file rewritten.
    expect(h.calls.some((call) => call.path.startsWith('/auth/device'))).toBe(false);
    expect(h.ran.some((ran) => ran.args[1] === 'add' && ran.file.endsWith('codex'))).toBe(false);
    expect(await readFile(cursorFile(), 'utf8')).toBe(cursorConfig);
    await expect(stat(`${cursorFile()}.bak`)).rejects.toThrow();
    // Nothing is opened when nothing is missing.
    expect(h.opened).toEqual([]);
  });

  it('keeps a Claude Code "spacecontext" server that points elsewhere, and replaces it in the user scope only with --yes', async () => {
    const DEV_URL = 'https://mcp-dev.spacecontext.app/mcp';
    const claude = { claude: '/usr/bin/claude' };
    const exists = { code: 1, output: 'MCP server spacecontext already exists in user config\n' };
    const step = (h: Harness) => summary(h).steps.find((entry) => entry.id === 'mcp:claude-code');
    const commands = (h: Harness) => h.ran.map((ran) => ran.args.slice(0, 2).join(' '));

    // Without --yes: kept, said so, and not counted as connected.
    let h = harness({ programs: claude, respond: clients({ 'claude mcp add': exists, 'claude mcp get': { output: claudeGet(DEV_URL) } }) });
    expect(await main(['setup', '--client', 'claude-code', '--skip-login', '--skip-skill', '--json'], h.io)).toBe(1);
    expect(step(h)).toEqual({ id: 'mcp:claude-code', status: 'skipped', detail: `Claude Code already has a "spacecontext" server for ${DEV_URL}: kept it (--yes replaces it)` });
    expect(commands(h)).toEqual(['mcp add', 'mcp get']);

    // With --yes: removed from the user scope and added again, pointing here.
    let adds = 0;
    h = harness({
      programs: claude,
      respond: (ran) => {
        const command = ran.args.slice(0, 2).join(' ');
        if (command === 'mcp add') return adds++ === 0 ? exists : { output: `Added HTTP MCP server spacecontext with URL: ${MCP_URL} to user config\n` };
        if (command === 'mcp get') return { output: claudeGet(DEV_URL) };
        return { output: 'Removed MCP server "spacecontext" from user config\n' };
      },
    });
    expect(await main(['setup', '--client', 'claude-code', '--skip-login', '--skip-skill', '--yes', '--json'], h.io)).toBe(0);
    expect(step(h)).toEqual({ id: 'mcp:claude-code', status: 'done', detail: `MCP server added (user scope), replacing the one for ${DEV_URL}` });
    expect(h.ran.map((ran) => ran.args)).toEqual([
      ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'spacecontext', MCP_URL],
      ['mcp', 'get', 'spacecontext'],
      ['mcp', 'remove', '--scope', 'user', 'spacecontext'],
      ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'spacecontext', MCP_URL],
    ]);

    // A server run as a command is replaced the same way; a local one, which Claude Code uses first, is never touched.
    h = harness({ programs: claude, respond: clients({ 'claude mcp add': exists, 'claude mcp get': { output: 'spacecontext:\n  Scope: Local config (private to you in this project)\n  Status: ✔ Connected\n  Type: stdio\n  Command: node\n  Args: server.js\n' } }) });
    expect(await main(['setup', '--client', 'claude-code', '--skip-login', '--skip-skill', '--yes', '--json'], h.io)).toBe(1);
    expect(step(h)).toMatchObject({ status: 'skipped', detail: expect.stringContaining('server for a command from its Local config') });
    expect(commands(h)).toEqual(['mcp add', 'mcp get']);

    // When the entry cannot be read, nothing is claimed.
    h = harness({ programs: claude, respond: clients({ 'claude mcp add': exists, 'claude mcp get': { code: null, timedOut: true } }) });
    expect(await main(['setup', '--client', 'claude-code', '--skip-login', '--skip-skill', '--yes', '--json'], h.io)).toBe(1);
    expect(step(h)).toMatchObject({ status: 'skipped', detail: expect.stringContaining('claude mcp get spacecontext') });
  });

  it('adds itself to ~/.cursor/mcp.json keeping every other server, backs the original up once, and never touches a file it cannot read', async () => {
    await mkdir(path.join(home, '.cursor'));
    const original = { theme: 'dark', mcpServers: { github: { command: 'gh-mcp', args: ['--stdio'] } } };
    await writeFile(cursorFile(), JSON.stringify(original, null, 4));
    const run = async (...args: string[]) => {
      const h = harness();
      const code = await main(['setup', '--client', 'cursor', '--skip-login', '--skip-skill', '--json', ...args], h.io);
      return { code, h, step: summary(h).steps.find((step) => step.id === 'mcp:cursor')! };
    };

    let result = await run();
    expect(result.code).toBe(0);
    expect(result.step).toMatchObject({ status: 'done', detail: 'Added to ~/.cursor/mcp.json (the original is in mcp.json.bak)' });
    expect(JSON.parse(await readFile(cursorFile(), 'utf8'))).toEqual({ theme: 'dark', mcpServers: { github: original.mcpServers.github, spacecontext: { url: MCP_URL } } });
    expect(JSON.parse(await readFile(`${cursorFile()}.bak`, 'utf8'))).toEqual(original);
    // No temporary file left behind.
    expect((await readdir(path.join(home, '.cursor'))).sort()).toEqual(['mcp.json', 'mcp.json.bak']);

    // Another server called spacecontext: kept without --yes, replaced with it; the first backup stays.
    await writeFile(cursorFile(), JSON.stringify({ mcpServers: { spacecontext: { url: 'http://localhost:8788/mcp' } } }));
    result = await run();
    expect(result.code).toBe(1);
    expect(result.step).toMatchObject({ status: 'skipped' });
    expect(result.step.detail).toContain('pointing elsewhere: kept it (--yes replaces it)');
    expect(JSON.parse(await readFile(cursorFile(), 'utf8')).mcpServers.spacecontext.url).toBe('http://localhost:8788/mcp');
    result = await run('--yes');
    expect(result.step.status).toBe('done');
    expect(JSON.parse(await readFile(cursorFile(), 'utf8')).mcpServers.spacecontext.url).toBe(MCP_URL);
    expect(JSON.parse(await readFile(`${cursorFile()}.bak`, 'utf8'))).toEqual(original);

    // A file with comments (or anything else that is not JSON) is left as it is.
    const commented = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    await writeFile(cursorFile(), commented);
    result = await run('--yes');
    expect(result.code).toBe(1);
    expect(result.step.status).toBe('failed');
    expect(result.step.detail).toContain('~/.cursor/mcp.json is not valid JSON, so it was left untouched');
    expect(await readFile(cursorFile(), 'utf8')).toBe(commented);
    await writeFile(cursorFile(), JSON.stringify({ mcpServers: ['not', 'an', 'object'] }));
    result = await run('--yes');
    expect(result.step.status).toBe('failed');

    // Missing: created, with the folder.
    await rm(path.join(home, '.cursor'), { recursive: true });
    result = await run();
    expect(result.step).toMatchObject({ status: 'done', detail: 'Created ~/.cursor/mcp.json' });
    expect(JSON.parse(await readFile(cursorFile(), 'utf8'))).toEqual({ mcpServers: { spacecontext: { url: MCP_URL } } });
  });

  it('installs the skill from the site, or the copy shipped with the CLI when offline, and never overwrites local changes without --yes', async () => {
    const run = async (skill: string | 'offline' | Response, ...args: string[]) => {
      const h = harness({ skill });
      const code = await main(['setup', '--skip-login', '--skip-mcp', '--json', ...args], h.io);
      return { code, h, step: summary(h).steps.find((step) => step.id === 'skill')!, next: summary(h).next };
    };
    const bundled = await bundledSkill();

    // Offline: the bundled copy.
    let result = await run('offline');
    expect(result.code).toBe(0);
    expect(result.step).toMatchObject({ status: 'done' });
    expect(result.step.detail).toContain('Installed in ~/.claude/skills/spacecontext/SKILL.md (the copy shipped with the CLI');
    expect(await readFile(skillFile(), 'utf8')).toBe(bundled);

    // A newer published version replaces a copy setup wrote.
    result = await run(REMOTE_SKILL);
    expect(result.step).toMatchObject({ status: 'done', detail: 'Updated in ~/.claude/skills/spacecontext/SKILL.md' });
    expect(await readFile(skillFile(), 'utf8')).toBe(REMOTE_SKILL);
    const newer = REMOTE_SKILL.replace('(from the site)', '(newer)');
    result = await run(newer);
    expect(result.step.status).toBe('done');
    expect(await readFile(skillFile(), 'utf8')).toBe(newer);

    // Edited by the person: kept, and said where it is; replaced only with --yes, with a backup.
    const edited = `${newer}\nMy own notes.\n`;
    await writeFile(skillFile(), edited);
    result = await run(REMOTE_SKILL);
    expect(result.step).toMatchObject({ status: 'skipped', detail: '~/.claude/skills/spacecontext/SKILL.md has local changes: kept it (--yes replaces it)' });
    expect(result.next.some((item) => item.includes('~/.claude/skills/spacecontext/SKILL.md has changes of yours'))).toBe(true);
    expect(await readFile(skillFile(), 'utf8')).toBe(edited);
    result = await run(REMOTE_SKILL, '--yes');
    expect(result.step.status).toBe('done');
    expect(result.step.detail).toContain('yours is in SKILL.md.bak');
    expect(await readFile(skillFile(), 'utf8')).toBe(REMOTE_SKILL);
    expect(await readFile(`${skillFile()}.bak`, 'utf8')).toBe(edited);

    // Anything that is not the skill (a redirect, an error page, another file) counts as offline.
    for (const answer of [
      new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/SKILL.md' } }),
      new Response('<html>maintenance</html>', { status: 200 }),
      new Response('---\nname: something-else\n---\n# Other\n'),
      new Response('Not found', { status: 404 }),
    ]) {
      await rm(skillFile());
      result = await run(answer);
      expect(result.step.status).toBe('done');
      // The site may well be up (a 404 before a deploy): the detail says the download failed, not that it was unreachable.
      expect(result.step.detail).toContain('the published one could not be downloaded from spacecontext.app');
      expect(await readFile(skillFile(), 'utf8')).toBe(bundled);
    }
  });

  it('ships a copy of the plugin skill, identical to it', async () => {
    const plugin = await readFile(new URL('../../../plugins/spacecontext/skills/spacecontext/SKILL.md', import.meta.url), 'utf8');
    expect(await bundledSkill()).toBe(plugin);
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[]; scripts: { build: string } };
    expect(manifest.files).toContain('skill');
    expect(manifest.scripts.build).toContain('bundle-skill.mjs');
  });

  it('runs the Codex login only for a person at a terminal, without --yes', async () => {
    const terminal = { stdin: true, stdout: true, stderr: true };
    // A Codex that adds the server without starting a login: setup runs `codex mcp login` in the terminal.
    let h = harness({
      programs: { codex: '/opt/bin/codex' },
      terminal,
      respond: clients({ 'codex mcp add': { output: "Added global MCP server 'spacecontext'.\n" }, 'codex mcp login': { output: 'Successfully logged in.\n' } }),
    });
    expect(await main(['setup', '--client', 'codex', '--skip-login', '--skip-skill'], h.io)).toBe(0);
    expect(h.ran.map((ran) => ran.args.slice(0, 2).join(' '))).toEqual(['mcp list', 'mcp add', 'mcp login']);
    expect(h.ran[1]!.options).toMatchObject({ stdin: 'inherit' });
    expect(h.ran[1]!.options.stopWhen).toBeUndefined();
    expect(h.ran[2]!.args).toEqual(['mcp', 'login', 'spacecontext']);
    expect(h.stdout()).toContain('✓\u001b[0m Codex        MCP server added and signed in');
    // What Codex printed was shown to the person, on stderr.
    expect(h.stderr()).toContain('Successfully logged in.');
    // Colours at a terminal, none with NO_COLOR.
    expect(h.stdout()).toContain('\u001b[32m✓\u001b[0m');

    // A Codex that logs in while adding: no second login.
    h = harness({
      programs: { codex: '/opt/bin/codex' },
      terminal,
      env: { NO_COLOR: '1' },
      respond: clients({ 'codex mcp add': { output: "Added global MCP server 'spacecontext'.\nDetected OAuth support. Starting OAuth flow…\nSuccessfully logged in.\n" } }),
    });
    expect(await main(['setup', '--client', 'codex', '--skip-login', '--skip-skill'], h.io)).toBe(0);
    expect(h.ran.map((ran) => ran.args[1])).toEqual(['list', 'add']);
    expect(h.stdout()).not.toContain('\u001b[');

    // Already added but not signed in, with --yes: nothing interactive, the login is a next step.
    h = harness({
      programs: { codex: '/opt/bin/codex' },
      terminal,
      respond: clients({ 'codex mcp list': { output: JSON.stringify([{ name: 'spacecontext', transport: { type: 'streamable_http', url: MCP_URL }, auth_status: 'not_logged_in' }]) } }),
    });
    expect(await main(['setup', '--client', 'codex', '--skip-login', '--skip-skill', '--yes', '--json'], h.io)).toBe(0);
    expect(h.ran.map((ran) => ran.args[1])).toEqual(['list']);
    expect(summary(h).steps.find((step) => step.id === 'mcp:codex')).toMatchObject({ status: 'done', detail: 'MCP server already added; sign in with `codex mcp login spacecontext`' });
    expect(summary(h).next).toContain('Codex: run `codex mcp login spacecontext` and approve in the browser.');

    // Codex has another "spacecontext": kept.
    h = harness({
      programs: { codex: '/opt/bin/codex' },
      respond: clients({ 'codex mcp list': { output: JSON.stringify([{ name: 'spacecontext', transport: { type: 'stdio', command: 'my-server' } }]) } }),
    });
    expect(await main(['setup', '--client', 'codex', '--skip-login', '--skip-skill', '--json'], h.io)).toBe(1);
    expect(summary(h).steps.find((step) => step.id === 'mcp:codex')).toMatchObject({ status: 'skipped' });
    expect(h.ran.map((ran) => ran.args[1])).toEqual(['list']);
  });

  it('chooses the clients: found ones by default, named ones, or all; and says what failed with the command to run by hand', async () => {
    // Nothing found: nothing connected, exit 1, and the way to do it by hand.
    let h = harness();
    expect(await main(['setup', '--skip-login', '--skip-skill', '--json'], h.io)).toBe(1);
    expect(summary(h).steps).toEqual([
      { id: 'sign-in', status: 'skipped', detail: '--skip-login (no key yet)' },
      { id: 'mcp', status: 'skipped', detail: 'Found none of Claude Code, Codex, Cursor or VS Code on this machine' },
      { id: 'skill', status: 'skipped', detail: '--skip-skill' },
      { id: 'card', status: 'skipped', detail: 'No key to read the wallet with' },
    ]);
    expect(summary(h).next).toEqual(expect.arrayContaining([expect.stringContaining('npx spacecontext login'), expect.stringContaining('Settings → Connectors')]));

    // Named but not installed: failed; with all: skipped (Cursor is written anyway).
    h = harness();
    expect(await main(['setup', '--client', 'codex,claude-code', '--skip-login', '--skip-skill', '--json'], h.io)).toBe(1);
    expect(summary(h).steps.filter((step) => step.id.startsWith('mcp:'))).toEqual([
      { id: 'mcp:claude-code', status: 'failed', detail: `\`claude\` is not on PATH: install Claude Code, or run: claude mcp add --transport http --scope user spacecontext ${MCP_URL}` },
      { id: 'mcp:codex', status: 'failed', detail: `\`codex\` is not on PATH: install Codex, or run: codex mcp add spacecontext --url ${MCP_URL}` },
    ]);
    h = harness();
    expect(await main(['setup', '--client', 'all', '--skip-login', '--skip-skill', '--json'], h.io)).toBe(0);
    expect(summary(h).steps.filter((step) => step.id.startsWith('mcp:')).map((step) => [step.id, step.status])).toEqual([
      ['mcp:claude-code', 'skipped'],
      ['mcp:codex', 'skipped'],
      ['mcp:cursor', 'done'],
      ['mcp:vscode', 'skipped'],
    ]);

    // A client that fails: one line of why, the command to run by hand, and the others still run.
    h = harness({
      programs: { claude: '/usr/bin/claude', code: '/usr/bin/code' },
      respond: clients({ 'claude mcp add': { code: 1, output: "error: unknown option '--transport'\n" } }),
    });
    expect(await main(['setup', '--client', 'claude-code,vscode', '--skip-login', '--skip-skill', '--json'], h.io)).toBe(0);
    expect(summary(h).steps.find((step) => step.id === 'mcp:claude-code')).toEqual({
      id: 'mcp:claude-code',
      status: 'failed',
      detail: `claude: error: unknown option '--transport'; run: claude mcp add --transport http --scope user spacecontext ${MCP_URL}`,
    });
    expect(summary(h).steps.find((step) => step.id === 'mcp:vscode')?.status).toBe('done');

    // A program that does not answer in time, and Windows batch files (they need a shell): never run that way.
    h = harness({ programs: { code: 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', claude: '/usr/bin/claude' }, respond: clients({ 'claude mcp add': { code: null, timedOut: true } }), platform: 'win32' });
    expect(await main(['setup', '--client', 'claude-code,vscode', '--skip-login', '--skip-skill', '--json'], h.io)).toBe(1);
    expect(summary(h).steps.find((step) => step.id === 'mcp:claude-code')?.detail).toContain('claude did not finish within 30 s');
    expect(summary(h).steps.find((step) => step.id === 'mcp:vscode')?.detail).toContain("runs only through a shell; run: code --add-mcp '");
    expect(h.ran.map((ran) => ran.file)).toEqual(['/usr/bin/claude']);

    // Wrong usage.
    h = harness();
    expect(await main(['setup', '--client', 'emacs'], h.io)).toBe(2);
    expect(h.stderr()).toContain('--client takes claude-code, codex, cursor, vscode or all');
    expect(await main(['setup', 'now'], h.io)).toBe(2);
  });

  it('signs in again when the saved key is of the other mode or no longer accepted, and never replaces a key it was given', async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ apiKey: LIVE_KEY }));

    // --test with a saved live key: a test key replaces it; a test key needs no card.
    let h = harness({ routes: api({ approvedKey: TEST_KEY }) });
    expect(await main(['setup', '--test', '--skip-mcp', '--skip-skill', '--json', '--no-browser'], h.io)).toBe(0);
    expect(JSON.parse(String(h.calls.find((call) => call.path === '/auth/device')!.body))).toMatchObject({ mode: 'test' });
    expect(h.stderr()).toContain('The saved key is a live key: signing in for a test key.');
    expect(h.stderr()).not.toContain('card on file');
    expect(JSON.parse(await readFile(path.join(configDir, 'config.json'), 'utf8'))).toEqual({ apiKey: TEST_KEY });
    expect(summary(h).steps.find((step) => step.id === 'card')).toEqual({ id: 'card', status: 'skipped', detail: 'Test key: no card needed' });
    expect(summary(h).next.find((item) => item.startsWith('Code:'))).toContain("sc.spaces.ask('spc_demo'");
    expect(h.opened).toEqual([]);

    // And back to live.
    h = harness({ routes: api({ approvedKey: LIVE_KEY, wallet: { auto_recharge: { enabled: false, payment_method_saved: true } } }) });
    expect(await main(['setup', '--skip-mcp', '--skip-skill', '--json', '--no-browser'], h.io)).toBe(0);
    expect(h.stderr()).toContain('The saved key is a test key: signing in for a live key.');
    expect(JSON.parse(await readFile(path.join(configDir, 'config.json'), 'utf8'))).toEqual({ apiKey: LIVE_KEY });

    // A revoked saved key: sign in again (the browser opens without --yes or --no-browser).
    h = harness({ routes: api({ revoked: [LIVE_KEY, 'sc_live_revoked'], approvedKey: 'sc_live_newkey0123456789', wallet: { auto_recharge: { enabled: false, payment_method_saved: true } } }) });
    await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ apiKey: 'sc_live_revoked' }));
    expect(await main(['setup', '--skip-mcp', '--skip-skill', '--json'], h.io)).toBe(0);
    expect(h.stderr()).toContain('The saved key is no longer accepted: signing in again.');
    expect(h.opened).toEqual(['https://spacecontext.example/developers/console/authorize/']);
    expect(JSON.parse(await readFile(path.join(configDir, 'config.json'), 'utf8'))).toEqual({ apiKey: 'sc_live_newkey0123456789' });

    // A key from the environment is used as it is: never replaced, and a wrong mode is said.
    h = harness({ env: { SPACECONTEXT_API_KEY: LIVE_KEY } });
    expect(await main(['setup', '--test', '--skip-mcp', '--skip-skill', '--json'], h.io)).toBe(1);
    expect(summary(h).steps[0]).toEqual({ id: 'sign-in', status: 'failed', detail: 'SPACECONTEXT_API_KEY holds a live key, not a test one: drop --test, or unset it' });
    expect(h.calls.some((call) => call.path.startsWith('/auth/device'))).toBe(false);
    h = harness({ env: { SPACECONTEXT_API_KEY: LIVE_KEY } });
    expect(await main(['setup', '--skip-mcp', '--skip-skill', '--json'], h.io)).toBe(0);
    expect(summary(h).steps[0]!.detail).toBe('Signed in as dev@example.com (SPACECONTEXT_API_KEY: live, spaces:read, scans:read)');
  });

  it('keeps going when the sign-in is denied, and exits 1', async () => {
    const h = harness({ routes: api({ device: 'deny' }), programs: { claude: '/usr/bin/claude' }, respond: clients() });
    expect(await main(['setup', '--yes', '--json'], h.io)).toBe(1);
    const steps = summary(h).steps;
    expect(steps[0]).toMatchObject({ id: 'sign-in', status: 'failed' });
    expect(steps[0]!.detail).toContain('ACCESS_DENIED');
    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ['sign-in', 'failed'],
      ['mcp:claude-code', 'done'],
      ['skill', 'done'],
      ['card', 'skipped'],
    ]);
    expect(summary(h).next[0]).toContain('npx spacecontext login');
    await expect(readFile(path.join(configDir, 'config.json'))).rejects.toThrow();
  });

  it('reads the card and the balance in live mode only, and opens Billing only when a person runs it', async () => {
    const live = async (wallet: Record<string, unknown> | Response, ...args: string[]) => {
      const h = harness({ routes: api({ wallet }), env: { SPACECONTEXT_API_KEY: LIVE_KEY } });
      await main(['setup', '--skip-mcp', '--skip-skill', '--json', ...args], h.io);
      return { h, step: summary(h).steps.find((step) => step.id === 'card')! };
    };
    const recharge = (extra: Record<string, unknown>) => ({ enabled: false, threshold_cents: null, amount_cents: null, payment_method_saved: false, last_error: null, ...extra });

    // The API says whether the account has a card on file (a saved card, or a top-up already paid).
    let result = await live({ auto_recharge: recharge({ card_on_file: false }) });
    expect(result.step).toEqual({ id: 'card', status: 'skipped', detail: 'No card on file yet (1 free scan left)' });
    expect(summary(result.h).next).toContain(`Live scans need a card on file — add one in Billing (nothing is charged): ${BILLING_URL}`);
    expect(result.h.opened).toEqual([BILLING_URL]);
    expect((await live({ auto_recharge: recharge({ card_on_file: false }) }, '--no-browser')).h.opened).toEqual([]);

    // A top-up paid without saving the card, spent down to nothing: a card on file all the same; only funds are missing.
    result = await live({ balance_cents: 0, free_scans_remaining: 0, auto_recharge: recharge({ card_on_file: true }) });
    expect(result.step).toEqual({ id: 'card', status: 'done', detail: 'Card on file (a paid top-up): US$0.00, 0 free scans left' });
    expect(summary(result.h).next).toContain(`Add funds before your next live scan (US$1.00 each): ${BILLING_URL}`);
    expect(summary(result.h).next.some((item) => item.startsWith('Live scans need a card'))).toBe(false);
    expect(result.h.opened).toEqual([]);

    // An API without card_on_file: no saved card and no balance cannot be told apart from a top-up spent, so both are offered.
    result = await live({});
    expect(result.step).toEqual({ id: 'card', status: 'skipped', detail: 'No saved card and no balance (1 free scan left)' });
    expect(summary(result.h).next).toContain(`Live scans need a card on file (a saved card, or a top-up already paid) — add a card or funds in Billing: ${BILLING_URL}`);
    expect(result.h.opened).toEqual([BILLING_URL]);

    // A balance stands for a paid top-up.
    result = await live({ balance_cents: 1000, free_scans_remaining: 0 });
    expect(result.step).toEqual({ id: 'card', status: 'done', detail: 'Prepaid balance: US$10.00, 0 free scans left' });
    expect(summary(result.h).next.some((item) => item.startsWith('Add funds'))).toBe(false);
    expect(result.h.opened).toEqual([]);

    result = await live(apiError('INSUFFICIENT_SCOPE', 403));
    expect(result.step).toMatchObject({ status: 'skipped', detail: expect.stringContaining('needs scans:read') });
    result = await live(apiError('INTERNAL_ERROR', 500));
    expect(result.step).toMatchObject({ status: 'failed', detail: expect.stringContaining('Could not read the wallet') });
  });
});

describe('setup system helpers', () => {
  it('finds programs on absolute PATH entries only, executable files only', async () => {
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'claude'), '#!/bin/sh\n');
    await chmod(path.join(bin, 'claude'), 0o755);
    await writeFile(path.join(bin, 'codex'), 'not executable');
    await chmod(path.join(bin, 'codex'), 0o644);
    await mkdir(path.join(bin, 'code'));
    const env = { PATH: ['relative/bin', bin].join(path.delimiter) };
    expect(await findExecutable('claude', env, 'linux')).toBe(path.join(bin, 'claude'));
    expect(await findExecutable('codex', env, 'linux')).toBeNull();
    expect(await findExecutable('code', env, 'linux')).toBeNull();
    expect(await findExecutable('claude', { PATH: 'bin' }, 'linux')).toBeNull();
    expect(needsShell('C:\\x\\code.cmd')).toBe(true);
    expect(needsShell('/usr/bin/code')).toBe(false);
  });

  it('runs a program with an argument array, never a shell, and stops it on time or on cue', async () => {
    const node = process.execPath;
    const literal = '$(echo injected); echo also-injected';
    const echoed = await runProgram(node, ['-e', 'process.stdout.write(process.argv[1])', literal], { timeoutMs: 10_000 });
    expect(echoed).toMatchObject({ code: 0, output: literal, timedOut: false, stopped: false });

    const slow = await runProgram(node, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 200 });
    expect(slow).toMatchObject({ code: null, timedOut: true });

    const cued = await runProgram(node, ['-e', "console.log('Added global MCP server'); setTimeout(() => {}, 60_000)"], { timeoutMs: 10_000, stopWhen: /Added global MCP server/ });
    expect(cued).toMatchObject({ code: null, stopped: true, timedOut: false });

    const missing = await runProgram(path.join(directory, 'no-such-program'), [], { timeoutMs: 1_000 });
    expect(missing.code).toBeNull();
    expect(missing.error).toContain('ENOENT');
  });

  it('replaces a file in one step, through a symlink, keeping its permissions', async () => {
    const real = path.join(directory, 'dotfiles', 'mcp.json');
    await mkdir(path.dirname(real));
    await writeFile(real, '{}');
    await chmod(real, 0o640);
    const link = path.join(directory, 'mcp.json');
    await symlink(real, link);
    await writeFileAtomic(link, '{"a":1}\n');
    expect(await readlink(link)).toBe(real);
    expect(await readFile(real, 'utf8')).toBe('{"a":1}\n');
    expect((await stat(real)).mode & 0o777).toBe(0o640);
    await writeFileAtomic(path.join(directory, 'new', 'file.json'), 'x');
    expect(await readFile(path.join(directory, 'new', 'file.json'), 'utf8')).toBe('x');
  });
});
