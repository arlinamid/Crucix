// The worker process: started by the server (lib/worker/host.mjs) as `crucix __worker` (the executable) or `node scripts/cli.mjs __worker`,
// with an IPC channel. It answers `{id, job, args}` with `{id, ok, result}` or `{id, ok: false, error}`, one job at a time in arrival
// order, and leaves when the server goes (the channel closes). Its console goes to the same daily log file, marked [worker].
import { JOBS } from './jobs.mjs';
import { installFileLog } from '../logger.mjs';

export async function runWorker({ runsDir = null } = {}) {
  if (typeof process.send !== 'function') throw new Error('the worker needs an IPC channel (it is started by the server)');
  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original('[worker]', ...args);
  }
  if (runsDir) installFileLog(runsDir);
  let queue = Promise.resolve();
  process.on('message', message => {
    queue = queue.then(async () => {
      const { id, job, args } = message ?? {};
      try {
        if (!Object.hasOwn(JOBS, job)) throw new Error(`unknown job ${job}`);
        process.send({ id, ok: true, result: await JOBS[job](args ?? {}) });
      } catch (error) {
        try { process.send({ id, ok: false, error: String(error?.message || error).slice(0, 500) }); } catch { /* the server is gone */ }
      }
    });
  });
  process.on('disconnect', () => process.exit(0));
  process.send({ ready: true, pid: process.pid });
  await new Promise(() => {}); // until the server disconnects
}
