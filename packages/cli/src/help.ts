import type { ReportLanguage } from '@spacecontext/sdk';
import { CLI_DOCS_URL, DEFAULT_API_URL } from './links.js';
import { brandLine, type Style } from './ui.js';

/**
 * Every command's help, and the options it takes: `spacecontext --help` lists
 * the commands by group, `spacecontext <command> --help` shows one of them, and
 * an option a command does not take is refused (instead of silently ignored).
 */

export type Group = 'Get started' | 'Scan a space' | 'Read a space' | 'Export' | 'Account';

export type CommandHelp = {
  group: Group;
  /** One line for the list of commands. */
  summary: string;
  /** Usage lines, after `spacecontext `. */
  usage: string[];
  /** A few lines on what it does. */
  about?: string[];
  /** The options it takes besides the global ones: [flag, description]. */
  options?: Array<[string, string]>;
  examples?: string[];
  /** Option names this command accepts (besides the global ones). */
  accepts: string[];
};

/** Options every command takes. */
export const GLOBAL_OPTIONS = ['json', 'api-key', 'base-url', 'help', 'version'];

export const SPACE_TYPES = ['apartment', 'house', 'office', 'warehouse', 'vehicle', 'boat', 'camper', 'shop', 'garage', 'appliance', 'other'] as const;

/** The languages a report can be written in (the SDK's `REPORT_LANGUAGES`), with their own names. */
export const LANGUAGE_NAMES: Record<ReportLanguage, string> = {
  en: 'English',
  it: 'Italiano',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  nl: 'Nederlands',
};
const LANGUAGES = Object.entries(LANGUAGE_NAMES).map(([code, name]) => `${code} ${name}`);

export const COMMAND_HELP: Record<string, CommandHelp> = {
  setup: {
    group: 'Get started',
    summary: 'Sign in, connect your assistants (MCP) and install the skill',
    usage: ['setup [options]'],
    about: [
      'Signs in, adds the MCP server to the Claude Code, Codex, Cursor and VS Code it',
      'finds, installs the Space Context skill in ~/.claude/skills/spacecontext/ and',
      'checks that live scans have a card on file. Each step reports done, skipped or',
      'failed; none stops the others. Exit code 0 once signed in and connected.',
    ],
    options: [
      ['--client <list>', 'claude-code, codex, cursor, vscode or all (default: found)'],
      ['--test', 'Sign in for a free test key (reads the demo space spc_demo)'],
      ['-y, --yes', 'No questions and no browser: for agents and scripts'],
      ['--json', 'Print a JSON summary on stdout (steps go to stderr)'],
      ['--no-browser', 'Print links instead of opening them'],
      ['--skip-login', 'Keep the key in use, or none'],
      ['--skip-mcp', 'Do not touch the assistants'],
      ['--skip-skill', 'Do not install the skill'],
    ],
    examples: ['npx spacecontext@latest setup', 'npx spacecontext@latest setup --yes --json', 'spacecontext setup --client claude-code,cursor --test'],
    accepts: ['client', 'test', 'yes', 'no-browser', 'skip-login', 'skip-mcp', 'skip-skill'],
  },
  login: {
    group: 'Get started',
    summary: 'Sign in with a code approved in the console',
    usage: ['login [--test] [--no-browser]', 'login --key -'],
    about: [
      'Shows a code and opens the console: sign in there, type the code and approve.',
      'The key comes back to the terminal, never through the browser, and is saved',
      'in ~/.config/spacecontext/config.json, readable only by you.',
    ],
    options: [
      ['--test', 'A test key: free, reads the demo space spc_demo, never real data'],
      ['--no-browser', 'Print the link without opening the browser'],
      ['--key -', 'Save a key you already have, typed without echo'],
      ['--key sc_…', 'The same, but the key stays in your shell history'],
    ],
    examples: ['spacecontext login --test', 'spacecontext login', 'spacecontext login --key -'],
    accepts: ['key', 'test', 'no-browser'],
  },
  scan: {
    group: 'Scan a space',
    summary: 'Upload a video or photos and follow the analysis live',
    usage: ['scan <video|photos-dir> --name <name> [options]', 'scan <video|photos-dir> --space <space-id> [options]'],
    about: [
      'Video: .mp4 .mov .m4v, up to 100 MB and 10 minutes, narrated or not.',
      'Photos: a folder of .jpg .png .webp, up to 120 of 2 MB each, in name order.',
      'Test keys scan for free and return the demo content. Live keys use the',
      "account's free scan first, then the price per scan from the prepaid balance",
      '(spacecontext wallet). A failed scan is refunded.',
      '',
      `Types: ${SPACE_TYPES.slice(0, 6).join(', ')},`,
      `       ${SPACE_TYPES.slice(6).join(', ')}`,
      `Languages: ${LANGUAGES.slice(0, 5).join(', ')},`,
      `           ${LANGUAGES.slice(5).join(', ')}`,
    ],
    options: [
      ['--name <name>', 'Create a new space with this name'],
      ['--space <space-id>', 'Scan an existing space again; compared with its last scan'],
      ['--type <type>', 'With --name: the kind of space (types below)'],
      ['--language <code>', 'Report language (below; default en), whatever is spoken'],
      ['--format <format>', 'text (default), json, markdown or skill'],
      ['--out <path>', 'With --format skill: the folder; with markdown: the file'],
      ['--no-wait', 'Start the scan and return without following it'],
    ],
    examples: [
      'spacecontext scan ./flat.mp4 --name "Seaside flat" --type apartment',
      'spacecontext scan ./photos --space spc_… --format skill --out ./seaside-flat',
    ],
    accepts: ['space', 'name', 'type', 'language', 'format', 'out', 'no-wait'],
  },
  check: {
    group: 'Scan a space',
    summary: 'Check photos before a scan: usable, key locations shown',
    usage: ['check <image|photos-dir>'],
    about: [
      'Checks each image: usable or not, and which key locations it shows (fuse box,',
      'water shut-off, boiler, smoke detector…), so you can film what is missing',
      'before paying for a scan. Free; needs a key that can scan (scans:write).',
    ],
    examples: ['spacecontext check ./photos'],
    accepts: [],
  },
  'scan-status': {
    group: 'Scan a space',
    summary: 'Show where a scan is',
    usage: ['scan-status <scan-id> [--follow]'],
    options: [['--follow', 'Print every change until the scan ends']],
    examples: ['spacecontext scan-status scn_… --follow'],
    accepts: ['follow'],
  },
  cancel: {
    group: 'Scan a space',
    summary: 'Cancel a scan that has not started; nothing is charged',
    usage: ['cancel <scan-id>'],
    accepts: [],
  },
  spaces: {
    group: 'Read a space',
    summary: 'List your spaces',
    usage: ['spaces [--source app|api]'],
    about: [
      'app_… spaces come from the iPhone app; spc_… spaces from the API.',
      'Test and live keys see different spaces: a test key sees the demo (spc_demo)',
      'and the spaces made with test keys.',
    ],
    options: [['--source app|api', 'Only spaces from the app, or only those made through the API']],
    examples: ['spacecontext spaces', 'spacecontext spaces --json'],
    accepts: ['source'],
  },
  space: {
    group: 'Read a space',
    summary: 'Show a space: areas, items, issues, key locations',
    usage: ['space <space-id> [--transcript]'],
    options: [
      ['--transcript', 'Include what was said (needs a key with spaces:sensitive)'],
      ['--json', 'The whole Space Document'],
    ],
    examples: ['spacecontext space spc_demo', 'spacecontext space spc_demo --json > space.json'],
    accepts: ['transcript'],
  },
  ask: {
    group: 'Read a space',
    summary: 'Ask a space a question; the answer cites its sources',
    usage: ['ask <space-id> <question…>'],
    about: ['The answer comes only from the space\'s records; when they do not say, it says', '"not documented" instead of guessing.'],
    examples: ['spacecontext ask spc_demo "where is the fuse box?"'],
    accepts: [],
  },
  search: {
    group: 'Read a space',
    summary: 'Search every space you can read, in any language',
    usage: ['search <question…> [--space <space-id>] [--limit <n>]'],
    options: [
      ['--space <space-id>', 'Search one space only'],
      ['--limit <n>', 'Results, 1 to 25 (default 10)'],
    ],
    examples: ['spacecontext search "where is the water shut-off?"', 'spacecontext search ladder --space spc_demo --limit 3'],
    accepts: ['space', 'limit'],
  },
  scans: {
    group: 'Read a space',
    summary: 'The scan history of a space',
    usage: ['scans <space-id>'],
    examples: ['spacecontext scans spc_demo'],
    accepts: [],
  },
  diff: {
    group: 'Read a space',
    summary: 'What changed between two scans',
    usage: ['diff <space-id> --from <scan-id> [--to <scan-id>]'],
    about: ['"Gone" only when a frame shows the empty place; the rest is "not seen".'],
    options: [
      ['--from <scan-id>', 'The earlier scan (spacecontext scans <space-id> lists them)'],
      ['--to <scan-id>', 'The later scan (default: the current one)'],
    ],
    examples: ['spacecontext diff spc_demo --from scn_…'],
    accepts: ['from', 'to'],
  },
  skill: {
    group: 'Export',
    summary: 'Write a space as an Agent Skill folder',
    usage: ['skill <space-id> [--out <dir>] [--transcript]'],
    about: ['SKILL.md, space.json and references/: drop the folder in your agent\'s skills,', 'for example ~/.claude/skills/<name>.'],
    options: [
      ['--out <dir>', 'Where to write it (default: a folder named after the space)'],
      ['--transcript', 'Include what was said (needs a key with spaces:sensitive)'],
    ],
    examples: ['spacecontext skill spc_demo --out ~/.claude/skills/brisbane-apartment'],
    accepts: ['out', 'transcript'],
  },
  markdown: {
    group: 'Export',
    summary: 'Print or write a space as one Markdown page',
    usage: ['markdown <space-id> [--out <file>] [--transcript]'],
    options: [
      ['--out <file>', 'Write to this file instead of printing'],
      ['--transcript', 'Include what was said (needs a key with spaces:sensitive)'],
    ],
    examples: ['spacecontext markdown spc_demo --out brisbane.md'],
    accepts: ['out', 'transcript'],
  },
  whoami: {
    group: 'Account',
    summary: 'The account, mode and scopes of the key in use',
    usage: ['whoami'],
    accepts: [],
  },
  wallet: {
    group: 'Account',
    summary: 'Balance, free scans left, card on file',
    usage: ['wallet'],
    accepts: [],
  },
  logout: {
    group: 'Account',
    summary: 'Forget the saved key',
    usage: ['logout'],
    accepts: [],
  },
  'delete-space': {
    group: 'Account',
    summary: 'Delete a space made through the API, with its scans and files',
    usage: ['delete-space <space-id>'],
    accepts: [],
  },
};

const GROUPS: Group[] = ['Get started', 'Scan a space', 'Read a space', 'Export', 'Account'];

const GLOBAL_HELP: Array<[string, string]> = [
  ['--json', 'Print JSON on stdout; progress and errors stay on stderr'],
  ['--api-key <key>', 'This key, not SPACECONTEXT_API_KEY or the saved one'],
  ['--base-url <url>', `API base URL (default ${DEFAULT_API_URL})`],
  ['-h, --help', 'Show help; spacecontext <command> --help for one command'],
  ['-v, --version', 'Show the version'],
];

function rows(s: Style, entries: Array<[string, string]>, width: number): string[] {
  return entries.map(([left, right]) => `  ${s.cyan(left.padEnd(width))}  ${right}`);
}

/** `spacecontext`, `spacecontext --help`. */
export function mainHelp(s: Style, version: string): string {
  const lines = [
    brandLine(s, 'Space Context', `CLI ${version}`),
    `  ${s.dim('The context layer for the physical world')}`,
    '',
    `${s.bold('Usage')}  spacecontext <command> [options]`,
  ];
  const width = Math.max(...Object.keys(COMMAND_HELP).map((name) => name.length));
  for (const group of GROUPS) {
    lines.push('', s.bold(group));
    for (const [name, help] of Object.entries(COMMAND_HELP)) {
      if (help.group === group) lines.push(`  ${s.cyan(name.padEnd(width))}  ${help.summary}`);
    }
  }
  lines.push(
    '',
    s.bold('Examples'),
    `  spacecontext login --test                            ${s.dim('# a free test key')}`,
    `  spacecontext ask spc_demo "where is the fuse box?"   ${s.dim('# the demo space')}`,
    '  spacecontext scan ./flat.mp4 --name "Seaside flat"',
    '  spacecontext skill spc_demo --out ~/.claude/skills/brisbane-apartment',
    '',
    s.bold('Options'),
    ...rows(s, GLOBAL_HELP, 16),
    '',
    `${s.bold('Docs')}  ${CLI_DOCS_URL}`
  );
  return `${lines.join('\n')}\n`;
}

/** `spacecontext <command> --help`. */
export function commandHelp(s: Style, name: string): string {
  const help = COMMAND_HELP[name]!;
  const lines = [brandLine(s, `spacecontext ${name}`), `  ${s.dim(help.summary)}`, '', s.bold('Usage'), ...help.usage.map((usage) => `  spacecontext ${usage}`)];
  if (help.about) lines.push('', ...help.about.map((line) => (line ? `  ${line}` : '')));
  const options = help.options ?? [];
  if (options.length > 0) {
    const width = Math.max(...options.map(([flag]) => flag.length));
    lines.push('', s.bold('Options'), ...rows(s, options, width));
  }
  if (help.examples) lines.push('', s.bold('Examples'), ...help.examples.map((example) => `  ${example}`));
  lines.push('', s.dim('Global options: --json, --api-key, --base-url (spacecontext --help)'));
  return `${lines.join('\n')}\n`;
}

/** The usage of a command, for a usage error; lines after the first are indented by `indent`. */
export function usageOf(name: string, indent = ''): string {
  const help = Object.hasOwn(COMMAND_HELP, name) ? COMMAND_HELP[name] : undefined;
  return help ? help.usage.map((usage) => `spacecontext ${usage}`).join(`\n${indent}`) : 'spacecontext <command> [options]';
}
