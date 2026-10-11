import type { Io } from '../cli.js';

/**
 * How the CLI looks in a terminal: colours, symbols, a live status line and
 * tables. Everything degrades: no colours with NO_COLOR, TERM=dumb or when the
 * stream is not a terminal (piped, redirected, CI), and no animation unless
 * the stream is a terminal. `--json` output never goes through here.
 */

export type Stream = 'stdout' | 'stderr';

/** https://no-color.org (set and not empty), FORCE_COLOR, TERM=dumb, then whether the stream is a terminal. */
export function colorEnabled(io: Io, stream: Stream): boolean {
  const { NO_COLOR, FORCE_COLOR, TERM } = io.env;
  if (NO_COLOR) return false;
  if (FORCE_COLOR !== undefined && FORCE_COLOR !== '') return FORCE_COLOR !== '0' && FORCE_COLOR !== 'false';
  if (TERM === 'dumb') return false;
  return io.terminal?.[stream] ?? false;
}

/** A spinner that rewrites its line: only at a terminal that can take it, never in CI logs. */
export function liveEnabled(io: Io, stream: Stream): boolean {
  if (!(io.terminal?.[stream] ?? false)) return false;
  return io.env.TERM !== 'dumb' && !io.env.CI;
}

type Paint = (text: string) => string;

export type Style = {
  color: boolean;
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  cyan: Paint;
  brand: Paint;
  /** 24-bit colour (COLORTERM=truecolor or 24bit); otherwise the 256-colour palette. */
  truecolor: boolean;
  /** ✓ done */
  ok: string;
  /** ✗ failed */
  fail: string;
  /** ! worth knowing */
  warn: string;
  /** › what to do next */
  next: string;
};

function paint(enabled: boolean, open: string, close: string): Paint {
  return enabled ? (text) => (text ? `\u001b[${open}m${text}\u001b[${close}m` : text) : (text) => text;
}

export function styleFor(io: Io, stream: Stream): Style {
  const color = colorEnabled(io, stream);
  const s = {
    color,
    bold: paint(color, '1', '22'),
    dim: paint(color, '2', '22'),
    red: paint(color, '31', '39'),
    green: paint(color, '32', '39'),
    yellow: paint(color, '33', '39'),
    cyan: paint(color, '36', '39'),
    brand: paint(color, '35', '39'),
  };
  const truecolor = color && /^(truecolor|24bit)$/i.test(io.env.COLORTERM ?? '');
  return { ...s, truecolor, ok: s.green('✓'), fail: s.red('✗'), warn: s.yellow('!'), next: s.brand('›') };
}

/**
 * The Space Context mark (the Cubo: a cube with the S taken out of it), 18 × 20
 * pixels, two pixels per character with half blocks. Same geometry as the logo
 * (spacecontext.app/icon/mark.svg), sampled on a grid.
 */
const MARK = [
  '........##........',
  '......######......',
  '....#########.....',
  '...############...',
  '.################.',
  '##################',
  '##################',
  '#####.............',
  '#####.............',
  '##################',
  '##################',
  '.............#####',
  '.............#####',
  '##################',
  '##################',
  '.################.',
  '...############...',
  '....#########.....',
  '......######......',
  '........##........',
];

/** Brand violet, light at the top (#A855F7) to deep at the bottom (#5B21B6), as on the logo. */
function markColor(s: Style, row: number, layer: 'fg' | 'bg'): string {
  const t = row / (MARK.length - 1);
  if (s.truecolor) {
    const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
    return `${layer === 'fg' ? 38 : 48};2;${mix(168, 91)};${mix(85, 33)};${mix(247, 182)}`;
  }
  const palette = [171, 135, 98, 92, 55];
  return `${layer === 'fg' ? 38 : 48};5;${palette[Math.min(palette.length - 1, Math.floor(t * palette.length))]}`;
}

/** The mark as terminal lines; empty without colours (piped, NO_COLOR, CI), where it would only be noise. */
export function brandMark(s: Style): string[] {
  if (!s.color) return [];
  const lines: string[] = [];
  for (let row = 0; row < MARK.length; row += 2) {
    const upper = MARK[row] ?? '';
    const lower = MARK[row + 1] ?? '';
    let line = '';
    for (let col = 0; col < upper.length; col++) {
      const top = upper[col] === '#';
      const bottom = lower[col] === '#';
      if (top && bottom) line += `\u001b[${markColor(s, row, 'fg')};${markColor(s, row + 1, 'bg')}m▀\u001b[0m`;
      else if (top) line += `\u001b[${markColor(s, row, 'fg')}m▀\u001b[0m`;
      else if (bottom) line += `\u001b[${markColor(s, row + 1, 'fg')}m▄\u001b[0m`;
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}

/**
 * The branded header: the mark with the given lines beside it at a terminal
 * that shows colours, and just the lines everywhere else.
 */
export function brandHeader(s: Style, lines: string[]): string[] {
  const mark = brandMark(s);
  if (mark.length === 0) return lines;
  const offset = Math.max(0, Math.floor((mark.length - lines.length) / 2));
  return mark.map((art, i) => {
    const text = lines[i - offset];
    return text === undefined ? art.trimEnd() : `${art}   ${text.trimStart()}`;
  });
}

/** `◆ Space Context  subtitle`: the one branded line. */
export function brandLine(s: Style, title: string, subtitle?: string): string {
  return `${s.brand('◆')} ${s.bold(title)}${subtitle ? `  ${s.dim(subtitle)}` : ''}`;
}

// ------------------------------------------------------------------ text

const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Columns a string takes, colours excluded (one per code point: good enough for names and ids). */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

/** Shortens plain text to `width` columns, ending with `…`. */
export function truncate(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return width <= 1 ? '…' : `${chars.slice(0, width - 1).join('')}…`;
}

function pad(text: string, width: number, right: boolean): string {
  const gap = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  return right ? gap + text : text + gap;
}

/** `12s`, `3m 05s`, `1h 02m`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** `4.2 GB`, `48.2 MB`, `812 KB`. */
export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A limit, without a needless decimal: `100 MB`, `4 GB`, `95 MB`. */
export function sizeLimit(bytes: number): string {
  const [value, unit] = bytes >= 1024 ** 3 ? [bytes / 1024 ** 3, 'GB'] : [bytes / 1_048_576, 'MB'];
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`;
}

/** `1 item`, `3 items`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A path under the home directory as `~/…`. */
export function tildePath(io: Io, file: string): string {
  const home = io.env.HOME || io.env.USERPROFILE;
  if (!home) return file;
  return file === home || file.startsWith(`${home}/`) || file.startsWith(`${home}\\`) ? `~${file.slice(home.length)}` : file;
}

/**
 * Rows in aligned columns, two spaces apart, with a dimmed header. When the
 * terminal's width is known, the `shrink` column is cut to fit it; otherwise
 * (piped) nothing is cut.
 */
export function table(
  s: Style,
  head: string[],
  rows: string[][],
  options: { right?: number[]; shrink?: number; width?: number | undefined } = {}
): string {
  const widths = head.map((title, column) => Math.max(visibleWidth(title), ...rows.map((row) => visibleWidth(row[column] ?? ''))));
  const shrink = options.shrink;
  if (shrink !== undefined && options.width) {
    const total = widths.reduce((sum, width) => sum + width, 0) + 2 * (widths.length - 1);
    const over = total - (options.width - 1);
    if (over > 0) widths[shrink] = Math.max(Math.min(widths[shrink]!, 12), widths[shrink]! - over);
  }
  const right = new Set(options.right ?? []);
  const line = (cells: string[], header: boolean) =>
    cells
      .map((cell, column) => {
        const fitted = column === shrink && visibleWidth(cell) > widths[column]! ? truncate(stripAnsi(cell), widths[column]!) : cell;
        const padded = pad(fitted, widths[column]!, right.has(column));
        return header ? s.dim(padded) : padded;
      })
      .join('  ')
      .trimEnd();
  return [line(head, true), ...rows.map((row) => line(row, false))].join('\n') + '\n';
}

/** The closest of `candidates` to a mistyped word, if it is close enough to be a typo. */
export function closest(word: string, candidates: readonly string[]): string | null {
  let best: { candidate: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(word.toLowerCase(), candidate.toLowerCase());
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  if (!best) return null;
  const allowed = Math.max(1, Math.floor(best.candidate.length / 3));
  return best.distance <= allowed ? best.candidate : null;
}

/** Edits between two words, a swap of two neighbouring letters counting as one (`scna` → `scan`). */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

// ------------------------------------------------------------------ live status

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 80;
const CLEAR_LINE = '\r\u001b[2K';

/**
 * The line that says what is happening now, on stderr. At a terminal it is a
 * spinner with the step's elapsed time, and each step that ends stays as a
 * `✓` line with how long it took. Elsewhere (piped, CI) each step is one plain
 * `› step…` line and nothing is ever rewritten.
 */
export class Status {
  readonly live: boolean;
  private readonly s: Style;
  private readonly now: () => number;
  private text: string | null = null;
  private since = 0;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly io: Io) {
    this.live = liveEnabled(io, 'stderr');
    this.s = styleFor(io, 'stderr');
    this.now = io.now ?? Date.now;
  }

  get running(): boolean {
    return this.text !== null;
  }

  /** Starts a step, ending the running one first. `plain: false` says nothing outside a terminal (quick steps). */
  step(text: string, options: { plain?: boolean } = {}): void {
    if (this.text !== null) this.complete();
    this.text = text;
    this.since = this.now();
    if (this.live) {
      this.timer ??= setInterval(() => this.render(), TICK_MS);
      // A spinner never keeps the process alive.
      (this.timer as { unref?: () => void }).unref?.();
      this.render();
    } else if (options.plain !== false) {
      this.io.stderr(`${this.s.next} ${text}…\n`);
    }
  }

  /** New words for the running step (an upload count): at a terminal only. */
  update(text: string): void {
    if (this.text === null) return;
    this.text = text;
    if (this.live) this.render();
  }

  /**
   * Ends the running step with a `✓` line: `text` (default: the step's own
   * words) and `detail` (default: how long it took). Outside a terminal the
   * line is printed only when `text` is given: the `›` line already said it.
   */
  complete(text?: string, detail?: string): void {
    this.end(this.s.ok, text, detail);
  }

  /** Ends the running step with a `✗` line, as `complete` does. */
  fail(text?: string, detail?: string): void {
    this.end(this.s.fail, text, detail);
  }

  /** A line that stays, printed above the spinner. */
  line(text: string): void {
    this.clear();
    this.io.stderr(`${text}\n`);
    if (this.text !== null && this.live) this.render();
  }

  /** Removes the spinner without a line. */
  stop(): void {
    this.clear();
    this.text = null;
    this.halt();
  }

  /** How long the running step has taken. */
  elapsed(): number {
    return this.now() - this.since;
  }

  private end(mark: string, text: string | undefined, detail: string | undefined): void {
    if (this.text === null) {
      if (text !== undefined) this.io.stderr(`${mark} ${text}${detail ? `  ${this.s.dim(detail)}` : ''}\n`);
      return;
    }
    const took = duration(this.elapsed());
    const words = text ?? this.text;
    this.clear();
    this.text = null;
    this.halt();
    if (this.live || text !== undefined) this.io.stderr(`${mark} ${words}  ${this.s.dim(detail ?? took)}\n`);
  }

  private render(): void {
    if (this.text === null || !this.live) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    const time = duration(this.elapsed());
    const width = this.io.columns && this.io.columns > 20 ? this.io.columns - 1 : 79;
    const words = truncate(`${this.text}…`, Math.max(10, width - 3 - time.length - 2));
    this.io.stderr(`${CLEAR_LINE}${this.s.brand(FRAMES[this.frame]!)} ${words}  ${this.s.dim(time)}`);
  }

  private clear(): void {
    if (this.live && this.text !== null) this.io.stderr(CLEAR_LINE);
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Runs `work` with a spinner at a terminal; says nothing elsewhere. */
export async function spinning<T>(io: Io, text: string, work: () => Promise<T>): Promise<T> {
  const status = new Status(io);
  if (!status.live) return work();
  status.step(text, { plain: false });
  try {
    return await work();
  } finally {
    status.stop();
  }
}
