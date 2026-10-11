import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The program that opens a URL in the browser, with its arguments; null when
 * the URL is not a web page (https, or http on this computer). The URL may come
 * from the API: on Windows it never goes through cmd, which reads `&`, `^` and
 * `%` in it as commands and variables.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return null;
  if (platform === 'darwin') return ['open', [parsed.href]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', parsed.href]];
  return ['xdg-open', [parsed.href]];
}

/** Opens a URL in the person's browser, best effort: a failure only means they open it themselves. */
export function openUrl(url: string): void {
  const command = browserCommand(url);
  if (!command) return;
  try {
    spawn(command[0], command[1], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // Nothing: the link is printed anyway.
  }
}

export type RunOptions = {
  /** The program is stopped (SIGTERM, then SIGKILL) after this long. */
  timeoutMs: number;
  /** `inherit` only when the person may have to answer the program in their terminal. */
  stdin?: 'ignore' | 'inherit';
  /** Every chunk of output as it comes (to show an interactive login as it happens). */
  onOutput?: (text: string) => void;
  /** Stops the program once its output matches: what was needed is done, and the rest would wait for a person. */
  stopWhen?: RegExp;
};

export type RunResult = {
  /** Exit code; null when the program was stopped, timed out or could not start. */
  code: number | null;
  /** stdout and stderr, interleaved (at most 64 KB). */
  output: string;
  timedOut: boolean;
  /** Stopped because its output matched `stopWhen`. */
  stopped: boolean;
  /** Why it could not start (ENOENT, EACCES…). */
  error?: string;
};

/** Runs a program with an argument array: never a shell, never a command line built from strings. */
export type Runner = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 64 * 1024;
const KILL_GRACE_MS = 2_000;

export const runProgram: Runner = (file, args, options) =>
  new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { shell: false, windowsHide: true, stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, output: '', timedOut: false, stopped: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, output, timedOut, stopped, ...(error ? { error } : {}) });
    };
    const stop = () => {
      if (killTimer) return;
      child.kill('SIGTERM');
      // A program that ignores SIGTERM, or a grandchild that keeps the pipes open, does not hold the setup.
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(null);
      }, KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (output.length < MAX_OUTPUT) output += text.slice(0, MAX_OUTPUT - output.length);
      options.onOutput?.(text);
      if (options.stopWhen && !stopped && options.stopWhen.test(output)) {
        stopped = true;
        stop();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(stopped || timedOut ? null : code));
  });

/**
 * The absolute path of a program on `PATH`, or null. Relative entries of
 * `PATH` are skipped: a program is never picked up from the current directory.
 */
export async function findExecutable(name: string, env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const directories = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry));
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        if (platform !== 'win32') await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/** A Windows batch file runs only through cmd.exe, that is a shell: such programs are left to the person. */
export function needsShell(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

/**
 * Replaces a file in one step: written next to it, then renamed over it, so a
 * crash never leaves half a file. A symlink is followed (the file it points to
 * is replaced, the link stays) and an existing file keeps its permissions.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  let target = file;
  let mode: number | undefined;
  try {
    target = await realpath(file);
    mode = (await stat(target)).mode & 0o777;
  } catch {
    // A new file.
  }
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
