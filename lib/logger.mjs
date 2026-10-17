// The server's log on disk: what it writes to the console also goes to <runsDir>/logs/crucix-YYYY-MM-DD.log (UTC day), so the sweep
// timings, the maintenance lines and the errors outlive the terminal. Bounded: at most MAX_BYTES_PER_DAY a day (a line says when the cap
// cut the rest), KEEP_DAYS days kept. Writes are appended through a stream (buffered, off the request path). The last warnings and errors
// are kept in memory for /api/health.
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

const KEEP_DAYS = 14;
const MAX_BYTES_PER_DAY = 20 * 1024 * 1024;
const RECENT = 20;
const FILE = /^crucix-(\d{4}-\d{2}-\d{2})\.log$/;
// Colour codes of a terminal line have no place in a file.
const ANSI = /\u001b\[[0-9;]*m/g;

export function installFileLog(runsDir, { keepDays = KEEP_DAYS, maxBytesPerDay = MAX_BYTES_PER_DAY, now = Date.now, target = console } = {}) {
  const dir = join(runsDir, 'logs');
  try { mkdirSync(dir, { recursive: true }); } catch { return null; }
  const recent = [];
  let day = null, stream = null, bytes = 0, capped = false;
  const prune = () => {
    const oldest = new Date(now() - (keepDays - 1) * 86400000).toISOString().slice(0, 10);
    try { for (const name of readdirSync(dir)) { const m = name.match(FILE); if (m && m[1] < oldest) { try { unlinkSync(join(dir, name)); } catch { /* in use or gone */ } } } } catch { /* no listing */ }
  };
  const open = today => {
    try { stream?.end(); } catch { /* closing an old day */ }
    day = today; capped = false;
    const path = join(dir, `crucix-${today}.log`);
    try { bytes = statSync(path).size; } catch { bytes = 0; }
    stream = createWriteStream(path, { flags: 'a' });
    stream.on('error', () => { stream = null; });
    prune();
  };
  // The sweep's progress goes to stderr (apis/briefing.mjs: the CLI's stdout is JSON); it is not an error.
  const PROGRESS = /^\[Crucix\] (?:Starting intelligence sweep|Sweep complete in)/;
  const write = (level, args) => {
    const at = new Date(now());
    const text = format(...args).replace(ANSI, '');
    if (level === 'error' && PROGRESS.test(text)) level = 'info';
    if (level !== 'info') { recent.push({ at: at.toISOString(), level, text: text.slice(0, 500) }); if (recent.length > RECENT) recent.shift(); }
    const today = at.toISOString().slice(0, 10);
    if (today !== day) open(today);
    if (!stream || capped) return;
    const line = `${at.toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > maxBytesPerDay) { capped = true; stream.write(`${at.toISOString()} WARN  [log] ${maxBytesPerDay} bytes reached for ${today}; the rest of the day is not written\n`); return; }
    stream.write(line);
  };
  const originals = {};
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    originals[method] = target[method];
    target[method] = function logged(...args) {
      originals[method].apply(target, args);
      try { write(level, args); } catch { /* the file log never breaks the console */ }
    };
  }
  return {
    dir,
    recent: () => recent.slice(),
    close() { for (const [method, fn] of Object.entries(originals)) target[method] = fn; try { stream?.end(); } catch { /* closing */ } },
  };
}

/** Per-step statistics of the sweeps of the last 24 hours: { count, last, p50, p95 } with a value per step name, in ms. */
export class SweepTimings {
  #runs = [];
  constructor({ windowMs = 24 * 3600000, now = Date.now } = {}) { this.windowMs = windowMs; this.now = now; }
  add(steps) {
    const at = this.now();
    this.#runs.push({ at, steps: { ...steps } });
    while (this.#runs.length && this.#runs[0].at < at - this.windowMs) this.#runs.shift();
  }
  summary() {
    const runs = this.#runs;
    if (!runs.length) return { count: 0, last: null, p50: null, p95: null };
    const names = [...new Set(runs.flatMap(run => Object.keys(run.steps)))];
    const pick = q => Object.fromEntries(names.map(name => {
      const values = runs.map(run => run.steps[name]).filter(Number.isFinite).sort((a, b) => a - b);
      return [name, values.length ? values[Math.min(values.length - 1, Math.floor(q * values.length))] : null];
    }));
    return { count: runs.length, last: { at: new Date(runs.at(-1).at).toISOString(), ...runs.at(-1).steps }, p50: pick(0.5), p95: pick(0.95) };
  }
}
