/** One Server-Sent Event, as the API sends them: `event`, `id` and the joined `data` lines. */
export type ServerSentEvent = { event: string; id: string | null; data: string };

/**
 * The most an event (with the line being read) may hold, in characters: a
 * stream that never ends a line or an event is not read without bound. Past
 * it the reading fails, which the caller takes as a dropped connection.
 */
const MAX_EVENT_CHARS = 1024 * 1024;

/**
 * Reads a `text/event-stream` body event by event, as it arrives. Follows the
 * SSE format: lines end with CRLF, LF or CR; events end with a blank line;
 * comment lines (`:`) are ignored; several `data:` lines are joined with
 * newlines. An event the stream ends in the middle of is dropped, as the format
 * says: a connection cut mid-event never yields half an event.
 *
 * `signal` ends the reading at once, even when nothing arrives (a stream that
 * only sends pings, a body that ignores the request's abort): the events read so
 * far are kept, an unfinished one is dropped.
 */
export async function* parseServerSentEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  // Cancelling the reader settles a pending read as done.
  const stop = () => void reader.cancel(signal?.reason).catch(() => undefined);
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';
  let pending = emptyEvent();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let start = 0;
      for (let end = lineEnd(buffer, start); end; end = lineEnd(buffer, start)) {
        const line = buffer.slice(start, end.index);
        start = end.index + end.length;
        if (line !== '') {
          addLine(pending, line);
          continue;
        }
        const event = pending.seen ? { event: pending.event, id: pending.id, data: pending.data.join('\n') } : null;
        pending = emptyEvent();
        if (event) yield event;
      }
      buffer = buffer.slice(start);
      if (buffer.length + pending.size > MAX_EVENT_CHARS) throw new Error('An event of the stream is too large');
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    await reader.cancel().catch(() => undefined);
  }
}

type PendingEvent = { event: string; id: string | null; data: string[]; seen: boolean; size: number };

function emptyEvent(): PendingEvent {
  return { event: 'message', id: null, data: [], seen: false, size: 0 };
}

/**
 * Where the first line from `from` ends (CRLF, LF or CR), or null when it has
 * not ended yet. A CR at the very end waits for the next chunk: it may be the
 * first half of a CRLF.
 */
function lineEnd(text: string, from: number): { index: number; length: number } | null {
  for (let index = from; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10) return { index, length: 1 };
    if (code === 13) {
      if (index + 1 === text.length) return null;
      return { index, length: text.charCodeAt(index + 1) === 10 ? 2 : 1 };
    }
  }
  return null;
}

function addLine(event: PendingEvent, line: string): void {
  if (line.startsWith(':')) return;
  event.seen = true;
  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? '' : line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  if (field === 'event') event.event = value;
  else if (field === 'id') event.id = value;
  else if (field === 'data') {
    event.data.push(value);
    event.size += value.length + 1;
  }
}
