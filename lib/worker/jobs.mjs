// The jobs of the worker process (lib/worker/main.mjs): the heavy work that only needs the files of the runs folder, so it can run beside
// the server on another core instead of on the server's event loop. Each job takes plain JSON arguments and returns plain JSON.
// The server (lib/worker/host.mjs) falls back to running the same functions in-process when no worker is available.
import { HistoryStore } from '../intelligence/history.mjs';
import { ThreadArchive } from '../intelligence/thread-archive.mjs';
import { importSweepArchives, importStatePath, sweepArchiveDirs } from '../intelligence/history-import.mjs';
import { themeAnalysis } from '../intelligence/themes.mjs';
import { graphRecordsOf } from '../intelligence/linkers.mjs';
import { createDictionaries } from '../intelligence/extract.mjs';
import { AirWatch, airWatchRound } from '../air/watch.mjs';

const stores = new Map();
// The air watch keeps its aircraft tracks between rounds: one per worker process.
let airWatch = null;
const historyOf = runsDir => { if (!stores.has(runsDir)) stores.set(runsDir, new HistoryStore(runsDir)); return stores.get(runsDir); };

export const JOBS = Object.freeze({
  ping: async () => ({ pid: process.pid, at: new Date().toISOString() }),
  // Entity extraction for a sweep's events the graph has not seen (~0.6 ms an event); `actors`: the MISP galaxy table of the sweep.
  extract: async ({ events, actors = null }) => graphRecordsOf(Array.isArray(events) ? events : [], createDictionaries({ actors })),
  'history-import': async ({ runsDir }) => {
    const result = await importSweepArchives(historyOf(runsDir), sweepArchiveDirs(runsDir), { statePath: importStatePath(runsDir), log: console });
    return { ...result, days: [...result.days] };
  },
  'history-backup': async ({ runsDir }) => historyOf(runsDir).backup(),
  'history-prune': async ({ runsDir }) => {
    const history = historyOf(runsDir);
    const removed = history.prune();
    if (typeof history.trim === 'function') history.trim(2000);
    return removed;
  },
  'history-compact': async ({ runsDir }) => {
    const history = historyOf(runsDir);
    if (typeof history.compact !== 'function') return { rewritten: 0 };
    // The URL keys of the format before 2.52.1 first (history.mjs migrateUrlKeys), in batches.
    let urlKeys = 0, keys;
    while ((keys = history.migrateUrlKeys({ limit: 2000 })) > 0) urlKeys += keys;
    let rewritten = 0, count;
    while ((count = history.compact({ limit: 500 })) > 0) rewritten += count;
    let vacuumMs = null;
    if (rewritten) { const started = Date.now(); history.vacuum(); vacuumMs = Date.now() - started; }
    return { rewritten, vacuumMs, urlKeys };
  },
  'thread-archive': async ({ runsDir, actors = null }) => {
    const history = historyOf(runsDir), archive = new ThreadArchive(runsDir);
    const dictionaries = createDictionaries({ actors }), cache = new Map(), days = [];
    for (const day of archive.pendingDays(history)) days.push([day, await archive.computeDay(day, history, { dictionaries, cache })]);
    archive.prune();
    return days;
  },
  themes: async ({ runsDir, days = 7, kinds = null }) => themeAnalysis(historyOf(runsDir), { days, kinds }),
  // One air-watch round (mostly waiting on the network): runs beside the queued jobs, not after them (main.mjs CONCURRENT).
  'air-watch': async () => airWatchRound(airWatch ??= new AirWatch()),
});
/** Jobs that run as soon as they arrive, beside the queue: a long import must not hold up an air-watch round. */
export const CONCURRENT = Object.freeze(new Set(['air-watch', 'ping']));
