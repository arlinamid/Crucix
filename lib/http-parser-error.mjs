// Node/undici can throw AssertionError `assert(!this.paused)` from Parser.finish when a
// TLS socket ends after AbortSignal paused the HTTP parser (RSS timeouts). The sweep
// already treated that feed as failed; the process must keep running.

export function isBenignHttpParserClose(error) {
  if (!error || error.name !== 'AssertionError') return false;
  const message = String(error.message || '');
  const stack = String(error.stack || '');
  return message.includes('assert(!this.paused)') && (stack.includes('Parser.finish') || stack.includes('onHttpSocketEnd'));
}
