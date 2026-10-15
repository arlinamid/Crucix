// write() returns false as soon as more than the 16 KB highWaterMark is buffered, which is every snapshot (hundreds of KB). That only
// means "wait for drain": the bytes are still delivered. Only a client that stays this far behind is dropped.
export const SSE_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

export function writeToClient(client, chunk, maxBuffered = SSE_MAX_BUFFERED_BYTES) {
  if (client.destroyed || client.writableEnded) return false;
  try {
    client.write(chunk);
    if (client.writableLength > maxBuffered) { client.destroy(); return false; }
    return true;
  } catch {
    client.destroy();
    return false;
  }
}

export function broadcastEvent(clients, data, maxBuffered = SSE_MAX_BUFFERED_BYTES) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  // A lean client (GET /events?lean=1, the dashboard) gets an `update` without its snapshot and fetches /api/data (gzipped) itself:
  // the full snapshot is ~4 MB, sent to every open browser on every sweep before.
  let lean = null;
  for (const client of clients) {
    let chunk = message;
    if (client.crucixLean && data?.type === 'update' && data.data) {
      lean ??= `data: ${JSON.stringify({ type: 'update', lean: true, at: data.data?.meta?.timestamp ?? null })}\n\n`;
      chunk = lean;
    }
    if (!writeToClient(client, chunk, maxBuffered)) clients.delete(client);
  }
}
