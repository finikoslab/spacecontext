import type { UploadBody, UploadStream } from './client.js';
import { SpaceContextError } from '../errors.js';

/** Upload bodies: their length, a size as people read it, and a file on disk as a body. */

export function isUploadStream(body: UploadBody): body is UploadStream {
  return !(body instanceof Blob) && !('byteLength' in body);
}

export function byteLength(body: UploadBody): number {
  return 'byteLength' in body ? body.byteLength : body.size;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** `150.0 MB`, `4.2 GB`, `12 KB`; a limit (`whole`) without a needless decimal: `100 MB`, `4 GB`. */
export function formatSize(bytes: number, whole = false): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const [value, unit] = bytes >= GB ? [bytes / GB, 'GB'] : [bytes / MB, 'MB'];
  return `${whole && Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`;
}

/** The slice of Node's file system the SDK uses; typed here so that it builds without Node's types. */
export type NodeFs = {
  promises: {
    stat(target: string): Promise<{ size: number; isDirectory(): boolean }>;
    readdir(target: string): Promise<string[]>;
    open(target: string, flags: string): Promise<NodeFileHandle>;
  };
  openAsBlob(target: string): Promise<Blob>;
};
type NodeFileHandle = {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

/** Node's `fs`, or null outside Node. Loaded only when asked, by name, so that bundlers for browsers leave it alone. */
export async function nodeFs(): Promise<NodeFs | null> {
  const name = 'node:fs';
  try {
    return (await import(name)) as NodeFs;
  } catch {
    return null;
  }
}

/** What a stream reads from the file at a time. */
const CHUNK_BYTES = 1024 * 1024;

/** Thrown by a file stream: the file, not the network, failed (never worth sending again as it is). */
export class FileReadError extends Error {
  override readonly name = 'FileReadError';
}

/**
 * The first `size` bytes of a file as a stream, a new one for each attempt,
 * read a megabyte at a time. The file is opened and closed again for every
 * read, so no handle is left open whatever the server does with the body (an
 * answer before it is all sent, a retry, a stream never cancelled). Nothing is
 * read ahead of the upload. A file that shrinks while it is sent fails the
 * upload instead of sending less than the length announced.
 */
function fileStream(fs: NodeFs, path: string, size: number): UploadStream {
  return {
    size,
    stream: () => {
      let position = 0;
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const length = Math.min(CHUNK_BYTES, size - position);
            if (length === 0) {
              controller.close();
              return;
            }
            const buffer = new Uint8Array(length);
            let bytesRead: number;
            try {
              const handle = await fs.promises.open(path, 'r');
              try {
                ({ bytesRead } = await handle.read(buffer, 0, length, position));
              } finally {
                await handle.close();
              }
            } catch (error) {
              throw new FileReadError(`${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (bytesRead === 0) throw new FileReadError(`${path} got shorter while it was being uploaded`);
            position += bytesRead;
            controller.enqueue(bytesRead === length ? buffer : buffer.subarray(0, bytesRead));
          },
        },
        { highWaterMark: 0 }
      );
    },
  };
}

/**
 * A file on disk as an upload body, read from disk while it is sent and never
 * held in memory (Node.js only): a `Blob` from `fs.openAsBlob`, or, for a file
 * of 4 GiB or more, a stream with the file's exact length, because
 * `fs.openAsBlob` counts sizes modulo 4 GiB (a 4 GiB file would be sent as
 * empty, a 5 GiB one as its first gigabyte).
 */
export async function fileBody(path: string): Promise<Blob | UploadStream> {
  const fs = await nodeFs();
  if (!fs) throw new SpaceContextError('A file can only be read from disk in Node.js: pass a Blob or bytes', 0, 'VALIDATION_ERROR', null);
  const { size } = await fs.promises.stat(path);
  const blob = await fs.openAsBlob(path);
  return blob.size === size ? blob : fileStream(fs, path, size);
}
