import { openAsBlob } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FrameContentType, SkillBundle, VideoContentType } from '@spacecontext/sdk';

const VIDEO_TYPES: Record<string, VideoContentType> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

const FRAME_TYPES: Record<string, FrameContentType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** The API's limits (src/v1/scans/model.ts in the API). */
export const MAX_FRAMES = 120;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** Wrong usage (exit code 2): what is wrong, and optionally what to run instead. */
export class UsageError extends Error {
  constructor(
    message: string,
    /** Next steps, shown as `› …` lines. */
    readonly hints: string[] = [],
    /** Show the command's usage under the message. */
    readonly showUsage = false
  ) {
    super(message);
  }
}

export type ScanSource =
  | { kind: 'video'; file: string; contentType: VideoContentType; size: number }
  | { kind: 'frames'; files: Array<{ file: string; contentType: FrameContentType }> };

/** A video file, or a directory of frames taken in order (sorted by name). */
export async function scanSource(input: string): Promise<ScanSource> {
  let info;
  try {
    info = await stat(input);
  } catch {
    throw new UsageError(`${input}: no such file or directory`);
  }
  if (info.isFile()) {
    const contentType = VIDEO_TYPES[path.extname(input).toLowerCase()];
    if (!contentType) throw new UsageError(`${input}: expected an .mp4, .mov or .m4v video, or a directory of frames`);
    return { kind: 'video', file: input, contentType, size: info.size };
  }
  const names = (await readdir(input)).filter((name) => FRAME_TYPES[path.extname(name).toLowerCase()]);
  names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (names.length === 0) throw new UsageError(`${input}: no .jpg, .png or .webp frames found`);
  if (names.length > MAX_FRAMES) throw new UsageError(`${input}: ${names.length} frames, at most ${MAX_FRAMES} are accepted`);
  return {
    kind: 'frames',
    files: names.map((name) => ({ file: path.join(input, name), contentType: FRAME_TYPES[path.extname(name).toLowerCase()]! })),
  };
}

/** One image, or the images of a directory sorted by name (at most `MAX_FRAMES`). */
export async function frameFiles(input: string): Promise<Array<{ file: string; contentType: FrameContentType }>> {
  let info;
  try {
    info = await stat(input);
  } catch {
    throw new UsageError(`${input}: no such file or directory`);
  }
  if (info.isFile()) {
    const contentType = FRAME_TYPES[path.extname(input).toLowerCase()];
    if (!contentType) throw new UsageError(`${input}: expected a .jpg, .png or .webp image, or a directory of them`);
    return [{ file: input, contentType }];
  }
  const source = await scanSource(input);
  if (source.kind !== 'frames') throw new UsageError(`${input}: expected an image or a directory of images`);
  return source.files;
}

/** A Blob read from disk only while it is uploaded. */
export function fileBlob(file: string): Promise<Blob> {
  return openAsBlob(file);
}

/**
 * Where a file of a Skill bundle goes under `directory`, or an error when its
 * path would leave it. The bundle comes from the network: a path such as
 * `../../.ssh/config` must never be written.
 */
export function skillFilePath(directory: string, relative: string): string {
  if (
    relative.length === 0 ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Refusing to write the skill file "${relative}": not a plain relative path`);
  }
  const resolved = path.resolve(directory, relative);
  const root = path.resolve(directory);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write the skill file "${relative}": outside ${root}`);
  }
  return resolved;
}

/** Writes every file of the bundle under `directory`. Checks all paths before writing any. */
export async function writeSkill(directory: string, bundle: SkillBundle): Promise<string[]> {
  const targets = bundle.files.map((file) => ({ target: skillFilePath(directory, file.path), content: file.content }));
  for (const { target, content } of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return targets.map(({ target }) => target);
}
