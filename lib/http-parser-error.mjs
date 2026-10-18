// Node/undici can throw AssertionError `assert(!this.paused)` from Parser.finish when a
// TLS socket ends after AbortSignal paused the HTTP parser (RSS timeouts). The sweep
// already treated that feed as failed; the process must keep running.

export function isBenignHttpParserClose(error) {
  if (!error || error.name !== 'AssertionError') return false;
  const message = String(error.message || '');
  const stack = String(error.stack || '');
  return message.includes('assert(!this.paused)') && (stack.includes('Parser.finish') || stack.includes('onHttpSocketEnd'));
}

/**
 * For the CLI (one-shot sweep, collector, live country fetch): a benign parser close is logged once and the command goes on;
 * any other uncaught exception still ends the process with exit code 1, as Node's default would. The server keeps its own
 * handler (server.mjs), which logs and continues.
 */
export function guardBenignHttpParserClose(logger = console) {
  let warned = false;
  process.on('uncaughtException', error => {
    if (isBenignHttpParserClose(error)) {
      if (!warned) {
        warned = true;
        logger.warn('[Crucix] Node HTTP parser hit a paused TLS socket (RSS abort). Continuing; this is not a sweep failure.');
      }
      return;
    }
    logger.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}
