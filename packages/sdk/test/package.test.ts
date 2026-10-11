import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// What npm publishes: the package must load with require() as well as import
// (Node 22.12+ requires ES modules through the "default" condition, so that is
// the Node it asks for), be built when it is packed, and carry its own licence
// (npm does not take the repository's).

describe('the published package', () => {
  it('resolves for require() and import, is built when packed, and ships its licence', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
      files: string[];
      engines: { node: string };
      scripts: Record<string, string>;
    };
    expect(manifest.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' });
    expect(manifest.engines.node).toBe('>=22.12.0');
    expect(manifest.scripts.prepack).toBe('npm run build');
    expect(manifest.files).toContain('LICENSE');
    expect(await readFile(new URL('../LICENSE', import.meta.url), 'utf8')).toBe(await readFile(new URL('../../../LICENSE', import.meta.url), 'utf8'));
  });
});
