// One long-running Crucix (dashboard or --collector) per runs/ profile.
// A second copy would share AIS, daily quotas and the same latest.json.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INSTANCE_LOCK_NAME = 'instance.lock';

export function instanceLockPath(runsDir) {
  return join(runsDir, INSTANCE_LOCK_NAME);
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function acquireInstanceLock(runsDir, { pid = process.pid, now = Date.now() } = {}) {
  if (!runsDir) throw new TypeError('runsDir is required');
  mkdirSync(runsDir, { recursive: true });
  const path = instanceLockPath(runsDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, `${JSON.stringify({ pid, startedAt: new Date(now).toISOString() })}\n`);
      } finally {
        closeSync(fd);
      }
      return { path, pid, created: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let other = null;
      try { other = JSON.parse(readFileSync(path, 'utf8')); } catch { /* replace a corrupt lock */ }
      if (Number(other?.pid) === pid) return { path, pid, created: false };
      if (processIsAlive(Number(other?.pid))) {
        return { error: 'already_running', pid: Number(other.pid), startedAt: other.startedAt || null, path };
      }
      try { unlinkSync(path); } catch { /* another process won the unlink */ }
    }
  }
  return { error: 'already_running', path };
}

export function releaseInstanceLock(runsDir, { pid = process.pid } = {}) {
  const path = instanceLockPath(runsDir);
  if (!existsSync(path)) return false;
  try {
    const other = JSON.parse(readFileSync(path, 'utf8'));
    if (Number(other?.pid) !== pid) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function holdInstanceLock(runsDir, { exit = (code) => process.exit(code), beforeExit = null, log = console } = {}) {
  const lock = acquireInstanceLock(runsDir);
  if (lock.error) return lock;
  const release = () => { try { releaseInstanceLock(runsDir); } catch { /* process is leaving */ } };
  process.on('exit', release);
  // SIGHUP: the console window was closed (Windows gives a few seconds before it ends the process).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      // Said once, so a stop is never silent: which signal ended the server.
      try { log?.log?.(`[Crucix] ${signal} received — saving and shutting down`); } catch { /* leaving */ }
      try { beforeExit?.(); } catch { /* leaving */ }
      release(); exit(0);
    });
  }
  return lock;
}

export function alreadyRunningMessage(lock, { port, lang = 'en' } = {}) {
  const pid = lock?.pid ? ` (pid ${lock.pid})` : '';
  const where = port ? ` http://localhost:${port}` : '';
  if (lang === 'hu') {
    return `[Crucix] FATAL: már fut egy példány${pid}.${where ? ` Dashboard:${where}` : ''} Állítsd le azt, mielőtt újat indítasz.`;
  }
  return `[Crucix] FATAL: already running${pid}.${where ? ` Dashboard:${where}` : ''} Stop that instance before starting another.`;
}
