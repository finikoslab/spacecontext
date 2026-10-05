#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { main } from './cli.js';

/** Reads a line without echoing it: an API key must not stay on screen or in the scrollback. */
async function prompt(question: string): Promise<string> {
  process.stderr.write(question);
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const readline = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    return await readline.question('');
  } finally {
    readline.close();
    process.stderr.write('\n');
  }
}

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  prompt: process.stdin.isTTY ? prompt : null,
});
process.exitCode = code;
