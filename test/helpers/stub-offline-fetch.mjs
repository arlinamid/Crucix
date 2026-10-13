// Preloaded into a CLI subprocess (node --import): every outbound request that is not to 127.0.0.1 fails at once, as on a
// machine without a network, so `crucix --sweep` finishes in seconds with all sources failed.
const realFetch = globalThis.fetch;
globalThis.fetch = async function offlineFetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  throw new TypeError('fetch failed', { cause: new Error('offline (test stub)') });
};
