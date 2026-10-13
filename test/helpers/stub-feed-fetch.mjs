// Preloaded into a CLI subprocess (node --import): answers every outbound http(s) request that is not to 127.0.0.1 with a small
// RSS document, and every third distinct URL with a 500, so the e2e tests run offline and see a feed that fails.
const realFetch = globalThis.fetch;
const seen = new Map();

globalThis.fetch = async function stubFetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (!seen.has(url.href)) seen.set(url.href, seen.size);
  if (seen.get(url.href) % 3 === 2) return new Response('upstream down', { status: 500 });
  const hours = seen.get(url.href) + 1;
  const items = [0, 1].map(n => {
    const date = new Date(Date.now() - (hours + n) * 3600_000).toUTCString();
    return `<item><title>Stub headline ${url.hostname} ${n}</title><link>${url.origin}/story-${n}</link><pubDate>${date}</pubDate></item>`;
  }).join('');
  return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Stub</title>${items}</channel></rss>`, {
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
  });
};
