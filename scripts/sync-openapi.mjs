// Refreshes openapi/openapi.json from the backend, the single source of truth.
//
//   node scripts/sync-openapi.mjs                      (backend checked out at ../spacecontext-backend)
//   node scripts/sync-openapi.mjs --backend <path>
//   node scripts/sync-openapi.mjs --url https://api.spacecontext.finikos.it/v1/openapi.json
//
// Then regenerate the SDK types: npm run generate -w @spacecontext/sdk
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'openapi', 'openapi.json');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};

const url = option('--url');
if (url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const document = await response.json();
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
  console.error(`openapi/openapi.json updated from ${url}`);
} else {
  const backend = path.resolve(option('--backend') ?? path.join(root, '..', 'spacecontext-backend'));
  execFileSync('node', ['scripts/export-openapi.mjs', target], { cwd: backend, stdio: 'inherit' });
}
