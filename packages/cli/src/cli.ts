import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { SpaceContext, SpaceContextError, type FrameCheck, type Scan, type SpaceDiff, type SpaceDocument, type SpaceSummary, type SpaceType } from '@spacecontext/sdk';
import { clearConfig, configDirectory, readConfig, writeConfig } from './config.js';
import { stat } from 'node:fs/promises';
import { fileBlob, frameFiles, MAX_FRAME_BYTES, MAX_VIDEO_BYTES, scanSource, UsageError, writeSkill } from './files.js';

export const VERSION = '0.1.0';

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Reads a line typed by the user (the API key on login). Null when there is no terminal. */
  prompt: ((question: string) => Promise<string>) | null;
  fetch?: typeof fetch;
};

const SPACE_TYPES: SpaceType[] = ['apartment', 'house', 'office', 'warehouse', 'vehicle', 'boat', 'camper', 'shop', 'garage', 'appliance', 'other'];

const HELP = `spacecontext ${VERSION} — the context layer for the physical world

Usage: spacecontext <command> [options]

Account
  login [--key sc_…]            Save an API key (from the console) for this computer
  logout                        Forget the saved key
  whoami                        Show the account, mode and scopes of the key
  wallet                        Show the prepaid balance and the free scans left

Spaces
  spaces [--source app|api]     List your spaces
  space <id> [--transcript]     Show a space (use --json for the whole document)
  search <question…> [--space <id>] [--limit n]
                                Search every space you can read
  ask <space-id> <question…>    Ask a space a question, answered with citations
  skill <space-id> [--out dir] [--transcript]
                                Export a space as an Agent Skill folder
  scans <space-id>              The scan history of a space
  diff <space-id> --from <scan-id> [--to <scan-id>]
                                What changed between two scans
  delete-space <space-id>       Delete a space created through the API, with its scans

Scans
  scan <video|frames-dir> (--space <id> | --name <name> [--type <type>])
       [--language en|it] [--no-wait]
                                Upload a video (.mp4 .mov .m4v) or a folder of
                                frames, analyse it, and wait for the result
  check <image|frames-dir>      Before scanning: which frames are usable, and which
                                key locations (fuse box, stopcock, boiler…) they show
  scan-status <scan-id>         Show where a scan is
  cancel <scan-id>              Cancel a scan that has not started (nothing is charged)

Options
  --json                        Print the API response as JSON
  --api-key <key>               Use this key instead of the saved one or SPACECONTEXT_API_KEY
  --base-url <url>              API base URL (default https://api.spacecontext.finikos.it/v1)
  -h, --help                    Show this help
  -v, --version                 Show the version

Docs: https://spacecontext.finikos.it/developers
`;

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
} satisfies ParseArgsConfig['options'];

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string };

type Context = { io: Io; values: Values; args: string[] };

function print(io: Io, values: Values, json: unknown, text: () => string): void {
  io.stdout(values.json ? `${JSON.stringify(json, null, 2)}\n` : text());
}

function money(cents: number): string {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function one(args: string[], what: string): string {
  const [value] = args;
  if (!value) throw new UsageError(`Missing ${what}`);
  return value;
}

function words(args: string[], what: string): string {
  const text = args.join(' ').trim();
  if (!text) throw new UsageError(`Missing ${what}`);
  return text;
}

async function client(context: Context): Promise<SpaceContext> {
  const { io, values } = context;
  const stored = await readConfig(configDirectory(io.env));
  const apiKey = values['api-key'] ?? io.env.SPACECONTEXT_API_KEY ?? stored.apiKey;
  if (!apiKey) throw new UsageError('No API key: run `spacecontext login`, or set SPACECONTEXT_API_KEY');
  // The base URL saved by `login` belongs to the key saved with it: a key from
  // the flag or the environment never goes to it.
  const usesStoredKey = values['api-key'] === undefined && io.env.SPACECONTEXT_API_KEY === undefined;
  const baseUrl = values['base-url'] ?? io.env.SPACECONTEXT_BASE_URL ?? (usesStoredKey ? stored.baseUrl : undefined);
  return new SpaceContext({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
}

function documentSummary(document: SpaceDocument): string {
  const lines = [
    `${document.space.name}  (${document.space.id}, ${document.space.source})`,
    `Scan ${document.scan.id}${document.scan.analyzed_at ? `, ${document.scan.analyzed_at}` : ''} — ${document.enrichment.level} level, ${document.enrichment.status}`,
    `${document.stats.areas} areas, ${document.stats.items} items, ${document.stats.issues} issues, ${document.stats.key_locations} key locations, ${document.stats.facts} facts`,
  ];
  if (document.summary) lines.push('', document.summary);
  for (const area of document.areas) {
    const items = document.items.filter((item) => item.area_id === area.id).map((item) => item.name);
    lines.push('', `## ${area.name || area.id}`, items.length > 0 ? items.join(', ') : '(no items)');
  }
  if (document.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of document.issues) lines.push(`  - [${issue.severity ?? 'n/a'}] ${issue.title}`);
  }
  const checklist = document.coverage.checklist ?? [];
  if (checklist.length > 0) {
    const seen = checklist.filter((check) => check.seen).map((check) => kindLabel(check.kind));
    const unseen = checklist.filter((check) => !check.seen).map((check) => kindLabel(check.kind));
    lines.push('', `Key locations filmed: ${seen.join(', ') || 'none'}`);
    if (unseen.length > 0) lines.push(`Not filmed: ${unseen.join(', ')}`);
  }
  for (const warning of document.coverage.warnings) lines.push('', `Note: ${warning}`);
  return `${lines.join('\n')}\n`;
}

function kindLabel(kind: string): string {
  return kind.replaceAll('_', ' ');
}

function scanLine(scan: Scan): string {
  const stage = scan.stage ? ` (${scan.stage})` : '';
  const error = scan.error ? ` — ${scan.error.code}: ${scan.error.message}` : '';
  return `${scan.id} ${scan.status}${stage}${error}`;
}

// ------------------------------------------------------------------ commands

async function login(context: Context): Promise<void> {
  const { io, values } = context;
  let key = values.key ?? values['api-key'];
  if (!key) {
    if (!io.prompt) throw new UsageError('Pass the key with --key (create one in the console)');
    key = (await io.prompt('API key (sc_live_… or sc_test_…): ')).trim();
  }
  const baseUrl = values['base-url'];
  const sc = new SpaceContext({ apiKey: key, ...(baseUrl ? { baseUrl } : {}), ...(io.fetch ? { fetch: io.fetch } : {}) });
  const me = await sc.me();
  const file = await writeConfig(configDirectory(io.env), { apiKey: key, ...(baseUrl ? { baseUrl } : {}) });
  print(io, values, me, () => `Logged in as ${me.user.email} with a ${me.key.mode} key (${me.key.scopes.join(', ')}).\nSaved in ${file}\n`);
}

async function logout(context: Context): Promise<void> {
  await clearConfig(configDirectory(context.io.env));
  print(context.io, context.values, { logged_out: true }, () => 'Logged out.\n');
}

async function whoami(context: Context): Promise<void> {
  const me = await (await client(context)).me();
  print(context.io, context.values, me, () =>
    `${me.user.email}${me.user.is_pro ? ' (Pro)' : ''}\nKey ${me.key.id}: ${me.key.mode}, scopes ${me.key.scopes.join(', ')}\n`
  );
}

async function wallet(context: Context): Promise<void> {
  const wallet = await (await client(context)).wallet();
  print(context.io, context.values, wallet, () =>
    `Balance ${money(wallet.balance_cents)} · ${wallet.free_scans_remaining} free scan(s) left · ${money(wallet.scan_price_cents)} per scan\n` +
    `Auto-recharge ${wallet.auto_recharge.enabled ? 'on' : 'off'}\n`
  );
}

async function spaces(context: Context): Promise<void> {
  const source = context.values.source;
  if (source !== undefined && source !== 'app' && source !== 'api') throw new UsageError('--source must be app or api');
  const sc = await client(context);
  const all: SpaceSummary[] = [];
  for await (const space of sc.spaces.iterate(source ? { source } : {})) all.push(space);
  print(context.io, context.values, all, () =>
    all.length === 0
      ? 'No spaces yet. Scan one with `spacecontext scan video.mp4 --name "My flat"`.\n'
      : all
          .map((space) => {
            const scan = space.latest_scan;
            return `${space.id}  ${space.name}${scan ? `  (${scan.areas} areas, ${scan.items} items, ${scan.issues} issues)` : '  (no scan yet)'}`;
          })
          .join('\n') + '\n'
  );
}

async function space(context: Context): Promise<void> {
  const id = one(context.args, 'space id');
  const document = await (await client(context)).spaces.get(id, context.values.transcript ? { include: 'transcript' } : {});
  print(context.io, context.values, document, () => documentSummary(document));
}

async function search(context: Context): Promise<void> {
  const query = words(context.args, 'question');
  const limitText = context.values.limit;
  if (limitText !== undefined && !/^\d+$/.test(limitText)) throw new UsageError('--limit must be a number');
  const results = await (await client(context)).search(query, {
    ...(context.values.space ? { spaceId: context.values.space } : {}),
    ...(limitText ? { limit: Number(limitText) } : {}),
  });
  print(context.io, context.values, results, () =>
    results.data.length === 0
      ? 'Nothing found.\n'
      : results.data
          .map((hit) => `${hit.title}${inArea(hit.title, hit.area, ' — ')}  [${hit.space_name}, ${hit.record_type} ${hit.record_id}]\n  ${hit.text}`)
          .join('\n') + '\n'
  );
}

/** The area after a record's title, left out when the record is the area itself. */
function inArea(title: string, area: string | null | undefined, before: string, after = ''): string {
  return area && area !== title ? `${before}${area}${after}` : '';
}

async function ask(context: Context): Promise<void> {
  const [id, ...rest] = context.args;
  if (!id) throw new UsageError('Missing space id');
  const answer = await (await client(context)).spaces.ask(id, words(rest, 'question'));
  print(context.io, context.values, answer, () => {
    const sources = answer.citations.map((citation) => `  - ${citation.title}${inArea(citation.title, citation.area, ' (', ')')}`);
    return `${answer.answer}\n${sources.length > 0 ? `\nSources:\n${sources.join('\n')}\n` : ''}`;
  });
}

async function skill(context: Context): Promise<void> {
  const id = one(context.args, 'space id');
  const bundle = await (await client(context)).spaces.skill(id, context.values.transcript ? { include: 'transcript' } : {});
  // The default folder is named by the API: a name that is not a plain slug
  // ("../../x", "/etc") would place the skill outside the current directory.
  if (!context.values.out && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bundle.name)) {
    throw new Error(`Refusing to use "${bundle.name}" as a folder name: pass --out <dir>`);
  }
  const directory = path.resolve(context.io.cwd, context.values.out ?? bundle.name);
  const written = await writeSkill(directory, bundle);
  print(context.io, context.values, { directory, files: written }, () =>
    `Skill "${bundle.name}" written to ${directory} (${written.length} files).\nAdd the folder to your agent's skills, e.g. ~/.claude/skills/${bundle.name}\n`
  );
}

async function diff(context: Context): Promise<void> {
  const id = one(context.args, 'space id');
  const from = context.values.from;
  if (!from) throw new UsageError('--from <scan-id> is required');
  const result = await (await client(context)).spaces.diff(id, { from, ...(context.values.to ? { to: context.values.to } : {}) });
  print(context.io, context.values, result, () => diffSummary(result));
}

function diffSummary(diff: SpaceDiff): string {
  const where = (area: string | null) => (area ? ` — ${area}` : '');
  const out: string[] = [
    `${diff.from.scan_id} → ${diff.to.scan_id} (${diff.level} level, ${diff.linked ? 'the later scan was checked against the earlier one' : 'matched by content'})`,
  ];
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) out.push('', `${title} (${lines.length})`, ...lines.map((line) => `  ${line}`));
  };
  section('Areas added', diff.areas.added);
  section('Areas not in the later scan', diff.areas.removed);
  section('Areas in another condition', diff.areas.condition_changed.map((entry) => `${entry.area}: ${entry.from} → ${entry.to}`));
  section('Items added', diff.items.added.map((item) => `+ ${item.name}${where(item.area)}`));
  section('Items gone (seen: the place is empty)', diff.items.removed.map((item) => `- ${item.name}${where(item.area)}${item.note ? `: ${item.note}` : ''}`));
  section('Items not seen in the later scan (gone, or not filmed)', diff.items.not_seen.map((item) => `? ${item.name}${where(item.area)}`));
  section('Items moved', diff.items.moved.map((item) => `${item.name}: ${item.from_area ?? 'no area'} → ${item.area ?? 'no area'}`));
  section('Items recounted', diff.items.quantity_changed.map((item) => `${item.name}${where(item.area)}: ${item.from_quantity} → ${item.quantity}`));
  section('Items in another condition', diff.items.condition_changed.map((item) => `${item.name}${where(item.area)}: ${item.from_condition} → ${item.to_condition}`));
  section('Issues new', diff.issues.new.map((issue) => `! ${issue.title}${where(issue.area)}`));
  section('Issues fixed (seen)', diff.issues.resolved.map((issue) => `✓ ${issue.title}${where(issue.area)}${issue.note ? `: ${issue.note}` : ''}`));
  section('Issues not seen in the later scan', diff.issues.not_seen.map((issue) => `? ${issue.title}${where(issue.area)}`));
  if (out.length === 1) out.push('', 'No differences found.');
  return `${out.join('\n')}\n`;
}

async function scans(context: Context): Promise<void> {
  const id = one(context.args, 'space id');
  const { data } = await (await client(context)).spaces.scans(id);
  print(context.io, context.values, data, () =>
    data.length === 0
      ? 'No completed scan yet.\n'
      : data.map((entry) => `${entry.id}${entry.current ? ' (current)' : ''}  ${entry.analyzed_at ?? 'date unknown'}  ${entry.areas} areas, ${entry.items} items, ${entry.issues} issues`).join('\n') + '\n'
  );
}

async function cancel(context: Context): Promise<void> {
  const id = one(context.args, 'scan id');
  await (await client(context)).scans.cancel(id);
  print(context.io, context.values, { cancelled: id }, () => `Scan ${id} cancelled. Nothing was charged.\n`);
}

async function deleteSpace(context: Context): Promise<void> {
  const id = one(context.args, 'space id');
  await (await client(context)).spaces.delete(id);
  print(context.io, context.values, { deleted: id }, () => `Space ${id} deleted, with its scans and files.\n`);
}

async function scanStatus(context: Context): Promise<void> {
  const scan = await (await client(context)).scans.get(one(context.args, 'scan id'));
  print(context.io, context.values, scan, () => `${scanLine(scan)}\n`);
}

/**
 * Checks images before they are scanned: usable or not, and which key locations
 * they show, so what is missing can be filmed before paying for a scan.
 */
async function check(context: Context): Promise<void> {
  const { io, values } = context;
  const files = await frameFiles(path.resolve(io.cwd, one(context.args, 'image or frames directory')));
  for (const frame of files) {
    if ((await stat(frame.file)).size > MAX_FRAME_BYTES) throw new UsageError(`${path.basename(frame.file)} is larger than ${MAX_FRAME_BYTES / 1_048_576} MB`);
  }
  const sc = await client(context);
  const checked: Array<{ file: string; check: FrameCheck }> = [];
  for (const frame of files) {
    checked.push({ file: path.basename(frame.file), check: await sc.frames.check(await fileBlob(frame.file), frame.contentType) });
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
    const width = Math.max(...checked.map(({ file }) => file.length));
    const lines = checked.map(({ file, check }) => {
      const state = check.usable ? 'usable' : 'NOT usable';
      const shows = check.key_locations.filter((entry) => entry.seen).map((entry) => kindLabel(entry.kind));
      return `${file.padEnd(width)}  ${state} (${check.quality.level}, ${check.quality.score.toFixed(1)})${shows.length > 0 ? `  ${shows.join(', ')}` : ''}`;
    });
    lines.push('', `Usable: ${usable} of ${checked.length} frame${checked.length === 1 ? '' : 's'}`);
    lines.push(`Seen: ${seen.length > 0 ? seen.map((entry) => `${kindLabel(entry.kind)} (${entry.file})`).join(', ') : 'none'}`);
    if (notSeen.length > 0) lines.push(`Not seen yet: ${notSeen.map(kindLabel).join(', ')}. Film them before scanning if the space has them.`);
    return `${lines.join('\n')}\n`;
  });
}

async function scan(context: Context): Promise<void> {
  const { io, values } = context;
  const input = path.resolve(io.cwd, one(context.args, 'video file or frames directory'));
  if (Boolean(values.space) === Boolean(values.name)) throw new UsageError('Pass either --space <id> or --name <name>');
  const language = values.language ?? 'en';
  if (language !== 'en' && language !== 'it') throw new UsageError('--language must be en or it');
  const spaceType = values.type;
  if (spaceType !== undefined && !SPACE_TYPES.includes(spaceType as SpaceType)) {
    throw new UsageError(`--type must be one of ${SPACE_TYPES.join(', ')}`);
  }
  const source = await scanSource(input);
  // Checked before anything is created: the API limits, from the same source as the SDK.
  if (source.kind === 'video' && source.size > MAX_VIDEO_BYTES) {
    throw new UsageError(`${path.basename(source.file)} is larger than ${MAX_VIDEO_BYTES / 1_048_576} MB`);
  }
  if (source.kind === 'frames') {
    for (const frame of source.files) {
      if ((await stat(frame.file)).size > MAX_FRAME_BYTES) throw new UsageError(`${path.basename(frame.file)} is larger than ${MAX_FRAME_BYTES / 1_048_576} MB`);
    }
  }
  const sc = await client(context);
  const progress = (text: string) => {
    if (!values.json) io.stderr(text);
  };

  let spaceId = values.space!;
  if (values.name) {
    const created = await sc.spaces.create({ name: values.name, ...(spaceType ? { space_type: spaceType as SpaceType } : {}) });
    spaceId = created.id;
    progress(`Created space ${created.id}\n`);
  }

  let started: Scan;
  try {
    if (source.kind === 'video') {
      progress(`Uploading ${path.basename(source.file)} (${(source.size / 1_048_576).toFixed(1)} MB)…\n`);
      started = await sc.scans.fromVideo(spaceId, { data: await fileBlob(source.file), contentType: source.contentType, language });
    } else {
      progress(`Uploading ${source.files.length} frames…\n`);
      const frames = await Promise.all(source.files.map(async (frame) => ({ data: await fileBlob(frame.file), contentType: frame.contentType })));
      started = await sc.scans.fromFrames(spaceId, frames, { language });
    }
  } catch (error) {
    // The SDK has cancelled the scan; a space made for it stays and is said so.
    if (values.name) progress(`The space ${spaceId} was created but has no scan: scan again with --space ${spaceId}, or remove it with \`spacecontext delete-space ${spaceId}\`.\n`);
    throw error;
  }
  const charge = !started.livemode ? 'test mode, no charge' : started.charge.kind === 'free_scan' ? 'free scan' : money(started.charge.price_cents);
  progress(`Scan ${started.id} started (${charge}).\n`);

  if (values['no-wait']) {
    print(io, values, started, () => `Check it with: spacecontext scan-status ${started.id}\n`);
    return;
  }
  let lastStage: string | null = null;
  const finished = await sc.scans.wait(started.id, {
    onProgress: (current) => {
      const stage = current.stage ?? current.status;
      if (stage !== lastStage) progress(`  ${stage}…\n`);
      lastStage = stage;
    },
  });
  if (finished.status !== 'complete') {
    throw new SpaceContextError(
      `Scan ${finished.status}: ${finished.error?.message ?? 'no detail'}${finished.charge.refunded ? ' (refunded)' : ''}`,
      0,
      finished.error?.code ?? 'SCAN_FAILED',
      null
    );
  }
  const document = await sc.spaces.get(spaceId, { enrich: 'none' });
  print(io, values, document, () => `${documentSummary(document)}\nNext: spacecontext ask ${spaceId} "where is the fuse box?"\n`);
}

const COMMANDS: Record<string, (context: Context) => Promise<void>> = {
  login,
  logout,
  whoami,
  wallet,
  spaces,
  space,
  search,
  ask,
  skill,
  diff,
  scans,
  scan,
  'scan-status': scanStatus,
  check,
  cancel,
  'delete-space': deleteSpace,
};

/** Runs the CLI. Returns the exit code: 0 success, 1 failure, 2 wrong usage. */
export async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\nRun \`spacecontext --help\`.\n`);
    return 2;
  }
  const values = parsed.values as Values;
  const [command, ...args] = parsed.positionals;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (values.help || !command) {
    io.stdout(HELP);
    return command || values.help ? 0 : 2;
  }
  const run = COMMANDS[command];
  if (!run) {
    io.stderr(`Unknown command "${command}". Run \`spacecontext --help\`.\n`);
    return 2;
  }
  try {
    await run({ io, values, args });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    if (error instanceof SpaceContextError) {
      const request = error.requestId ? ` (request ${error.requestId})` : '';
      io.stderr(`Error [${error.code}]: ${error.message}${request}\n${hint(error.code)}`);
      return 1;
    }
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function hint(code: string): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return 'Top up your wallet in the console: https://spacecontext.finikos.it/developers/console\n';
    case 'PRO_REQUIRED':
      return 'Spaces scanned with the app are readable through the API with Space Context Pro.\n';
    case 'ENRICHMENT_PENDING':
      return 'The space is being screened for sensitive values; try again in a minute.\n';
    case 'INSUFFICIENT_SCOPE':
      return 'This key lacks a scope for this request; create one with the right scopes in the console.\n';
    case 'INVALID_TOKEN':
    case 'MISSING_AUTH_HEADER':
      return 'Run `spacecontext login` with a valid key.\n';
    default:
      return '';
  }
}
