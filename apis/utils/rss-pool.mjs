// Shared RSS worker pool. A 15-minute sweep used to start 52 core feeds at once while
// the world runner already had 35 connections open; on Windows a broken IPv6 path then
// burned the whole 8 s abort before undici could fall back to IPv4, so every feed "timed out".

import { Agent } from 'undici';

export const RSS_CONCURRENCY = 8;
export const RSS_TIMEOUT_MS = 12000;

export const rssAgent = new Agent({
  connections: RSS_CONCURRENCY,
  pipelining: 0,
  connect: {
    timeout: 8000,
    family: 4,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
  },
});

export async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { out[index] = { status: 'fulfilled', value: await fn(items[index], index) }; }
      catch (reason) { out[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
  return items.length ? out : [];
}
