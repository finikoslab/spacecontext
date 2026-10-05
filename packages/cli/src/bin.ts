#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main } from './cli.js';

async function prompt(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
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
