#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { main } from './cli.js';

/** Reads a line without echoing it: an API key must not stay on screen or in the scrollback. */
async function prompt(question: string): Promise<string> {
  process.stderr.write(question);
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const readline = createInterface({ input: process.stdin, output: muted, terminal: true });
  // Ctrl+C at the prompt: the terminal is in raw mode, so it arrives here, not as a signal.
  readline.on('SIGINT', () => {
    readline.close();
    process.stderr.write('\n');
    process.exit(130);
  });
  try {
    return await readline.question('');
  } finally {
    readline.close();
    process.stderr.write('\n');
  }
}

/**
 * What a command wants said or cleaned up when it is stopped (a scan that goes
 * on without the terminal, a compressed copy of a video): on Ctrl+C, and when
 * the terminal is closed (SIGHUP) or the process is killed (SIGTERM).
 */
const interruptHandlers: Array<() => void> = [];
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const;
for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    // A spinner's line is cleared before anything else is said.
    if (process.stderr.isTTY) process.stderr.write('\r\u001b[2K');
    for (const handler of [...interruptHandlers].reverse()) {
      try {
        handler();
      } catch {
        // Exiting anyway.
      }
    }
    process.exit(exitCode);
  });
}

// Piped into `head` and the like: the reader leaving early is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  });
}

const columns = process.stdout.columns || process.stderr.columns;
const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  prompt: process.stdin.isTTY ? prompt : null,
  terminal: { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) },
  ...(columns ? { columns } : {}),
  onInterrupt: (handler) => {
    interruptHandlers.push(handler);
    return () => {
      const index = interruptHandlers.indexOf(handler);
      if (index !== -1) interruptHandlers.splice(index, 1);
    };
  },
});
process.exitCode = code;
