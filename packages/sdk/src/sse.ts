/** One Server-Sent Event, as the API sends them: `event`, `id` and the joined `data` lines. */
export type ServerSentEvent = { event: string; id: string | null; data: string };

/**
 * Reads a `text/event-stream` body event by event, as it arrives. Follows the
 * SSE format: fields separated by newlines, events by a blank line, comment
 * lines (`:`) ignored, several `data:` lines joined with newlines.
 */
export async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseBlock(block);
        if (event) yield event;
        boundary = findBoundary(buffer);
      }
    }
    const last = parseBlock(buffer);
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The first blank line (`\n\n` or `\r\n\r\n`), whichever comes first. */
function findBoundary(text: string): { index: number; length: number } | null {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseBlock(block: string): ServerSentEvent | null {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];
  let seen = false;
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue;
    seen = true;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  return seen ? { event, id, data: data.join('\n') } : null;
}
