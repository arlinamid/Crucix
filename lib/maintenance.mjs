// The background maintenance of the server: the work that keeps the stored data in shape (saving the entity graph and the threads, the
// history's retention and daily backup, the graph backfill from the history, the past-thread archive) runs here, never in a sweep's
// critical path and never in a request. Serving the dashboard comes first:
//   - one job at a time, from a queue; a job queued again while it waits is not queued twice (its newest function runs);
//   - a job does its work in slices: `ctx.slice()` yields to the event loop (setImmediate) once ~15 ms have passed, so requests are answered
//     in between;
//   - a failing job is logged and recorded in the status; the next job runs anyway.
// In-process on purpose: the single-executable build cannot load a separate worker file reliably, and the stores are the server's
// in-memory objects the routes read.

const SLICE_MS = 15;

export class Maintenance {
  #queue = new Map();   // name -> { run, at }
  #running = null;      // the name of the running job
  #timer = null;
  #log;
  #sliceMs;
  #clock;
  #status = { runs: 0, last: null, lastError: null, jobs: {} };

  constructor({ log = console, sliceMs = SLICE_MS, clock = () => performance.now() } = {}) {
    this.#log = log;
    this.#sliceMs = sliceMs;
    this.#clock = clock;
  }

  /**
   * Queue `run(ctx)` under `name` to start after `delayMs` (0: on the next turn). `ctx.slice()` is the yield point between units of work,
   * `ctx.name` the job's name. Returns false when the same job is already queued (its function is replaced by this one).
   */
  schedule(name, run, { delayMs = 0 } = {}) {
    if (typeof run !== 'function') throw new TypeError('A maintenance job needs a function');
    const queued = this.#queue.has(name);
    this.#queue.set(name, { run, at: Date.now() + Math.max(0, delayMs) });
    this.#wake();
    return !queued;
  }

  #wake() {
    if (this.#running || this.#timer || !this.#queue.size) return;
    const next = Math.min(...[...this.#queue.values()].map(job => job.at));
    this.#timer = setTimeout(() => { this.#timer = null; this.#next(); }, Math.max(0, next - Date.now()));
    this.#timer.unref?.();
  }

  async #next() {
    const now = Date.now();
    const ready = [...this.#queue].filter(([, job]) => job.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
    if (!ready) return this.#wake();
    const [name, job] = ready;
    this.#queue.delete(name);
    this.#running = name;
    const started = this.#clock();
    let sliceStart = started;
    const ctx = {
      name,
      slice: async () => {
        if (this.#clock() - sliceStart < this.#sliceMs) return;
        await new Promise(resolve => setImmediate(resolve));
        sliceStart = this.#clock();
      },
    };
    let error = null;
    try { await job.run(ctx); }
    catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      try { this.#log?.warn?.(`[Maintenance] ${name} failed: ${error}`); } catch { /* logging never stops the queue */ }
    }
    const ms = Math.round(this.#clock() - started);
    const record = { name, at: new Date().toISOString(), ms, ok: !error, ...(error ? { error } : {}) };
    this.#status.runs++;
    this.#status.last = record;
    this.#status.jobs[name] = record;
    if (error) this.#status.lastError = record;
    this.#running = null;
    this.#wake();
  }

  /** Whether a job is waiting or running (tests, shutdown). */
  idle() { return !this.#running && !this.#queue.size; }

  /** Resolves once the queue is empty (tests; a shutdown that wants the last save). */
  async drain({ timeoutMs = 60000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (!this.idle()) {
      if (Date.now() > until) throw new Error('maintenance did not finish in time');
      if (this.#timer && !this.#running) { clearTimeout(this.#timer); this.#timer = null; this.#next(); }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  /** The /api/health row: the running job, the queue, the last run and the last failure, each job's last run. */
  status() {
    return { running: this.#running, queued: [...this.#queue.keys()], runs: this.#status.runs, last: this.#status.last, lastError: this.#status.lastError, jobs: { ...this.#status.jobs } };
  }
}
