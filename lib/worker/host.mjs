// The server's side of the worker process (lib/worker/main.mjs): starts it, sends it jobs and returns their results as promises. The heavy
// background work (history import, archive, compaction, backup, themes, a sweep's entity extraction) then runs on another core and the
// server's event loop only waits. When the worker cannot start or keeps failing, `available` is false and the caller runs the job itself.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESTART_MS = [2000, 5000, 15000, 60000];
const DEFAULT_TIMEOUT_MS = 15 * 60000;

let sea = null;
async function isSea() {
  if (sea !== null) return sea;
  try { sea = (await import('node:sea')).isSea?.() === true; } catch { sea = false; }
  return sea;
}

/** The command that starts a worker: the executable itself, or Node with the CLI script. */
export async function workerCommand() {
  if (await isSea()) return [process.execPath, ['__worker']];
  return [process.execPath, [fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url)), '__worker']];
}

export class WorkerHost {
  #child = null;
  #ready = false;
  #pending = new Map(); // id -> { resolve, reject, timer, job }
  #seq = 0;
  #restarts = 0;
  #stopped = false;
  #lastError = null;
  #log;
  #env;

  constructor({ log = console, env = {} } = {}) { this.#log = log; this.#env = env; }

  get available() { return this.#ready && !!this.#child && this.#child.connected; }

  async start() {
    if (this.#stopped) return false;
    let command;
    try { command = await workerCommand(); } catch (error) { this.#lastError = String(error?.message || error); return false; }
    const [file, args] = command;
    let child;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, ...this.#env, CRUCIX_WORKER: '1' }, windowsHide: true });
    } catch (error) {
      this.#lastError = `spawn failed: ${error?.message || error}`;
      this.#log?.warn?.(`[Worker] ${this.#lastError}; background jobs run in the server`);
      return false;
    }
    this.#child = child;
    child.on('message', message => {
      if (message?.ready) { this.#ready = true; this.#restarts = 0; this.#log?.log?.(`[Worker] Ready (pid ${message.pid})`); return; }
      const entry = this.#pending.get(message?.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result); else entry.reject(new Error(message.error || 'worker job failed'));
    });
    child.on('error', error => { this.#lastError = String(error?.message || error); });
    child.on('exit', code => {
      this.#ready = false;
      this.#child = null;
      for (const [id, entry] of this.#pending) { clearTimeout(entry.timer); entry.reject(new Error(`worker exited (${code}) during ${entry.job}`)); this.#pending.delete(id); }
      if (this.#stopped) return;
      const wait = RESTART_MS[Math.min(this.#restarts, RESTART_MS.length - 1)];
      this.#restarts++;
      this.#lastError = `exited with ${code}`;
      this.#log?.warn?.(`[Worker] Exited (${code}); restarting in ${wait / 1000} s`);
      setTimeout(() => this.start(), wait).unref?.();
    });
    // Ready within 15 s, or the jobs run in the server meanwhile.
    return new Promise(resolve => {
      const started = Date.now();
      const check = () => { if (this.#ready) resolve(true); else if (!this.#child || Date.now() - started > 15000) resolve(false); else setTimeout(check, 50); };
      check();
    });
  }

  /** Runs `job` in the worker; rejects when it fails, times out or the worker goes away. */
  call(job, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.available) return Promise.reject(new Error('worker not available'));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`worker job ${job} timed out`)); }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, job });
      try { this.#child.send({ id, job, args }); } catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }

  /** The job in the worker when it is there, else `fallback()` in the server. */
  async run(job, args, fallback, options) {
    if (this.available) {
      try { return await this.call(job, args, options); }
      catch (error) { this.#lastError = String(error?.message || error); if (this.available) throw error; }
    }
    return fallback();
  }

  stop() { this.#stopped = true; try { this.#child?.kill(); } catch { /* gone */ } }

  status() { return { available: this.available, pid: this.#child?.pid ?? null, restarts: this.#restarts, pending: this.#pending.size, lastError: this.#lastError }; }
}
