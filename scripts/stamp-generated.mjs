// Prepends a "do not edit" banner to a generated file.
import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2];
const banner = '// Generated from openapi/openapi.json by openapi-typescript. Do not edit: run `npm run generate`.\n';
const content = await readFile(file, 'utf8');
if (!content.startsWith(banner)) await writeFile(file, banner + content);
