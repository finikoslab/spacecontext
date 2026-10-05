import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type StoredConfig = { apiKey?: string; baseUrl?: string };

/** `$SPACECONTEXT_CONFIG_DIR`, else `$XDG_CONFIG_HOME/spacecontext`, else `~/.config/spacecontext`. */
export function configDirectory(env: Record<string, string | undefined>): string {
  if (env.SPACECONTEXT_CONFIG_DIR) return env.SPACECONTEXT_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config');
  return path.join(base, 'spacecontext');
}

function configFile(directory: string): string {
  return path.join(directory, 'config.json');
}

export async function readConfig(directory: string): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(configFile(directory), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { apiKey, baseUrl } = parsed as Record<string, unknown>;
    return {
      ...(typeof apiKey === 'string' ? { apiKey } : {}),
      ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
    };
  } catch {
    return {};
  }
}

/** Written readable by the owner only: the file holds an API key. */
export async function writeConfig(directory: string, config: StoredConfig): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = configFile(directory);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created.
  await chmod(file, 0o600);
  return file;
}

export async function clearConfig(directory: string): Promise<void> {
  await rm(configFile(directory), { force: true });
}
