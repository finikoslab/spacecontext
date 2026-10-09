// Ships the Space Context skill with the CLI: `spacecontext setup` installs this
// copy when spacecontext.app cannot be reached. The source of truth is the
// Claude Code plugin's skill; the copy is made at every build so the two never
// differ (test/setup.test.ts checks it).
import { copyFile, mkdir } from 'node:fs/promises';

const source = new URL('../../../plugins/spacecontext/skills/spacecontext/SKILL.md', import.meta.url);
const target = new URL('../skill/SKILL.md', import.meta.url);
await mkdir(new URL('.', target), { recursive: true });
await copyFile(source, target);
