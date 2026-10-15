// The events of the archived sweeps (runs/sweeps and the sweeps folder of a runs-backup-* copy beside it) imported into the event history,
// for the background maintenance. Before 2.46 the history kept only its newest 10,000 records, so the days before the SQLite store hold a
// fraction of what the sweeps saw; every sweep archive stores its events whole, with the time they were collected. The import merges them
// as they were seen then (HistoryStore.importRecords: the earlier first sighting wins, the newest content stays), a few hundred at a time
// with a yield between, and remembers each file it finished (runs/intelligence/history-import.json), so it never reads a file twice.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { basename, dirname, join } from 'node:path';
import { writeJsonAtomic } from '../atomic-json.mjs';

const unzip = promisify(gunzip);
const CHUNK = 100; // one importRecords call stays around 100 ms on the main thread
const SWEEP_FILE = /^sweep-\d{8}T\d{6}Z\.json(?:\.gz)?$/;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const noYield = async () => {};

/** The sweep archive folders of a profile: its own runs/sweeps and the sweeps of every runs-backup-* copy beside the runs folder. */
export function sweepArchiveDirs(runsDir) {
  const dirs = [join(runsDir, 'sweeps')];
  try {
    const parent = dirname(runsDir);
    for (const name of readdirSync(parent)) if (/^runs-backup-/.test(name)) dirs.push(join(parent, name, 'sweeps'));
  } catch { /* no parent listing: the own archive only */ }
  return dirs.filter(dir => { try { return statSync(dir).isDirectory(); } catch { return false; } });
}

function readState(path) {
  try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value.files === 'object' ? value : { files: {} }; } catch { return { files: {} }; }
}

/**
 * Imports the events of every sweep file of `dirs` not imported before (a file is known by its folder, name and size). Returns
 * `{ files, events, added, days }`: the files read, the events offered, the records the history did not have, the UTC days
 * (YYYY-MM-DD) of the records' collection times.
 */
export async function importSweepArchives(history, dirs, { statePath, slice = noYield, log = null } = {}) {
  const state = statePath ? readState(statePath) : { files: {} };
  const out = { files: 0, events: 0, added: 0, days: new Set() };
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir).filter(name => SWEEP_FILE.test(name)).sort(); } catch { continue; }
    for (const name of names) {
      const path = join(dir, name);
      let size;
      try { size = statSync(path).size; } catch { continue; }
      const key = `${basename(dirname(dir))}/${basename(dir)}/${name}`;
      if (state.files[key] === size || size > MAX_FILE_BYTES) continue;
      let events = [];
      try {
        const raw = await readFile(path);
        const text = (name.endsWith('.gz') ? await unzip(raw) : raw).toString('utf8');
        const snapshot = JSON.parse(text);
        events = Array.isArray(snapshot?.events) ? snapshot.events : Array.isArray(snapshot?.snapshot?.events) ? snapshot.snapshot.events : [];
      } catch (error) {
        try { log?.warn?.(`[History import] ${key} skipped (${error?.message || error})`); } catch { /* logging never stops the import */ }
      }
      await slice();
      for (let i = 0; i < events.length; i += CHUNK) {
        const chunk = events.slice(i, i + CHUNK);
        const result = history.importRecords(chunk);
        out.added += result.added;
        for (const event of chunk) { const day = typeof event?.collectedAt === 'string' ? event.collectedAt.slice(0, 10) : null; if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) out.days.add(day); }
        await slice();
      }
      out.files++; out.events += events.length;
      state.files[key] = size;
      if (statePath && out.files % 10 === 0) { try { writeJsonAtomic(statePath, state); } catch { /* the next run reads those files again: harmless */ } }
    }
  }
  if (statePath && out.files) { try { writeJsonAtomic(statePath, state); } catch { /* harmless, see above */ } }
  return out;
}

/** The state file of the import in a runs folder. */
export const importStatePath = runsDir => join(runsDir, 'intelligence', 'history-import.json');
export const hasSweepArchives = runsDir => sweepArchiveDirs(runsDir).some(dir => existsSync(dir));
