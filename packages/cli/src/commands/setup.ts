import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { SpaceContext, SpaceContextError } from '@spacecontext/sdk';
import type { Io } from '../cli.js';
import { apiUrl, configDirectory, readConfig, setting } from '../lib/config.js';
import { UsageError } from '../lib/files.js';
import { BILLING_URL, DOCS_URL, KEYS_URL } from '../lib/links.js';
import { deviceLogin, openInBrowser } from './signin.js';
import { findExecutable, needsShell, runProgram, writeFileAtomic, type RunResult, type Runner } from '../lib/system.js';
import { brandHeader, brandLine, styleFor, type Style } from '../terminal/ui.js';

/**
 * `spacecontext setup`: sign in, connect the assistants found on this machine
 * to the MCP server, install the skill, check the card on file, and say what
 * is left to do. Every step reports done, skipped or failed and none stops the
 * others. The API key is only ever written by `deviceLogin` (the CLI's config
 * file) and never printed.
 */

export const MCP_URL = 'https://mcp.spacecontext.app/mcp';
export const SKILL_URL = 'https://spacecontext.app/.well-known/agent-skills/spacecontext/SKILL.md';
export { BILLING_URL };
const SERVER = 'spacecontext';

/** A client's own command (`claude mcp add`…). */
const COMMAND_TIMEOUT_MS = 30_000;
/** A login the person completes in the browser. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const SKILL_FETCH_TIMEOUT_MS = 10_000;
const MAX_SKILL_BYTES = 256 * 1024;

export type SetupOptions = {
  /** `--client`: a comma-separated list of claude-code, codex, cursor, vscode, all. Default: the clients found. */
  clients?: string | undefined;
  test: boolean;
  /** No questions and no browser: for agents. */
  yes: boolean;
  json: boolean;
  noBrowser: boolean;
  skipLogin: boolean;
  skipMcp: boolean;
  skipSkill: boolean;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
};

export type StepStatus = 'done' | 'skipped' | 'failed';
export type Step = { id: string; status: StepStatus; detail: string };
export type SetupSummary = { steps: Step[]; next: string[] };

const CLIENTS = ['claude-code', 'codex', 'cursor', 'vscode'] as const;
type Client = (typeof CLIENTS)[number];

const CLIENT_NAMES: Record<Client, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', vscode: 'VS Code' };
const PROGRAMS: Record<Client, string> = { 'claude-code': 'claude', codex: 'codex', cursor: 'cursor', vscode: 'code' };

const CURSOR_ENTRY = { url: MCP_URL };
const VSCODE_ENTRY = JSON.stringify({ name: SERVER, type: 'http', url: MCP_URL });

/** What the person does by hand when setup could not. */
const BY_HAND: Record<Client, string> = {
  'claude-code': `claude mcp add --transport http --scope user ${SERVER} ${MCP_URL}`,
  codex: `codex mcp add ${SERVER} --url ${MCP_URL}`,
  cursor: `add {"mcpServers":{"${SERVER}":{"url":"${MCP_URL}"}}} to ~/.cursor/mcp.json`,
  vscode: `code --add-mcp '${VSCODE_ENTRY}'`,
};

/** What the person does after a client was set up: each one signs in with OAuth in the browser. */
const AFTER: Record<Client, string> = {
  'claude-code': 'Claude Code: restart it if it is running, then run /mcp and choose Authenticate for spacecontext.',
  codex: 'Codex: run `codex mcp login spacecontext` and approve in the browser.',
  cursor: 'Cursor: open its MCP settings and click Login next to spacecontext.',
  vscode: 'VS Code: run "MCP: List Servers" from the Command Palette, start spacecontext and sign in when asked.',
};

const CONNECTORS = `Claude (claude.ai, Claude Desktop): Settings → Connectors → add a custom connector with ${MCP_URL}; ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode, then create a connector with the same URL.`;
const SIGN_IN = 'Sign in: run `npx spacecontext login` and approve the code in the browser (`--test` for a free test key).';

const LABELS: Record<string, string> = {
  'sign-in': 'Sign in',
  mcp: 'Assistants',
  'mcp:claude-code': 'Claude Code',
  'mcp:codex': 'Codex',
  'mcp:cursor': 'Cursor',
  'mcp:vscode': 'VS Code',
  skill: 'Skill',
  card: 'Card',
};

function mark(s: Style, status: StepStatus): string {
  return status === 'done' ? s.ok : status === 'failed' ? s.fail : s.yellow('–');
}

type Run = {
  io: Io;
  options: SetupOptions;
  home: string;
  platform: NodeJS.Platform;
  run: Runner;
  which: (program: string) => Promise<string | null>;
  /** A person at a terminal, who can answer an interactive login. Never with `--yes`. */
  interactive: boolean;
  fetch: typeof fetch;
  /** Where the step lines go: stdout, or stderr when stdout carries the JSON summary. */
  say: (text: string) => void;
  /** Colours of the stream the step lines go to. */
  style: Style;
  steps: Step[];
  next: string[];
};

type Wanted = { kind: 'detect' } | { kind: 'all' } | { kind: 'list'; clients: Client[] };

function wantedClients(value: string | undefined): Wanted {
  if (value === undefined) return { kind: 'detect' };
  const names = value.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((name) => name !== 'all' && !CLIENTS.includes(name as Client));
  if (names.length === 0 || unknown.length > 0) {
    throw new UsageError(`--client takes ${CLIENTS.join(', ')} or all, separated by commas${unknown.length > 0 ? ` (not "${unknown[0]}")` : ''}`);
  }
  if (names.includes('all')) return { kind: 'all' };
  return { kind: 'list', clients: CLIENTS.filter((client) => names.includes(client)) };
}

function report(run: Run, id: string, status: StepStatus, detail: string): void {
  run.steps.push({ id, status, detail });
  run.say(`${mark(run.style, status)} ${(LABELS[id] ?? id).padEnd(12)} ${detail}\n`);
}

function describe(error: unknown): string {
  if (error instanceof SpaceContextError) return `${error.message} [${error.code}]`;
  return error instanceof Error ? error.message : String(error);
}

/** One line on why a program did not do its job. */
function why(result: RunResult, program: string): string {
  if (result.error) return `could not run ${program}: ${result.error}`;
  if (result.timedOut) return `${program} did not finish within ${COMMAND_TIMEOUT_MS / 1000} s`;
  const line = result.output
    .split('\n')
    .map((text) => text.trim())
    .find(Boolean);
  return line ? `${program}: ${line.slice(0, 160)}` : `${program} exited with code ${result.code}`;
}

function tilde(run: Run, file: string): string {
  return file.startsWith(run.home + path.sep) ? `~${file.slice(run.home.length)}` : file;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function keyMode(key: string): 'live' | 'test' | null {
  return key.startsWith('sc_live_') ? 'live' : key.startsWith('sc_test_') ? 'test' : null;
}

function api(run: Run, key: string, baseUrl: string | undefined): SpaceContext {
  return new SpaceContext({ apiKey: key, ...(baseUrl ? { baseUrl } : {}), ...(run.io.fetch ? { fetch: run.io.fetch } : {}) });
}

function dollars(cents: number): string {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ------------------------------------------------------------------ 1. sign in

type KeyInUse = { key: string | null; baseUrl: string | undefined };

/**
 * The key the CLI would use (`--api-key`, then SPACECONTEXT_API_KEY, then the
 * saved one), checked with the API. A device sign-in runs when there is none,
 * when the saved key is of the other mode or for another API, or when the API
 * no longer accepts it.
 */
async function signIn(run: Run): Promise<KeyInUse> {
  const { io, options } = run;
  const stored = await readConfig(configDirectory(io.env));
  const environmentKey = setting(io.env, 'SPACECONTEXT_API_KEY');
  const requested = options.baseUrl ?? setting(io.env, 'SPACECONTEXT_BASE_URL');
  // The saved key goes only to the API it was saved for, as in every command.
  const savedElsewhere = stored.apiKey !== undefined && requested !== undefined && apiUrl(requested) !== apiUrl(stored.baseUrl);
  const savedKey = savedElsewhere ? undefined : stored.apiKey;
  const source = options.apiKey ? '--api-key' : environmentKey ? 'SPACECONTEXT_API_KEY' : savedKey ? 'saved' : null;
  const key = options.apiKey ?? environmentKey ?? savedKey ?? null;
  const baseUrl = source === 'saved' ? apiUrl(stored.baseUrl) : requested;
  const wanted = options.test ? 'test' : 'live';

  if (options.skipLogin) {
    report(run, 'sign-in', 'skipped', key ? '--skip-login (the key in use is kept)' : savedElsewhere ? `--skip-login (the saved key is for ${apiUrl(stored.baseUrl)})` : '--skip-login (no key yet)');
    if (!key) run.next.push(SIGN_IN);
    return { key, baseUrl };
  }

  if (key && keyMode(key) === wanted) {
    try {
      const me = await api(run, key, baseUrl).me();
      const from = source === 'saved' ? 'the saved key' : source;
      report(run, 'sign-in', 'done', `Signed in as ${me.user.email} (${from}: ${me.key.mode}, ${me.key.scopes.join(', ')})`);
      return { key, baseUrl };
    } catch (error) {
      if (!(source === 'saved' && error instanceof SpaceContextError && error.status === 401)) {
        report(run, 'sign-in', 'failed', `Could not check the key (${source === 'saved' ? 'the saved key' : source}): ${describe(error)}`);
        return { key: null, baseUrl };
      }
      io.stderr('The saved key is no longer accepted: signing in again.\n');
    }
  } else if (key && source !== 'saved') {
    report(run, 'sign-in', 'failed', `${source} holds ${keyMode(key) ? `a ${keyMode(key)}` : 'a malformed'} key, not a ${wanted} one: ${options.test ? 'drop --test' : 'add --test'}, or unset it`);
    return { key: null, baseUrl };
  } else if (key) {
    io.stderr(`The saved key is ${keyMode(key) ? `a ${keyMode(key)} key` : 'not a valid key'}: signing in for a ${wanted} key.\n`);
  } else if (savedElsewhere) {
    io.stderr(`The saved key is for ${apiUrl(stored.baseUrl)}: signing in for ${apiUrl(requested)}.\n`);
  }

  try {
    const { signedIn } = await deviceLogin(io, { mode: wanted, baseUrl: options.baseUrl, openBrowser: !options.noBrowser && !options.yes });
    report(run, 'sign-in', 'done', `Signed in as ${signedIn.user.email} (${signedIn.key.mode}, ${signedIn.key.scopes.join(', ')}); the key is saved for the CLI`);
    return { key: signedIn.api_key, baseUrl: requested };
  } catch (error) {
    report(run, 'sign-in', 'failed', describe(error));
    run.next.push(SIGN_IN);
    return { key: null, baseUrl };
  }
}

// ------------------------------------------------------------------ 2. MCP server

/**
 * The spacecontext entry `claude mcp get spacecontext` shows (the one Claude
 * Code uses here): its URL, null for a server run as a command, and its scope
 * ("User config (…)", "Local config (…)"…). Null when it could not be read.
 */
function claudeEntry(result: RunResult): { url: string | null; scope: string | null } | null {
  if (result.code !== 0) return null;
  const field = (name: string) => new RegExp(`^\\s*${name}:[ \\t]*(\\S.*?)\\s*$`, 'mi').exec(result.output)?.[1] ?? null;
  if (field('Type') === null) return null;
  return { url: field('URL'), scope: field('Scope') };
}

/**
 * Adds the server for the user. When Claude Code already has a "spacecontext"
 * server, it is kept if it is this one; one pointing elsewhere is replaced only
 * with --yes, and only in the user scope, which setup writes.
 */
async function claudeCode(run: Run, program: string): Promise<void> {
  const id = 'mcp:claude-code';
  if (needsShell(program)) return report(run, id, 'failed', `${program} runs only through a shell; run: ${BY_HAND['claude-code']}`);
  const add = () => run.run(program, ['mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER, MCP_URL], { timeoutMs: COMMAND_TIMEOUT_MS });
  const result = await add();
  if (result.code === 0) {
    run.next.push(AFTER['claude-code']);
    return report(run, id, 'done', 'MCP server added (user scope)');
  }
  if (!/already exists/i.test(result.output)) return report(run, id, 'failed', `${why(result, 'claude')}; run: ${BY_HAND['claude-code']}`);

  const current = claudeEntry(await run.run(program, ['mcp', 'get', SERVER], { timeoutMs: COMMAND_TIMEOUT_MS }));
  if (current === null) {
    return report(run, id, 'skipped', `Claude Code already has a "${SERVER}" server, and where it points could not be read: check it with \`claude mcp get ${SERVER}\``);
  }
  if (current.url === MCP_URL) {
    run.next.push(AFTER['claude-code']);
    return report(run, id, 'done', 'MCP server already added');
  }
  const elsewhere = current.url ?? 'a command';
  if (!run.options.yes) {
    return report(run, id, 'skipped', `Claude Code already has a "${SERVER}" server for ${elsewhere}: kept it (--yes replaces it)`);
  }
  // A local or project server comes before the user's: it is not setup's to remove.
  if (current.scope !== null && !/^user\b/i.test(current.scope)) {
    return report(run, id, 'skipped', `Claude Code uses a "${SERVER}" server for ${elsewhere} from its ${current.scope}: kept it; remove it with \`claude mcp remove ${SERVER}\`, then run setup again`);
  }
  const removed = await run.run(program, ['mcp', 'remove', '--scope', 'user', SERVER], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (removed.code !== 0) return report(run, id, 'failed', `Could not replace the "${SERVER}" server for ${elsewhere}: ${why(removed, 'claude')}`);
  const added = await add();
  if (added.code !== 0) return report(run, id, 'failed', `Removed the "${SERVER}" server for ${elsewhere}, but adding this one failed: ${why(added, 'claude')}; run: ${BY_HAND['claude-code']}`);
  run.next.push(AFTER['claude-code']);
  report(run, id, 'done', `MCP server added (user scope), replacing the one for ${elsewhere}`);
}

/** The spacecontext entry of `codex mcp list --json`, when Codex has one. */
function codexEntry(result: RunResult): { url: string | null; signedIn: boolean } | null {
  if (result.code !== 0) return null;
  try {
    const servers = JSON.parse(result.output) as unknown;
    if (!Array.isArray(servers)) return null;
    const entry = servers.find((server) => isPlainObject(server) && server.name === SERVER) as Record<string, unknown> | undefined;
    if (!entry) return null;
    const transport = isPlainObject(entry.transport) ? entry.transport : {};
    return {
      url: typeof transport.url === 'string' ? transport.url : null,
      signedIn: typeof entry.auth_status === 'string' && entry.auth_status !== 'not_logged_in',
    };
  } catch {
    return null;
  }
}

/**
 * `codex mcp add` starts Codex's own OAuth login when the server supports it,
 * and that waits for a person. A person at a terminal (without --yes) goes
 * through it; otherwise Codex is stopped once the server is saved and the login
 * is left for later.
 */
async function codex(run: Run, program: string): Promise<void> {
  const id = 'mcp:codex';
  if (needsShell(program)) return report(run, id, 'failed', `${program} runs only through a shell; run: ${BY_HAND.codex}`);
  // Codex's login opens the browser: not with --no-browser.
  const interactive = run.interactive && !run.options.noBrowser;
  const live = { timeoutMs: LOGIN_TIMEOUT_MS, stdin: 'inherit' as const, onOutput: run.io.stderr };

  const current = codexEntry(await run.run(program, ['mcp', 'list', '--json'], { timeoutMs: COMMAND_TIMEOUT_MS }));
  let what: string;
  let loginTried = false;
  if (current && current.url === MCP_URL) {
    if (current.signedIn) return report(run, id, 'done', 'MCP server already added and signed in');
    what = 'MCP server already added';
  } else if (current && !run.options.yes) {
    return report(run, id, 'skipped', `Codex already has a "${SERVER}" server for ${current.url ?? 'another command'}: kept it (--yes replaces it)`);
  } else {
    const added = await run.run(
      program,
      ['mcp', 'add', SERVER, '--url', MCP_URL],
      interactive ? live : { timeoutMs: COMMAND_TIMEOUT_MS, stopWhen: /Added global MCP server/i }
    );
    if (!/Added global MCP server/i.test(added.output) && added.code !== 0) {
      return report(run, id, 'failed', `${why(added, 'codex')}; run: ${BY_HAND.codex}`);
    }
    if (/Successfully logged in/i.test(added.output)) return report(run, id, 'done', 'MCP server added and signed in');
    what = 'MCP server added';
    loginTried = interactive && /Starting OAuth/i.test(added.output);
  }
  if (interactive && !loginTried) {
    const login = await run.run(program, ['mcp', 'login', SERVER], live);
    if (login.code === 0) return report(run, id, 'done', `${what} and signed in`);
  }
  run.next.push(AFTER.codex);
  report(run, id, 'done', `${what}; sign in with \`codex mcp login ${SERVER}\``);
}

/**
 * Adds the server to ~/.cursor/mcp.json, keeping every other server. A file
 * that is not plain JSON is never touched; the original is copied once to
 * mcp.json.bak, and the new file replaces it in one step.
 */
async function cursor(run: Run): Promise<void> {
  const id = 'mcp:cursor';
  const file = path.join(run.home, '.cursor', 'mcp.json');
  const shown = tilde(run, file);
  let text: string | null = null;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (!isMissing(error)) return report(run, id, 'failed', `Could not read ${shown}: ${describe(error)}`);
  }
  let config: Record<string, unknown> = {};
  if (text !== null && text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return report(run, id, 'failed', `${shown} is not valid JSON, so it was left untouched; ${BY_HAND.cursor} yourself`);
    }
    if (!isPlainObject(parsed) || (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers))) {
      return report(run, id, 'failed', `${shown} is not shaped like {"mcpServers": {…}}, so it was left untouched; ${BY_HAND.cursor} yourself`);
    }
    config = parsed;
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const current = servers[SERVER];
  if (isPlainObject(current) && current.url === MCP_URL) {
    run.next.push(AFTER.cursor);
    return report(run, id, 'done', `Already in ${shown}`);
  }
  if (current !== undefined && !run.options.yes) {
    return report(run, id, 'skipped', `${shown} already has a "${SERVER}" server pointing elsewhere: kept it (--yes replaces it)`);
  }
  const updated = { ...config, mcpServers: { ...servers, [SERVER]: CURSOR_ENTRY } };
  try {
    if (text !== null) {
      try {
        await copyFile(file, `${file}.bak`, constants.COPYFILE_EXCL);
      } catch (error) {
        // Once: a backup from an earlier run holds the true original.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    await writeFileAtomic(file, `${JSON.stringify(updated, null, 2)}\n`);
  } catch (error) {
    return report(run, id, 'failed', `Could not write ${shown}: ${describe(error)}`);
  }
  run.next.push(AFTER.cursor);
  report(run, id, 'done', text === null ? `Created ${shown}` : `Added to ${shown} (the original is in mcp.json.bak)`);
}

async function vscode(run: Run, program: string): Promise<void> {
  const id = 'mcp:vscode';
  if (needsShell(program)) return report(run, id, 'failed', `${program} runs only through a shell; run: ${BY_HAND.vscode}`);
  const result = await run.run(program, ['--add-mcp', VSCODE_ENTRY], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (result.code !== 0) return report(run, id, 'failed', `${why(result, 'code')}; run: ${BY_HAND.vscode}`);
  run.next.push(AFTER.vscode);
  report(run, id, 'done', 'MCP server added to your VS Code profile');
}

async function connect(run: Run, wanted: Wanted): Promise<void> {
  if (run.options.skipMcp) {
    report(run, 'mcp', 'skipped', '--skip-mcp');
    run.next.push(CONNECTORS);
    return;
  }
  const [claude, codexProgram, code, cursorProgram, cursorHome] = await Promise.all([
    run.which(PROGRAMS['claude-code']),
    run.which(PROGRAMS.codex),
    run.which(PROGRAMS.vscode),
    run.which(PROGRAMS.cursor),
    exists(path.join(run.home, '.cursor')),
  ]);
  const programs: Record<Client, string | null> = { 'claude-code': claude, codex: codexProgram, vscode: code, cursor: null };
  const found = (client: Client) => (client === 'cursor' ? cursorHome || cursorProgram !== null : programs[client] !== null);

  const clients = wanted.kind === 'list' ? wanted.clients : wanted.kind === 'all' ? [...CLIENTS] : CLIENTS.filter(found);
  if (clients.length === 0) {
    report(run, 'mcp', 'skipped', 'Found none of Claude Code, Codex, Cursor or VS Code on this machine');
    run.next.push('Set up an assistant installed elsewhere: npx spacecontext setup --client claude-code (or codex, cursor, vscode).');
  }
  for (const client of clients) {
    const id = `mcp:${client}`;
    try {
      // Cursor needs only its file: written when asked for, even before Cursor is installed.
      if (client === 'cursor') {
        await cursor(run);
        continue;
      }
      const program = programs[client];
      if (!program) {
        if (wanted.kind === 'list') report(run, id, 'failed', `\`${PROGRAMS[client]}\` is not on PATH: install ${CLIENT_NAMES[client]}, or run: ${BY_HAND[client]}`);
        else report(run, id, 'skipped', 'Not installed');
        continue;
      }
      if (client === 'claude-code') await claudeCode(run, program);
      else if (client === 'codex') await codex(run, program);
      else await vscode(run, program);
    } catch (error) {
      report(run, id, 'failed', describe(error));
    }
  }
  run.next.push(CONNECTORS);
}

// ------------------------------------------------------------------ 3. skill

/** The skill shipped with the CLI: a copy of plugins/spacecontext/skills/spacecontext/SKILL.md made at build time. */
export function bundledSkill(): Promise<string> {
  return readFile(new URL('../../skill/SKILL.md', import.meta.url), 'utf8');
}

function looksLikeSkill(text: string): boolean {
  if (text.length > MAX_SKILL_BYTES || !/^---\r?\n/.test(text)) return false;
  const end = text.indexOf('\n---', 3);
  return end > 0 && /^name:\s*spacecontext\s*$/m.test(text.slice(0, end));
}

/** The published skill, or null when it cannot be had (offline, a redirect, anything that is not the skill). */
async function downloadSkill(fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(SKILL_URL, {
      headers: { Accept: 'text/markdown, text/plain;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(SKILL_FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > MAX_SKILL_BYTES) {
      await response.body?.cancel();
      return null;
    }
    const text = await response.text();
    return looksLikeSkill(text) ? text : null;
  } catch {
    return null;
  }
}

type SetupRecord = { skill?: { sha256?: string } };

/** What setup last installed (the skill's hash), to tell an old copy of ours from a copy the person edited. */
async function readRecord(file: string): Promise<SetupRecord> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return isPlainObject(parsed) ? (parsed as SetupRecord) : {};
  } catch {
    return {};
  }
}

async function writeRecord(file: string, record: SetupRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function skill(run: Run): Promise<void> {
  if (run.options.skipSkill) return report(run, 'skill', 'skipped', '--skip-skill');
  const file = path.join(run.home, '.claude', 'skills', SERVER, 'SKILL.md');
  const shown = tilde(run, file);
  const bundled = await bundledSkill().catch(() => null);
  const downloaded = await downloadSkill(run.fetch);
  const content = downloaded ?? bundled;
  if (content === null) return report(run, 'skill', 'failed', `Could not download ${SKILL_URL}, and the CLI's own copy is missing`);
  const origin = downloaded === null ? ' (the copy shipped with the CLI: the published one could not be downloaded from spacecontext.app)' : '';

  let existing: string | null = null;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if (!isMissing(error)) return report(run, 'skill', 'failed', `Could not read ${shown}: ${describe(error)}`);
  }
  if (existing === content) return report(run, 'skill', 'done', `Up to date in ${shown}`);

  const recordFile = path.join(configDirectory(run.io.env), 'setup.json');
  const record = await readRecord(recordFile);
  const ours = existing === null || existing === bundled || record.skill?.sha256 === sha256(existing);
  if (!ours && !run.options.yes) {
    run.next.push(`Skill: ${shown} has changes of yours, so it was kept; rerun with --yes to replace it (yours is then kept as SKILL.md.bak).`);
    return report(run, 'skill', 'skipped', `${shown} has local changes: kept it (--yes replaces it)`);
  }
  try {
    if (!ours) await copyFile(file, `${file}.bak`);
    await writeFileAtomic(file, content);
  } catch (error) {
    return report(run, 'skill', 'failed', `Could not write ${shown}: ${describe(error)}`);
  }
  try {
    await writeRecord(recordFile, { ...record, skill: { sha256: sha256(content) } });
  } catch {
    // Only the next run's "is it ours?" check is weaker.
  }
  const verb = existing === null ? 'Installed in' : 'Updated in';
  report(run, 'skill', 'done', `${verb} ${shown}${origin}${ours ? '' : '; yours is in SKILL.md.bak'}`);
}

// ------------------------------------------------------------------ 4. card and balance

/**
 * `card_on_file`: the API's own answer (a saved card, or a top-up already paid).
 * Absent from older API versions. The wallet a key reads says nothing else of
 * the card (`auto_recharge` has only `enabled`).
 */
type WalletCard = { card_on_file?: boolean };

async function card(run: Run, use: KeyInUse): Promise<void> {
  if (!use.key) return report(run, 'card', 'skipped', 'No key to read the wallet with');
  if (keyMode(use.key) === 'test') return report(run, 'card', 'skipped', 'Test key: no card needed');
  try {
    const wallet = await api(run, use.key, use.baseUrl).wallet();
    const free = `${wallet.free_scans_remaining} free scan${wallet.free_scans_remaining === 1 ? '' : 's'} left`;
    const onFile = (wallet as WalletCard).card_on_file;
    const openBilling = () => {
      if (!run.options.noBrowser && !run.options.yes) openInBrowser(run.io, BILLING_URL);
    };
    if (onFile === false) {
      run.next.push(`Live scans need a card on file — add one in Billing (nothing is charged): ${BILLING_URL}`);
      openBilling();
      return report(run, 'card', 'skipped', `No card on file yet (${free})`);
    }
    if (onFile === undefined && wallet.balance_cents <= 0) {
      // An older API: nothing on the balance, which may also be a top-up paid and spent.
      run.next.push(`Live scans need a card on file (a saved card, or a top-up already paid) — add a card or funds in Billing: ${BILLING_URL}`);
      openBilling();
      return report(run, 'card', 'skipped', `No saved card and no balance (${free})`);
    }
    if (wallet.free_scans_remaining <= 0 && wallet.balance_cents < wallet.scan_price_cents) {
      run.next.push(`Add funds before your next live scan (${dollars(wallet.scan_price_cents)} each): ${BILLING_URL}`);
    }
    const holder = onFile ? 'Card on file' : 'Prepaid balance';
    report(run, 'card', 'done', `${holder}: ${dollars(wallet.balance_cents)}, ${free}`);
  } catch (error) {
    if (error instanceof SpaceContextError && error.code === 'INSUFFICIENT_SCOPE') {
      return report(run, 'card', 'skipped', 'This key cannot read the wallet (it needs scans:read): see Billing in the console');
    }
    report(run, 'card', 'failed', `Could not read the wallet: ${describe(error)}`);
  }
}

// ------------------------------------------------------------------ 5. next steps

function codeSnippet(use: KeyInUse): string {
  const test = use.key !== null && keyMode(use.key) === 'test';
  const space = test ? 'spc_demo' : '<space-id>';
  const where = test ? '' : ' (`npx spacecontext spaces` lists your space ids)';
  return [
    `Code: npm install @spacecontext/sdk, with a key from ${KEYS_URL} in SPACECONTEXT_API_KEY${where}:`,
    "import { SpaceContext } from '@spacecontext/sdk';",
    'const sc = new SpaceContext({ apiKey: process.env.SPACECONTEXT_API_KEY });',
    `const answer = await sc.spaces.ask('${space}', 'Where is the water shut-off?');`,
    'console.log(answer.answer, answer.citations);',
  ].join('\n');
}

// ------------------------------------------------------------------ the command

/** The default `which`: PATH, and on macOS the `code` inside the VS Code app when it is not on PATH. */
function systemWhich(io: Io, platform: NodeJS.Platform, home: string): (program: string) => Promise<string | null> {
  return async (program) => {
    const found = await findExecutable(program, io.env, platform);
    if (found || platform !== 'darwin' || program !== 'code') return found;
    for (const applications of ['/Applications', path.join(home, 'Applications')]) {
      const candidate = path.join(applications, 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code');
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not there.
      }
    }
    return null;
  };
}

/** Runs every step and returns the exit code: 0 when signed in and at least one assistant is connected (or those were skipped on purpose). */
export async function setup(io: Io, options: SetupOptions): Promise<number> {
  const wanted = wantedClients(options.clients);
  const platform = io.platform ?? process.platform;
  const home = io.env.HOME || io.env.USERPROFILE || homedir();
  const terminal = io.terminal ?? { stdin: false, stdout: false, stderr: false };
  const run: Run = {
    io,
    options,
    home,
    platform,
    run: io.run ?? runProgram,
    which: io.which ?? systemWhich(io, platform, home),
    interactive: terminal.stdin && terminal.stderr && !options.yes,
    fetch: io.fetch ?? globalThis.fetch.bind(globalThis),
    say: options.json ? io.stderr : io.stdout,
    // NO_COLOR, TERM=dumb and pipes: plain text.
    style: styleFor(io, options.json ? 'stderr' : 'stdout'),
    steps: [],
    next: [],
  };

  run.say(`${brandHeader(run.style, [brandLine(run.style, 'Space Context', 'setup'), `  ${run.style.dim('The context layer for the physical world')}`]).join('\n')}\n\n`);
  const use = await signIn(run);
  await connect(run, wanted);
  await skill(run);
  await card(run, use);
  run.next.push(codeSnippet(use), `Docs: ${DOCS_URL} (for agents: ${DOCS_URL}llms.txt)`);

  const summary: SetupSummary = { steps: run.steps, next: run.next };
  if (options.json) {
    io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const s = styleFor(io, 'stdout');
    io.stdout(`\n${s.bold('Next')}\n${summary.next.map((item) => item.split('\n').map((line, index) => (index === 0 ? `  ${s.next} ${line}` : `      ${line}`)).join('\n')).join('\n')}\n`);
  }

  const signedIn = options.skipLogin || run.steps.some((step) => step.id === 'sign-in' && step.status === 'done');
  const connected = options.skipMcp || run.steps.some((step) => step.id.startsWith('mcp:') && step.status === 'done');
  return signedIn && connected ? 0 : 1;
}
