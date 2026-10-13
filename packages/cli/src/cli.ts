import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { describeScan, fileBody, REPORT_LANGUAGES, SpaceContext, SpaceContextError, type FrameCheck, type ReportLanguage, type Scan, type SpaceDiff, type SpaceDocument, type SpaceSummary, type SpaceType } from '@spacecontext/sdk';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { apiUrl, clearConfig, configDirectory, readConfig, setting, signedInConfig, writeConfig } from './lib/config.js';
import { stat } from 'node:fs/promises';
import { compressionPlan, compressVideo, findVideoTools, installFfmpeg, pathWhich, probeDuration, type CompressionPlan } from './lib/compress.js';
import { frameFiles, MAX_FRAME_BYTES, scanSource, UsageError, writeSkill } from './lib/files.js';
import { COMMAND_HELP, commandHelp, GLOBAL_OPTIONS, mainHelp, SPACE_TYPES, usageOf } from './terminal/help.js';
import { hints, type ErrorContext } from './terminal/hints.js';
import { BILLING_URL, DEFAULT_API_URL, KEYS_URL } from './lib/links.js';
import { setup } from './commands/setup.js';
import { deviceLogin } from './commands/signin.js';
import type { Runner } from './lib/system.js';
import { brandLine, closest, duration, plural, printable, safe, size, sizeLimit, spinning, Status, styleFor, table, tildePath, visibleWidth, type Style } from './terminal/ui.js';

export const VERSION = '0.2.0';

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Reads a line typed by the user without echoing it (`login --key -`). Null when there is no terminal. */
  prompt: ((question: string) => Promise<string>) | null;
  fetch?: typeof fetch;
  /** Opens a URL in the browser (device sign-in). Null never opens one; undefined uses the system opener. */
  openBrowser?: ((url: string) => void) | null;
  /** Which of stdin, stdout and stderr are terminals (colours, spinners, interactive logins). Unset: none. */
  terminal?: { stdin: boolean; stdout: boolean; stderr: boolean };
  /** The terminal's width, to fit tables and the status line. Unset: unknown (nothing is cut). */
  columns?: number;
  /** The clock, in milliseconds (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Ctrl+C: runs the handler before the process ends. Returns a function that removes it. */
  onInterrupt?: (handler: () => void) => () => void;
  /** Runs a program with an argument array (`setup`). Undefined: a child process, never a shell. */
  run?: Runner;
  /** The absolute path of a program on PATH, or null (`setup`). Undefined: looks in `env.PATH`. */
  which?: (program: string) => Promise<string | null>;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
};

const OPTIONS = {
  json: { type: 'boolean' },
  'api-key': { type: 'string' },
  'base-url': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  key: { type: 'string' },
  source: { type: 'string' },
  transcript: { type: 'boolean' },
  space: { type: 'string' },
  limit: { type: 'string' },
  out: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  name: { type: 'string' },
  type: { type: 'string' },
  language: { type: 'string' },
  'no-wait': { type: 'boolean' },
  compress: { type: 'boolean' },
  'no-compress': { type: 'boolean' },
  format: { type: 'string' },
  follow: { type: 'boolean' },
  test: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  client: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'skip-login': { type: 'boolean' },
  'skip-mcp': { type: 'boolean' },
  'skip-skill': { type: 'boolean' },
} satisfies ParseArgsConfig['options'];

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string };

type Context = {
  io: Io;
  values: Values;
  args: string[];
  /** Styles for what goes to stdout and to stderr: each stream has its own terminal. */
  out: Style;
  err: Style;
  /** Filled in as the command runs, to say what to do when it fails. */
  failure: ErrorContext;
};

/** A spinner while waiting for the API, at a terminal and never with --json (stderr stays quiet). */
function busy<T>(context: Context, text: string, work: () => Promise<T>): Promise<T> {
  return context.values.json ? work() : spinning(context.io, text, work);
}

/**
 * The result as JSON with --json, else as text: `text` gets a copy of it with
 * every string safe to print (names and records come from the API, and can
 * carry escape sequences a terminal would run).
 */
function print<T>(io: Io, values: Values, json: T, text: (shown: T) => string): void {
  io.stdout(values.json ? `${JSON.stringify(json, null, 2)}\n` : text(printable(json)));
}

function money(cents: number): string {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** `` `command` `` in a hint: cyan at a terminal, in backticks elsewhere. */
function commands(s: Style, text: string): string {
  return s.color ? text.replace(/`([^`]+)`/g, (_, command: string) => s.cyan(command)) : text;
}

/** `› line`, with continuation lines indented under it. */
function nextLines(s: Style, entries: string[], indent = '  '): string {
  return entries
    .map((entry) =>
      entry
        .split('\n')
        .map((line, index) => `${indent}${index === 0 ? `${s.next} ` : '  '}${commands(s, line)}`)
        .join('\n')
    )
    .map((line) => `${line}\n`)
    .join('');
}

function missing(what: string, hint?: string): UsageError {
  return new UsageError(`Missing ${what}`, hint ? [hint] : [], true);
}

/** A key typed where it does not belong: never echoed back (it would stay in the scrollback). */
const LOOKS_LIKE_KEY = /^sc_(live|test)_/;

function shown(arg: string): string {
  return LOOKS_LIKE_KEY.test(arg) ? '(an API key, not shown)' : `"${safe(arg)}"`;
}

/** The one argument of a command: a second one is refused, never silently ignored. */
function one(args: string[], what: string, hint?: string): string {
  const [value, extra] = args;
  if (!value) throw missing(what, hint);
  if (extra !== undefined) throw new UsageError(`Unexpected argument ${shown(extra)}: give one ${what}`, [], true);
  return value;
}

/** A command that takes no argument. */
function none(args: string[]): void {
  const [extra] = args;
  if (extra === undefined) return;
  if (LOOKS_LIKE_KEY.test(extra)) {
    throw new UsageError('A key goes after --key, not as an argument', ['`spacecontext login --key -` asks for it without showing it'], true);
  }
  throw new UsageError(`Unexpected argument ${shown(extra)}`, [], true);
}

function words(args: string[], what: string): string {
  const text = args.join(' ').trim();
  if (!text) throw missing(what);
  return text;
}

const SPACE_ID_HINT = '`spacecontext spaces` lists your space ids';

/** `sc_live_abcd…`: as much of a key as the console shows. */
function maskKey(key: string): string {
  return `${key.slice(0, key.length > 20 ? 12 : 8)}…`;
}

type KeyInUse = { apiKey: string; source: 'flag' | 'env' | 'saved'; baseUrl: string | undefined; file: string };

async function keyInUse(context: Context): Promise<KeyInUse> {
  const { io, values } = context;
  const directory = configDirectory(io.env);
  const stored = await readConfig(directory);
  const environmentKey = setting(io.env, 'SPACECONTEXT_API_KEY');
  const apiKey = values['api-key'] ?? environmentKey ?? stored.apiKey;
  if (!apiKey) {
    throw new UsageError('Not signed in: no API key', [
      'Sign in: `spacecontext login` (or `spacecontext login --test` for a free test key)',
      'Or set SPACECONTEXT_API_KEY, or pass --api-key',
    ]);
  }
  const source = values['api-key'] !== undefined ? 'flag' : environmentKey !== undefined ? 'env' : 'saved';
  const file = path.join(directory, 'config.json');
  const requested = values['base-url'] ?? setting(io.env, 'SPACECONTEXT_BASE_URL');
  if (source !== 'saved') return { apiKey, source, baseUrl: requested, file };
  // The saved key goes only to the API it was saved for (the default one when
  // `login` saved none): never to another one a flag or the environment names.
  const saved = apiUrl(stored.baseUrl);
  if (requested !== undefined && apiUrl(requested) !== saved) {
    const other = apiUrl(requested);
    throw new UsageError(`The saved key is for ${saved}: it is not sent to ${other}`, [
      `Pass a key for ${other} with --api-key (or SPACECONTEXT_API_KEY),\nor sign in there: \`spacecontext login --base-url ${other}\``,
      `Or ${values['base-url'] !== undefined ? 'drop --base-url' : 'unset SPACECONTEXT_BASE_URL'} to use the saved key`,
    ]);
  }
  return { apiKey, source, baseUrl: saved, file };
}

const SOURCE_NAMES = { flag: '--api-key', env: 'SPACECONTEXT_API_KEY', saved: 'the saved key' } as const;

async function client(context: Context): Promise<SpaceContext> {
  const { apiKey, source, baseUrl } = await keyInUse(context);
  if (!/^sc_(live|test)_[A-Za-z0-9_-]+$/.test(apiKey)) {
    // Never echoed: a malformed key may still be a secret pasted in the wrong place.
    throw new UsageError(`${SOURCE_NAMES[source]} is not a Space Context key (sc_live_… or sc_test_…)`, ['Get one with `spacecontext login`']);
  }
  context.failure.keySource = source;
  context.failure.keyMode = apiKey.startsWith('sc_test_') ? 'test' : 'live';
  if (baseUrl && apiUrl(baseUrl) !== DEFAULT_API_URL) context.failure.baseUrl = baseUrl;
  return new SpaceContext({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(context.io.fetch ? { fetch: context.io.fetch } : {}),
  });
}

/** `2026-10-05` from an ISO date. */
function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '—';
}

/** Words wrapped at `width` (when known), every line after the first indented. */
function wrap(text: string, width: number | undefined, indent: string): string {
  if (!width || width < 40) return `${indent}${text}`;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && visibleWidth(indent + line + ' ' + word) > width - 1) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((entry) => indent + entry).join('\n');
}

/** The terminal's width for stdout, when stdout is one. */
function stdoutWidth(io: Io): number | undefined {
  return io.terminal?.stdout ? io.columns : undefined;
}

function kindLabel(kind: string): string {
  return kind.replaceAll('_', ' ');
}

/** A folder name for `--out` suggestions: `Seaside flat` → `seaside-flat`. */
function slug(name: string): string {
  const value = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return value || 'my-space';
}

function severity(s: Style, value: string | null | undefined): string {
  const label = (value ?? 'n/a').padEnd(8);
  if (value === 'critical' || value === 'high') return s.red(label);
  if (value === 'medium') return s.yellow(label);
  return s.dim(label);
}

/** `1:05` from milliseconds into the recording. */
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function documentSummary(s: Style, document: SpaceDocument, width: number | undefined): string {
  const stats = document.stats;
  const lines = [
    `${s.bold(document.space.name)}  ${s.dim(`${document.space.id} · ${document.space.source}`)}`,
    s.dim(`Scan ${document.scan.id}${document.scan.analyzed_at ? ` of ${day(document.scan.analyzed_at)}` : ''} · ${document.enrichment.level} level, ${document.enrichment.status}`),
    [plural(stats.areas, 'area'), plural(stats.items, 'item'), plural(stats.issues, 'issue'), plural(stats.key_locations, 'key location'), plural(stats.facts, 'fact')].join(' · '),
  ];
  if (document.enrichment.status === 'pending') lines.push(s.dim('Still being enriched: read it again in a minute for the full detail.'));
  if (document.summary) lines.push('', wrap(document.summary, width, ''));

  const areas = document.areas ?? [];
  const items = document.items ?? [];
  const areaName = new Map(areas.map((area) => [area.id, area.name || area.id]));
  const groups = areas.map((area) => ({ name: area.name || area.id, items: items.filter((item) => item.area_id === area.id) }));
  const elsewhere = items.filter((item) => !areaName.has(item.area_id));
  if (elsewhere.length > 0) groups.push({ name: 'Elsewhere', items: elsewhere });
  for (const group of groups) {
    const names = group.items.map((item) => (item.quantity && item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name));
    lines.push('', `${s.bold(group.name)}  ${s.dim(`(${group.items.length})`)}`, names.length > 0 ? wrap(names.join(', '), width, '  ') : s.dim('  no items'));
  }

  const keyLocations = document.key_locations ?? [];
  if (keyLocations.length > 0) {
    lines.push('', s.bold('Key locations'));
    for (const location of keyLocations) {
      const area = location.area_id ? areaName.get(location.area_id) : undefined;
      const where = [location.location, area && area !== location.location ? area : null].filter(Boolean).join(', ');
      lines.push(`  ${location.label}${where ? s.dim(` — ${where}`) : ''}`);
    }
  }

  const issues = document.issues ?? [];
  if (issues.length > 0) {
    lines.push('', s.bold('Issues'));
    for (const issue of issues) {
      const area = issue.area_id ? areaName.get(issue.area_id) : undefined;
      lines.push(`  ${severity(s, issue.severity)}${issue.title}${area ? s.dim(` — ${area}`) : ''}`);
    }
  }

  const checklist = document.coverage.checklist ?? [];
  if (checklist.length > 0) {
    const seen = checklist.filter((check) => check.seen).map((check) => kindLabel(check.kind));
    const unseen = checklist.filter((check) => !check.seen).map((check) => kindLabel(check.kind));
    lines.push('', `Key locations filmed: ${seen.join(', ') || 'none'}`);
    if (unseen.length > 0) lines.push(`Not filmed: ${unseen.join(', ')}`);
  }
  for (const warning of document.coverage.warnings) lines.push('', `${s.warn} ${warning}`);

  // Only with --transcript (and a key with spaces:sensitive): what was said, when.
  const transcript = document.transcript;
  if (transcript) {
    lines.push('', s.bold('Transcript'));
    if (transcript.segments.length > 0) {
      for (const segment of transcript.segments) lines.push(wrap(`${s.dim(clock(segment.start_ms))} ${segment.text}`, width, '  '));
    } else {
      lines.push(transcript.text ? wrap(transcript.text, width, '  ') : s.dim('  Nothing was said.'));
    }
  }
  return `${lines.join('\n')}\n`;
}

function statusWord(s: Style, status: Scan['status']): string {
  if (status === 'complete') return s.green(status);
  if (status === 'failed' || status === 'cancelled') return s.red(status);
  return s.yellow(status);
}

function scanLine(s: Style, scan: Scan): string {
  const { stage, label } = describeScan(scan);
  const detail = stage !== scan.status ? ` (${stage}: ${label})` : '';
  const error = scan.error ? ` — ${scan.error.code}: ${scan.error.message}` : '';
  return `${scan.id} ${statusWord(s, scan.status)}${detail}${error}`;
}

const FORMATS = ['text', 'json', 'markdown', 'skill'] as const;
type Format = (typeof FORMATS)[number];

function format(values: Values): Format {
  const value = values.format ?? (values.json ? 'json' : 'text');
  if (!FORMATS.includes(value as Format)) throw new UsageError(`--format must be one of ${FORMATS.join(', ')}`);
  return value as Format;
}

/** Writes the Skill of a space to `--out`, or to a folder named by the API. */
async function exportSkill(context: Context, sc: SpaceContext, id: string, params: { include?: 'transcript'; enrich?: 'auto' | 'none' }): Promise<void> {
  const { io, values, out } = context;
  const bundle = await busy(context, 'Exporting the skill', () => sc.spaces.skill(id, params));
  // The default folder is named by the API: a name that is not a plain slug
  // ("../../x", "/etc") would place the skill outside the current directory.
  if (!values.out && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bundle.name)) {
    throw new Error(`Refusing to use "${bundle.name}" as a folder name: pass --out <dir>`);
  }
  const directory = path.resolve(io.cwd, values.out ?? bundle.name);
  const written = await writeSkill(directory, bundle);
  print(io, values, { directory, files: written }, () =>
    `${out.ok} Skill "${safe(bundle.name)}" written to ${safe(tildePath(io, directory))} ${out.dim(`(${plural(written.length, 'file')})`)}\n` +
    nextLines(out, [`Add the folder to your agent's skills, e.g. ~/.claude/skills/${safe(bundle.name)}`], '')
  );
}

/** Prints the Markdown page of a space, or writes it to `--out`. */
async function exportMarkdown(context: Context, sc: SpaceContext, id: string, params: { include?: 'transcript'; enrich?: 'auto' | 'none' }): Promise<void> {
  const { io, values, err } = context;
  const page = await busy(context, 'Exporting the page', () => sc.spaces.markdown(id, params));
  if (values.out) {
    const file = path.resolve(io.cwd, values.out);
    await writeFile(file, page);
    if (values.json) io.stdout(`${JSON.stringify({ file }, null, 2)}\n`);
    else io.stderr(`${err.ok} Written to ${safe(tildePath(io, file))}\n`);
  } else if (values.json) {
    io.stdout(`${JSON.stringify({ markdown: page }, null, 2)}\n`);
  } else {
    io.stdout(safe(page));
  }
}

// ------------------------------------------------------------------ commands

/**
 * `login --key -`: the key typed at a prompt that does not echo it. A key given
 * on the command line stays in the shell's history.
 */
async function typedKey(io: Io): Promise<string> {
  if (!io.prompt) throw new UsageError('--key - reads the key from a terminal', ['Run it in a terminal, or set SPACECONTEXT_API_KEY']);
  const key = (await io.prompt('API key (input hidden): ')).trim();
  if (!key) throw new UsageError('No key entered');
  return key;
}

function loggedIn(context: Context, email: string, mode: string, scopes: string[], file: string, otherApi: string | undefined): string {
  const { io, out: s } = context;
  const next =
    mode === 'test'
      ? ['Try the demo: `spacecontext ask spc_demo "where is the fuse box?"`', 'Read it all: `spacecontext space spc_demo`']
      : ['Your spaces: `spacecontext spaces`', ...(scopes.includes('scans:write') ? ['Scan one: `spacecontext scan ./video.mp4 --name "My place"`'] : [])];
  const lines = [
    `${s.ok} Logged in as ${s.bold(email)} with a ${mode} key (${scopes.join(', ')}).\n`,
    `  ${s.dim(`Saved in ${tildePath(io, file)}${otherApi ? `, for ${otherApi}` : ''}`)}\n`,
  ];
  if (setting(io.env, 'SPACECONTEXT_API_KEY')) {
    lines.push(`${s.warn} SPACECONTEXT_API_KEY is set: commands use it, not the key just saved. Unset it to use this one.\n`);
  }
  return `${lines.join('')}\n${s.bold('Next')}\n${nextLines(s, next)}`;
}

async function login(context: Context): Promise<void> {
  const { io, values } = context;
  none(context.args);
  // The API signed in to, saved with the key unless it is the default one (see `keyInUse`).
  const baseUrl = values['base-url'] ?? setting(io.env, 'SPACECONTEXT_BASE_URL');
  const otherApi = baseUrl && apiUrl(baseUrl) !== DEFAULT_API_URL ? apiUrl(baseUrl) : undefined;
  if (otherApi) context.failure.baseUrl = otherApi;
  let key = values.key ?? values['api-key'];
  if (key === '-') key = await typedKey(io);
  if (!key) {
    // Device sign-in: a code to approve in the console; the key comes back here, never through the browser.
    const { signedIn, file } = await deviceLogin(io, { mode: values.test ? 'test' : 'live', baseUrl, openBrowser: !values['no-browser'] });
    print(io, values, { user: signedIn.user, key: signedIn.key }, (shown) => loggedIn(context, shown.user.email, shown.key.mode, shown.key.scopes, file, otherApi));
    return;
  }
  if (!/^sc_(live|test)_[A-Za-z0-9_-]+$/.test(key)) {
    throw new UsageError('That is not a Space Context key (sc_live_… or sc_test_…)', ['Run `spacecontext login` without --key to get one']);
  }
  context.failure.keySource = 'flag';
  const sc = new SpaceContext({ apiKey: key, ...(baseUrl ? { baseUrl } : {}), ...(io.fetch ? { fetch: io.fetch } : {}) });
  const me = await busy(context, 'Checking the key', () => sc.me());
  const file = await writeConfig(configDirectory(io.env), signedInConfig(key, baseUrl));
  print(io, values, me, (shown) => loggedIn(context, shown.user.email, shown.key.mode, shown.key.scopes, file, otherApi));
}

async function logout(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  none(context.args);
  await clearConfig(configDirectory(io.env));
  print(io, values, { logged_out: true }, () => {
    const lines = [`${s.ok} Logged out: the saved key is forgotten.\n`, `  ${s.dim(`It still works until you revoke it in the console: ${KEYS_URL}`)}\n`];
    if (setting(io.env, 'SPACECONTEXT_API_KEY')) lines.push(`${s.warn} SPACECONTEXT_API_KEY is still set: commands keep using it.\n`);
    return lines.join('');
  });
}

async function whoami(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  none(context.args);
  const use = await keyInUse(context);
  const sc = await client(context);
  const me = await busy(context, 'Checking the key', () => sc.me());
  print(io, values, me, (me) => {
    const from = use.source === 'saved' ? `the saved key (${tildePath(io, use.file)})` : SOURCE_NAMES[use.source];
    const rows: Array<[string, string]> = [
      ['Account', `${s.bold(me.user.email)}${me.user.is_pro ? ` · ${s.brand('Pro')}` : ''}`],
      ['Key', `${maskKey(use.apiKey)} · ${me.key.mode}${me.key.id ? s.dim(` · ${me.key.id}`) : ''}`],
      ['Scopes', me.key.scopes.join(', ')],
      ['From', from],
    ];
    if (apiUrl(use.baseUrl) !== DEFAULT_API_URL) rows.push(['API', apiUrl(use.baseUrl)]);
    return rows.map(([label, value]) => `${s.dim(label.padEnd(9))}${value}\n`).join('');
  });
}

async function wallet(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  none(context.args);
  const sc = await client(context);
  const wallet = await busy(context, 'Reading the wallet', () => sc.wallet());
  print(io, values, wallet, (wallet) => {
    const recharge = wallet.auto_recharge;
    const rechargeText = recharge.enabled
      ? `on${typeof recharge.threshold_cents === 'number' && typeof recharge.amount_cents === 'number' ? ` (adds ${money(recharge.amount_cents)} below ${money(recharge.threshold_cents)})` : ''}`
      : `off${recharge.last_error ? s.dim(` (${recharge.last_error})`) : ''}`;
    const rows: Array<[string, string]> = [
      ['Balance', s.bold(money(wallet.balance_cents))],
      ['Free scans', `${wallet.free_scans_remaining} left`],
      ['Scan price', money(wallet.scan_price_cents)],
      ['Card on file', wallet.card_on_file === false ? s.yellow('no') : wallet.card_on_file ? s.green('yes') : s.dim('unknown')],
      ['Auto-recharge', rechargeText],
    ];
    let text = rows.map(([label, value]) => `${s.dim(label.padEnd(14))}${value}\n`).join('');
    if (wallet.card_on_file === false && context.failure.keyMode === 'live') {
      text += `\n${nextLines(s, [`Live scans need a card on file; adding one charges nothing:\n${BILLING_URL}`], '')}`;
    } else if (wallet.free_scans_remaining <= 0 && wallet.balance_cents < wallet.scan_price_cents && context.failure.keyMode === 'live') {
      text += `\n${nextLines(s, [`Top up before your next live scan: ${BILLING_URL}`], '')}`;
    }
    return text;
  });
}

async function spaces(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  none(context.args);
  const source = values.source;
  if (source !== undefined && source !== 'app' && source !== 'api') throw new UsageError('--source must be app or api');
  const sc = await client(context);
  const all: SpaceSummary[] = await busy(context, 'Listing your spaces', async () => {
    const found: SpaceSummary[] = [];
    for await (const space of sc.spaces.iterate(source ? { source } : {})) found.push(space);
    return found;
  });
  print(io, values, all, (all) => {
    if (all.length === 0) return `No spaces yet.\n${nextLines(s, ['Scan one: `spacecontext scan ./video.mp4 --name "My flat"`'], '')}`;
    const rows = all.map((space) => {
      const scan = space.latest_scan;
      return [space.id, space.name, scan ? day(scan.analyzed_at) : s.dim('no scan'), scan ? String(scan.items) : '', scan ? String(scan.issues) : ''];
    });
    return (
      table(s, ['ID', 'NAME', 'SCANNED', 'ITEMS', 'ISSUES'], rows, { right: [3, 4], shrink: 1, width: stdoutWidth(io) }) +
      s.dim(`\n${plural(all.length, 'space')} · spacecontext space <id> shows one\n`)
    );
  });
}

async function space(context: Context): Promise<void> {
  const { io, values, out } = context;
  const id = one(context.args, 'space id', SPACE_ID_HINT);
  const sc = await client(context);
  const document = await busy(context, 'Reading the space', () => sc.spaces.get(id, values.transcript ? { include: 'transcript' } : {}));
  print(io, values, document, (document) => documentSummary(out, document, stdoutWidth(io)));
}

async function search(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  const query = words(context.args, 'question');
  const limitText = values.limit;
  if (limitText !== undefined && !/^\d+$/.test(limitText)) throw new UsageError('--limit must be a number from 1 to 25');
  const sc = await client(context);
  const results = await busy(context, 'Searching', () =>
    sc.search(query, {
      ...(values.space ? { spaceId: values.space } : {}),
      ...(limitText ? { limit: Number(limitText) } : {}),
    })
  );
  print(io, values, results, (results) =>
    results.data.length === 0
      ? `Nothing found for "${safe(query)}".\n${s.dim('A space is searchable once its scan is complete; spacecontext spaces lists them.')}\n`
      : results.data
          .map((hit, index) => {
            const number = `${index + 1}.`.padEnd(3);
            const head = `${s.dim(number)} ${s.bold(hit.title)}${inArea(hit.title, hit.area, ' — ')}  ${s.dim(`[${hit.space_name}, ${hit.record_type} ${hit.record_id}]`)}`;
            return `${head}\n${wrap(hit.text, stdoutWidth(io), '    ')}\n`;
          })
          .join('\n')
  );
}

/** The area after a record's title, left out when the record is the area itself. */
function inArea(title: string, area: string | null | undefined, before: string, after = ''): string {
  return area && area !== title ? `${before}${area}${after}` : '';
}

async function ask(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  const [id, ...rest] = context.args;
  if (!id) throw missing('space id', SPACE_ID_HINT);
  const question = words(rest, 'question');
  const sc = await client(context);
  const answer = await busy(context, 'Asking the space', () => sc.spaces.ask(id, question));
  print(io, values, answer, (answer) => {
    const lines = [wrap(answer.answer, stdoutWidth(io), '')];
    if (!answer.documented) lines.push(s.dim('(not documented in this space)'));
    if (answer.citations.length > 0) {
      lines.push('', s.bold('Sources'), ...answer.citations.map((citation) => `  • ${citation.title}${inArea(citation.title, citation.area, s.dim(' ('), s.dim(')'))}`));
    }
    return `${lines.join('\n')}\n`;
  });
}

async function skill(context: Context): Promise<void> {
  const id = one(context.args, 'space id', SPACE_ID_HINT);
  await exportSkill(context, await client(context), id, context.values.transcript ? { include: 'transcript' } : {});
}

async function markdown(context: Context): Promise<void> {
  const id = one(context.args, 'space id', SPACE_ID_HINT);
  await exportMarkdown(context, await client(context), id, context.values.transcript ? { include: 'transcript' } : {});
}

async function diff(context: Context): Promise<void> {
  const { io, values, out } = context;
  const id = one(context.args, 'space id', SPACE_ID_HINT);
  const from = values.from;
  if (!from) throw new UsageError('--from <scan-id> is required', [`\`spacecontext scans ${id}\` lists the scans of the space`], true);
  const sc = await client(context);
  const result = await busy(context, 'Comparing the scans', () => sc.spaces.diff(id, { from, ...(values.to ? { to: values.to } : {}) }));
  print(io, values, result, (result) => diffSummary(out, result));
}

function diffSummary(s: Style, diff: SpaceDiff): string {
  const where = (area: string | null) => (area ? ` — ${area}` : '');
  const out: string[] = [
    `${diff.from.scan_id} → ${diff.to.scan_id} ${s.dim(`(${diff.level} level, ${diff.linked ? 'the later scan was checked against the earlier one' : 'matched by content'})`)}`,
  ];
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) out.push('', `${s.bold(title)} (${lines.length})`, ...lines.map((line) => `  ${line}`));
  };
  section('Areas added', diff.areas.added);
  section('Areas not in the later scan', diff.areas.removed);
  section('Areas in another condition', diff.areas.condition_changed.map((entry) => `${entry.area}: ${entry.from} → ${entry.to}`));
  section('Items added', diff.items.added.map((item) => `${s.green('+')} ${item.name}${where(item.area)}`));
  section('Items gone (seen: the place is empty)', diff.items.removed.map((item) => `${s.red('-')} ${item.name}${where(item.area)}${item.note ? `: ${item.note}` : ''}`));
  section('Items not seen in the later scan (gone, or not filmed)', diff.items.not_seen.map((item) => `${s.yellow('?')} ${item.name}${where(item.area)}`));
  section('Items moved', diff.items.moved.map((item) => `${item.name}: ${item.from_area ?? 'no area'} → ${item.area ?? 'no area'}`));
  section('Items recounted', diff.items.quantity_changed.map((item) => `${item.name}${where(item.area)}: ${item.from_quantity} → ${item.quantity}`));
  section('Items in another condition', diff.items.condition_changed.map((item) => `${item.name}${where(item.area)}: ${item.from_condition} → ${item.to_condition}`));
  section('Issues new', diff.issues.new.map((issue) => `${s.red('!')} ${issue.title}${where(issue.area)}`));
  section('Issues fixed (seen)', diff.issues.resolved.map((issue) => `${s.green('✓')} ${issue.title}${where(issue.area)}${issue.note ? `: ${issue.note}` : ''}`));
  section('Issues not seen in the later scan', diff.issues.not_seen.map((issue) => `${s.yellow('?')} ${issue.title}${where(issue.area)}`));
  if (out.length === 1) out.push('', 'No differences found.');
  return `${out.join('\n')}\n`;
}

async function scans(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  const id = one(context.args, 'space id', SPACE_ID_HINT);
  const sc = await client(context);
  const { data } = await busy(context, 'Listing the scans', () => sc.spaces.scans(id));
  print(io, values, data, (data) =>
    data.length === 0
      ? 'No completed scan yet.\n'
      : table(
          s,
          ['SCAN', 'ANALYZED', 'AREAS', 'ITEMS', 'ISSUES'],
          data.map((entry) => [
            `${entry.id}${entry.current ? s.green(' (current)') : ''}`,
            entry.analyzed_at ? entry.analyzed_at.slice(0, 16).replace('T', ' ') : 'date unknown',
            String(entry.areas),
            String(entry.items),
            String(entry.issues),
          ]),
          { right: [2, 3, 4] }
        ) + (data.length > 1 ? s.dim(`\nspacecontext diff ${id} --from <scan-id> compares one with the current scan\n`) : '')
  );
}

async function cancel(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  const id = one(context.args, 'scan id');
  await (await client(context)).scans.cancel(id);
  print(io, values, { cancelled: id }, () => `${s.ok} Scan ${id} cancelled. Nothing was charged.\n`);
}

async function deleteSpace(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  const id = one(context.args, 'space id', SPACE_ID_HINT);
  await (await client(context)).spaces.delete(id);
  print(io, values, { deleted: id }, () => `${s.ok} Space ${id} deleted, with its scans and files.\n`);
}

async function scanStatus(context: Context): Promise<void> {
  const { io, values, out } = context;
  const id = one(context.args, 'scan id');
  const sc = await client(context);
  context.failure.scanId = id;
  if (!values.follow) {
    const scan = await sc.scans.get(id);
    print(io, values, scan, (scan) => `${scanLine(out, scan)}\n`);
    return;
  }
  // Every change as it happens, then the final state.
  let last: Scan | null = null;
  for await (const scan of sc.scans.events(id)) {
    last = scan;
    if (values.json) io.stdout(`${JSON.stringify(scan)}\n`);
    else io.stdout(`${scanLine(out, printable(scan))}\n`);
  }
  if (last && last.status !== 'complete') {
    throw new SpaceContextError(`Scan ${last.status}: ${last.error?.message ?? 'no detail'}`, 0, last.error?.code ?? 'SCAN_FAILED', null);
  }
}

/**
 * Checks images before they are scanned: usable or not, and which key locations
 * they show, so what is missing can be filmed before paying for a scan.
 */
async function check(context: Context): Promise<void> {
  const { io, values, out: s } = context;
  const files = await frameFiles(path.resolve(io.cwd, one(context.args, 'image or photos folder')));
  for (const frame of files) {
    if ((await stat(frame.file)).size > MAX_FRAME_BYTES) throw new UsageError(`${path.basename(frame.file)} is larger than ${MAX_FRAME_BYTES / 1_048_576} MB`);
  }
  const sc = await client(context);
  const checked: Array<{ file: string; check: FrameCheck }> = [];
  const status = values.json ? null : new Status(io);
  status?.step(`Checking ${plural(files.length, 'image')}`, { plain: files.length > 1 });
  try {
    for (const [index, frame] of files.entries()) {
      status?.update(`Checking image ${index + 1} of ${files.length}`);
      checked.push({ file: path.basename(frame.file), check: await sc.frames.check(await fileBody(frame.file), frame.contentType) });
    }
  } finally {
    status?.stop();
  }

  const kinds = checked[0]?.check.key_locations.map((entry) => entry.kind) ?? [];
  const seen = kinds.flatMap((kind) => {
    const best = checked
      .map(({ file, check }) => ({ file, probability: check.key_locations.find((entry) => entry.kind === kind)?.probability ?? 0, seen: check.key_locations.find((entry) => entry.kind === kind)?.seen ?? false }))
      .filter((entry) => entry.seen)
      .sort((a, b) => b.probability - a.probability)[0];
    return best ? [{ kind, file: best.file, probability: best.probability }] : [];
  });
  const notSeen = kinds.filter((kind) => !seen.some((entry) => entry.kind === kind));
  const usable = checked.filter(({ check }) => check.usable).length;
  const summary = { frames: checked.length, usable, seen, not_seen: notSeen };

  print(io, values, { frames: checked.map(({ file, check }) => ({ file, ...check })), summary }, () => {
    // File names are the person's own, but can still hold control characters.
    const rows = printable(checked).map(({ file, check }) => {
      // A frame can be sharp and still show no place (a drawing, a document, a screen).
      const quality = check.shows_space < 0.5 ? 'not a place' : `${check.quality.level}, ${check.quality.score.toFixed(2)}`;
      const shows = check.key_locations.filter((entry) => entry.seen).map((entry) => kindLabel(entry.kind));
      return [file, check.usable ? `${s.ok} yes` : `${s.fail} no`, quality, shows.join(', ')];
    });
    const lines = [table(s, ['FILE', 'USABLE', 'QUALITY', 'SHOWS'], rows, { shrink: 0, width: stdoutWidth(io) }).trimEnd()];
    lines.push('', `Usable: ${usable} of ${plural(checked.length, 'frame')}`);
    lines.push(`Seen: ${seen.length > 0 ? printable(seen).map((entry) => `${kindLabel(entry.kind)} (${entry.file})`).join(', ') : 'none'}`);
    let text = `${lines.join('\n')}\n`;
    if (notSeen.length > 0) {
      text += `Not seen yet: ${notSeen.map(kindLabel).join(', ')}.\n${nextLines(s, ['Film them before scanning, if the space has them'], '')}`;
    }
    return text;
  });
}

async function scan(context: Context): Promise<void> {
  const { io, values, out, err } = context;
  if (context.args.length > 1) {
    throw new UsageError('scan takes one video, or one folder of photos', ['To scan photos, put them in a folder and pass the folder'], true);
  }
  const input = path.resolve(io.cwd, one(context.args, 'video file or photos folder'));
  if (Boolean(values.space) === Boolean(values.name)) {
    throw new UsageError(values.space ? 'Pass --space or --name, not both' : 'Say where the scan goes: --name <name> for a new space, or --space <space-id>', [], true);
  }
  if (values.compress && values['no-compress']) throw new UsageError('Pass --compress or --no-compress, not both', [], true);
  const language = (values.language ?? 'en') as ReportLanguage;
  if (!REPORT_LANGUAGES.includes(language)) {
    throw new UsageError(`--language must be one of ${REPORT_LANGUAGES.join(', ')} (the language of the report; the narration can be in any language)`);
  }
  const spaceType = values.type;
  if (spaceType !== undefined && !SPACE_TYPES.includes(spaceType as SpaceType)) {
    throw new UsageError(`--type must be one of ${SPACE_TYPES.join(', ')}`);
  }
  const output = format(values);
  // Options that would otherwise be ignored without a word.
  if (values.type !== undefined && values.space) throw new UsageError('--type sets the type of a new space: use it with --name', [], true);
  if (values.out !== undefined && output !== 'markdown' && output !== 'skill') {
    throw new UsageError('--out writes the Markdown page or the skill: add --format markdown or --format skill', [], true);
  }
  if (values['no-wait'] && values.format !== undefined) throw new UsageError('--format needs the result: drop --no-wait, or --format', [], true);
  const source = await scanSource(input);
  if (values.compress && source.kind !== 'video') throw new UsageError('--compress re-encodes a video: photos are sent as they are');
  let totalBytes = source.kind === 'video' ? source.size : 0;
  if (source.kind === 'frames') {
    for (const frame of source.files) {
      const bytes = (await stat(frame.file)).size;
      if (bytes > MAX_FRAME_BYTES) throw new UsageError(`${path.basename(frame.file)} is larger than ${MAX_FRAME_BYTES / 1_048_576} MB`);
      totalBytes += bytes;
    }
  }
  const sc = await client(context);
  // A video's limits are the API's own (4 GB and 10 minutes where it reads videos
  // with its own ffmpeg), read before anything is created; an API that does not
  // state them takes 100 MB. Null when they could not be read: then nothing is
  // guessed or re-encoded unasked, and the API decides when the scan is declared.
  const limits = source.kind === 'video' ? await sc.limits() : null;
  const overLimit = source.kind === 'video' && limits !== null && source.size > limits.maxVideoBytes;
  // A video over a known limit is compressed to fit when ffmpeg is installed; --compress always, --no-compress never.
  const platform = io.platform ?? process.platform;
  const compressing = source.kind === 'video' && !values['no-compress'] && (Boolean(values.compress) || overLimit);
  const tools = compressing ? await findVideoTools(io.which ?? pathWhich(io.env, platform)) : null;
  if (values.compress && !tools) throw new UsageError('--compress needs ffmpeg and ffprobe on the PATH', [`Install ffmpeg: ${installFfmpeg(platform)}`]);
  if (source.kind === 'video' && limits && overLimit && !tools) {
    const name = path.basename(source.file);
    throw new UsageError(`${name} is ${size(source.size)}: a video can be up to ${sizeLimit(limits.maxVideoBytes)}`, [
      values['no-compress']
        ? 'Without --no-compress the CLI compresses it to fit, when ffmpeg is installed'
        : `Install ffmpeg and run it again: the CLI compresses the video to fit\n(${installFfmpeg(platform)})`,
    ]);
  }
  // The duration sets the bitrate; a video the API would refuse as too long is refused before encoding it.
  let plan: CompressionPlan | null = null;
  if (tools && source.kind === 'video') {
    const name = path.basename(source.file);
    const probe = await probeDuration(tools, source.file, io.run);
    if (probe.seconds === null) {
      throw new UsageError(`ffprobe could not read how long ${name} lasts: ${probe.reason}`, [
        source.contentType === 'video/webm' || source.contentType === 'video/x-matroska'
          ? 'A WebM recorded in a browser does not say how long it lasts: remux it first\n(`ffmpeg -i in.webm -c copy out.webm`)'
          : 'Check that the video plays, or export it again as .mp4',
        // Under the limit only --compress asked for it.
        ...(overLimit ? [] : ['Or send it as it is, without --compress']),
      ]);
    }
    const longest = limits?.maxVideoSeconds ?? Infinity;
    if (probe.seconds > longest) {
      const extension = path.extname(name) || '.mp4';
      const minutes = longest % 60 === 0 ? ` (${plural(longest / 60, 'minute')})` : '';
      throw new UsageError(`${name} lasts ${Math.round(probe.seconds * 10) / 10} s: a video can last up to ${longest} s${minutes}`, [
        `Trim it: \`ffmpeg -i ${/^[\w.-]+$/.test(name) ? name : `in${extension}`} -t ${longest} -c copy trimmed${extension}\`, or film it again`,
      ]);
    }
    // Limits unknown (only --compress gets here): the bitrate's own cap, 8 Mbit/s.
    plan = compressionPlan(probe.seconds, limits?.maxVideoBytes ?? Infinity);
  }
  const now = io.now ?? Date.now;
  const began = now();
  // --json: stdout is the document and stderr stays quiet (errors aside).
  const status = values.json ? null : new Status(io);
  const name = safe(path.basename(input));
  const what = source.kind === 'video' ? `video, ${size(source.size)}` : `${plural(source.files.length, 'photo')}, ${size(totalBytes)}`;
  const target = values.name ? `a new space ${err.bold(`"${safe(values.name)}"`)}` : err.bold(safe(values.space!));
  status?.line(`${brandLine(err, `Scanning ${name}`)} ${err.dim(`(${what})`)} into ${target}`);

  let spaceId = values.space!;
  // The scan once the API has it (before its upload), then once it started.
  let created: Scan | undefined;
  let started: Scan | undefined;
  let uploading: string | null = null;
  let encoding = false;
  // The compressed copy, in a folder of its own: removed after the upload, on failure and on Ctrl+C.
  let temporary: string | null = null;
  const discard = async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    temporary = null;
  };
  const released: Array<() => void> = [];
  const onInterrupt = (handler: () => void) => {
    const release = io.onInterrupt?.(handler);
    if (release) released.push(release);
  };
  try {
    onInterrupt(() => {
      status?.stop();
      if (started) return;
      if (encoding) {
        io.stderr(`\n${err.warn} Interrupted while compressing: nothing was created or charged.\n`);
        return;
      }
      // A scan created and not started counts against the account's open scans until it is cancelled.
      const scan = created ? ` \`spacecontext cancel ${created.id}\` removes the scan.` : '';
      const left = values.name && spaceId ? ` The space ${spaceId} has no scan: \`spacecontext delete-space ${spaceId}\` removes it.` : '';
      io.stderr(`\n${err.warn} Interrupted during the upload: a scan that has not started is never charged.${scan}${left}\n`);
    });
    let video = source.kind === 'video' ? { file: source.file, contentType: source.contentType, size: source.size } : null;
    if (video && tools && plan) {
      const folder = await mkdtemp(path.join(tmpdir(), 'spacecontext-'));
      temporary = folder;
      onInterrupt(() => rmSync(folder, { recursive: true, force: true }));
      const compressed = path.join(folder, 'video.mp4');
      encoding = true;
      status?.step(`Compressing ${name}`);
      let bytes: number;
      try {
        bytes = await compressVideo({
          tools,
          input: video.file,
          output: compressed,
          plan,
          ...(io.run ? { run: io.run } : {}),
          onProgress: (fraction) => status?.update(`Compressing ${name}  ${Math.floor(fraction * 100)}%`),
        });
      } catch (error) {
        status?.fail();
        throw error;
      }
      encoding = false;
      if (limits && bytes > limits.maxVideoBytes) {
        status?.fail();
        throw new Error(`Compressed, ${name} is still ${size(bytes)}, over ${sizeLimit(limits.maxVideoBytes)}: trim it and scan again`);
      }
      const picture = plan.longSide === 1280 ? '720p' : '1080p';
      if (bytes >= video.size && !overLimit) {
        // --compress on a video that already fits can come out larger: the original is sent.
        status?.complete(`Kept ${name} as it is`, `compressing gave ${size(bytes)}, more than its ${size(video.size)}`);
      } else {
        status?.complete(`Compressed ${name}`, `${size(video.size)} → ${size(bytes)}, H.264 up to ${picture}, in ${duration(status.elapsed())}`);
        video = { file: compressed, contentType: 'video/mp4', size: bytes };
        totalBytes = bytes;
      }
    }
    if (values.name) {
      status?.step('Creating the space', { plain: false });
      const created = await sc.spaces.create({ name: values.name, ...(spaceType ? { space_type: spaceType as SpaceType } : {}) });
      spaceId = created.id;
      status?.complete('Space created', created.id);
    }

    try {
      if (source.kind === 'video') {
        // The compressed copy when there is one.
        const upload = video ?? source;
        status?.step(`Uploading ${name}`);
        // Read from disk while it uploads: a video can be gigabytes.
        started = await sc.scans.fromVideo(spaceId, {
          data: await fileBody(upload.file),
          contentType: upload.contentType,
          language,
          onCreated: (scan) => (created = scan),
        });
      } else {
        const count = source.files.length;
        status?.step(`Uploading ${plural(count, 'photo')}`);
        const frames = await Promise.all(source.files.map(async (frame) => ({ data: await fileBody(frame.file), contentType: frame.contentType })));
        started = await sc.scans.fromFrames(spaceId, frames, {
          language,
          onCreated: (scan) => (created = scan),
          onUpload: (index) => {
            uploading = safe(path.basename(source.files[index]!.file));
            status?.update(`Uploading photo ${index + 1} of ${count}`);
          },
        });
      }
      if (status) {
        status.complete(source.kind === 'video' ? `Uploaded ${name}` : `Uploaded ${plural(source.files.length, 'photo')}`, `${size(totalBytes)} in ${duration(status.elapsed())}`);
      }
    } catch (error) {
      status?.fail();
      // Which photo the API refused (its type, its size, an empty file).
      if (uploading && error instanceof SpaceContextError && ['INVALID_CONTENT_TYPE', 'FILE_TOO_LARGE', 'EMPTY_FILE'].includes(error.code)) {
        status?.line(`${err.warn} Refused: ${uploading}`);
      }
      // The SDK has cancelled the scan; a space made for it stays and is said so.
      if (values.name) {
        status?.line(`${err.warn} The space ${spaceId} was created but has no scan: scan again with --space ${spaceId}, or remove it with \`spacecontext delete-space ${spaceId}\`.`);
      }
      throw error;
    } finally {
      await discard();
    }
    const scanId = started.id;
    context.failure.scanId = scanId;
    const charge = !started.livemode ? 'test mode, no charge' : started.charge.kind === 'free_scan' ? 'free scan' : `${money(started.charge.price_cents)} from the balance`;
    status?.line(`${err.ok} Scan started  ${err.dim(`${scanId} · ${charge}`)}`);

    if (values['no-wait']) {
      print(io, values, started, () => nextLines(out, [`It runs on the server. Follow it: \`spacecontext scan-status ${scanId} --follow\``], ''));
      return;
    }
    onInterrupt(() => {
      status?.stop();
      io.stderr(`\n${err.warn} Stopped following. The scan goes on on the server:\n${nextLines(err, [`\`spacecontext scan-status ${scanId} --follow\``])}`);
    });
    let lastStage: string | null = null;
    const finished = await sc.scans.wait(scanId, {
      onProgress: (current) => {
        const { stage, label } = describeScan(current);
        if (stage === lastStage) return;
        lastStage = stage;
        if (stage !== 'complete' && stage !== 'failed' && stage !== 'cancelled') status?.step(label);
      },
    });
    if (finished.status !== 'complete') {
      status?.fail();
      throw new SpaceContextError(
        `Scan ${finished.status}: ${finished.error?.message ?? 'no detail'}${finished.charge.refunded ? ' (refunded)' : ''}`,
        0,
        finished.error?.code ?? 'SCAN_FAILED',
        null
      );
    }
    status?.complete();
    status?.line(`${err.ok} ${err.bold('Scan complete')} in ${duration(now() - began)}`);
  } finally {
    status?.stop();
    await discard();
    for (const release of released) release();
  }

  if (output === 'markdown') return exportMarkdown(context, sc, spaceId, { enrich: 'none' });
  if (output === 'skill') return exportSkill(context, sc, spaceId, { enrich: 'none' });
  const document = await sc.spaces.get(spaceId, { enrich: 'none' });
  if (output === 'json') {
    io.stdout(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  print(io, values, document, (document) => {
    const folder = slug(document.space.name);
    const next = nextLines(out, [
      `Ask it: \`spacecontext ask ${spaceId} "where is the fuse box?"\``,
      `Give it to your agent: \`spacecontext skill ${spaceId} --out ~/.claude/skills/${folder}\``,
      `Read it again: \`spacecontext space ${spaceId}\``,
    ]);
    return `\n${documentSummary(out, document, stdoutWidth(io))}\n${out.bold('Next')}\n${next}`;
  });
}

/** Everything a developer or an agent needs, in one command; the exit code says whether it worked. */
async function setupCommand(context: Context): Promise<number> {
  const { io, values } = context;
  if (context.args.length > 0) throw new UsageError(`setup takes no arguments (got "${context.args[0]}")`, [], true);
  return setup(io, {
    clients: values.client,
    test: Boolean(values.test),
    yes: Boolean(values.yes),
    json: Boolean(values.json),
    noBrowser: Boolean(values['no-browser']),
    skipLogin: Boolean(values['skip-login']),
    skipMcp: Boolean(values['skip-mcp']),
    skipSkill: Boolean(values['skip-skill']),
    apiKey: values['api-key'],
    baseUrl: values['base-url'],
  });
}

/** A command returns nothing (exit 0) or its own exit code. */
const COMMANDS: Record<string, (context: Context) => Promise<void | number>> = {
  setup: setupCommand,
  login,
  logout,
  whoami,
  wallet,
  spaces,
  space,
  search,
  ask,
  skill,
  markdown,
  diff,
  scans,
  scan,
  'scan-status': scanStatus,
  check,
  cancel,
  'delete-space': deleteSpace,
};

/** What went wrong with the command line, and where to look (exit code 2). */
function usageFailure(io: Io, s: Style, message: string, command: string | null, extra: string[] = [], showUsage = false): number {
  let text = `${s.fail} ${message}\n`;
  if (showUsage && command) text += `  ${s.dim('Usage:')} ${usageOf(command, ' '.repeat(9))}\n`;
  // Where to read more, unless the error already says what to do.
  const help = command ? `\`spacecontext ${command} --help\` shows its options` : '`spacecontext --help` lists every command';
  text += nextLines(s, extra.length === 0 || showUsage ? [...extra, help] : extra);
  io.stderr(text);
  return 2;
}

/** A command of the CLI (never a property every object has, such as `constructor`). */
function isCommand(name: string): boolean {
  return Object.hasOwn(COMMANDS, name);
}

/** Node's message for a command line it cannot parse, in a shorter form. */
function parseFailure(error: unknown): { message: string; hint: string | null } {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = /Unknown option '(-{1,2}[^']+)'/.exec(message);
  if (unknown) {
    const option = unknown[1]!;
    const guess = closest(option.replace(/^-+/, ''), Object.keys(OPTIONS));
    return { message: `Unknown option ${option}`, hint: guess ? `Did you mean --${guess}?` : null };
  }
  const value = /Option '(-{1,2}[^ ']+)[^']*' argument missing/.exec(message);
  if (value) return { message: `${value[1]} needs a value`, hint: null };
  return { message: message.split('. ')[0]!, hint: null };
}

/** Runs the CLI. Returns the exit code: 0 success, 1 failure, 2 wrong usage. */
export async function main(argv: string[], io: Io): Promise<number> {
  const out = styleFor(io, 'stdout');
  const err = styleFor(io, 'stderr');
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    const { message, hint } = parseFailure(error);
    const command = argv.find((arg) => !arg.startsWith('-') && isCommand(arg)) ?? null;
    return usageFailure(io, err, message, command, hint ? [hint] : []);
  }
  const values = parsed.values as Values;
  const [command, ...args] = parsed.positionals;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (command === 'help') {
    const topic = args[0];
    if (topic && isCommand(topic)) {
      io.stdout(commandHelp(out, topic));
      return 0;
    }
    if (topic) return usageFailure(io, err, `No command "${topic}"`, null);
    io.stdout(mainHelp(out, VERSION));
    return 0;
  }
  if (!command) {
    io.stdout(mainHelp(out, VERSION));
    return values.help ? 0 : 2;
  }
  const run = isCommand(command) ? COMMANDS[command] : undefined;
  if (!run) {
    if (LOOKS_LIKE_KEY.test(command)) {
      return usageFailure(io, err, 'Unknown command (it looks like an API key: it is not shown)', null, ['Sign in with it: `spacecontext login --key -`']);
    }
    const guess = closest(command, [...Object.keys(COMMANDS), 'help']);
    return usageFailure(io, err, `Unknown command ${shown(command)}`, null, guess ? [`Did you mean \`spacecontext ${guess}\`?`] : []);
  }
  if (values.help) {
    io.stdout(commandHelp(out, command));
    return 0;
  }
  const accepted = new Set([...GLOBAL_OPTIONS, ...(COMMAND_HELP[command]?.accepts ?? [])]);
  const stray = Object.keys(values).find((name) => !accepted.has(name));
  if (stray) return usageFailure(io, err, `${command} does not take --${stray}`, command);

  const context: Context = { io, values, args, out, err, failure: { command } };
  try {
    // Only a number is an exit code (a stray return value must never become one).
    const code = await run(context);
    return typeof code === 'number' ? code : 0;
  } catch (error) {
    if (error instanceof UsageError) return usageFailure(io, err, safe(error.message), command, error.hints, error.showUsage);
    if (error instanceof SpaceContextError) {
      const request = error.requestId ? err.dim(` (request ${safe(error.requestId)})`) : '';
      io.stderr(`${err.fail} ${err.red(`Error [${safe(error.code)}]`)}: ${safe(error.message)}${request}\n${nextLines(err, hints(error, context.failure))}`);
      return 1;
    }
    io.stderr(`${err.fail} ${err.red('Error')}: ${safe(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}
