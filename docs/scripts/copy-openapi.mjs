// Copies the API contract next to the site, where the Scalar reference reads it.
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../../openapi/openapi.json', import.meta.url));
const to = fileURLToPath(new URL('../static/openapi.json', import.meta.url));
await copyFile(from, to);
