#!/usr/bin/env node
// Fetches an ACLED OAuth token with curl and saves ACLED_ACCESS_TOKEN / ACLED_REFRESH_TOKEN into the .env that holds ACLED_EMAIL.
// Why curl: acleddata.com/oauth/token answers Node's fetch with a Cloudflare challenge (HTTP 403) but lets curl through.
// The access token lives ~24h, the refresh token ~14d; run `node scripts/acled-token.mjs` again (it refreshes first, and falls back to the password).
// Without credentials in .env (or with --prompt) it asks for the myACLED e-mail and password; the password is typed hidden.
// ACLED has no browser/authorization-code OAuth flow (only the password grant), so a browser cannot hand over a token; `--open` just opens the login page.
// Secrets go to curl over stdin (never argv) and are never printed.
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import '../apis/utils/env.mjs';
import { getEnvSearchPaths } from '../apis/utils/env.mjs';

const TOKEN_URL = 'https://acleddata.com/oauth/token';

const curlConfigValue = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function requestToken(fields) {
  const config = [`url = ${curlConfigValue(TOKEN_URL)}`, 'request = "POST"', 'silent', 'max-time = 30',
    'header = "Accept: application/json"', ...Object.entries(fields).map(([k, v]) => `data-urlencode = ${curlConfigValue(`${k}=${v}`)}`)].join('\n');
  const res = spawnSync('curl', ['-K', '-', '-w', '\n%{http_code}'], { input: config, encoding: 'utf8' });
  if (res.error) throw new Error(`curl could not run: ${res.error.message}`);
  const out = res.stdout || '';
  const cut = out.lastIndexOf('\n');
  const status = Number(out.slice(cut + 1));
  let body = null;
  try { body = JSON.parse(out.slice(0, cut)); } catch { /* not JSON, e.g. a Cloudflare page */ }
  return { status, body };
}

function saveToEnv(values) {
  const file = getEnvSearchPaths().find(p => existsSync(p) && /^\s*(?:export\s+)?ACLED_EMAIL\s*=/m.test(readFileSync(p, 'utf8')));
  if (!file) throw new Error('No .env with ACLED_EMAIL found; set ACLED_EMAIL and ACLED_PASSWORD first.');
  let text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\s*$/, '')}${eol}${line}${eol}`;
  }
  writeFileSync(file, text);
  return file;
}

const args = new Set(process.argv.slice(2));
if (args.has('--open')) {
  const url = 'https://acleddata.com/user/login';
  spawnSync(process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { stdio: 'ignore' });
  console.log(`Opened ${url}. Check that you can sign in there, then run this script again.`);
  process.exit(0);
}

const ask = async (question, { hidden = false } = {}) => {
  if (!hidden) { const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(question); rl.close(); return a.trim(); }
  return new Promise(done => {
    process.stdout.write(question);
    let value = '';
    process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onData = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode?.(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return done(value); }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1); else value += c;
      }
    };
    process.stdin.on('data', onData);
  });
};

let email = process.env.ACLED_EMAIL?.trim();
let password = process.env.ACLED_PASSWORD;
const refresh = args.has('--prompt') ? '' : process.env.ACLED_REFRESH_TOKEN?.trim();
const interactive = Boolean(process.stdin.isTTY);
let prompted = false;

let result = null;
if (refresh) {
  result = requestToken({ grant_type: 'refresh_token', refresh_token: refresh, client_id: 'acled' });
  if (result.status === 200 && result.body?.access_token) console.log('Refreshed with the refresh token.');
  else console.log(`Refresh failed (HTTP ${result.status}${result.body?.error ? `, ${result.body.error}` : ''}); trying the password.`);
}

for (let attempt = 1; !result?.body?.access_token; attempt++) {
  if (args.has('--prompt') && attempt === 1 || !email || !password || attempt > 1) {
    if (!interactive) { console.error('No usable ACLED_EMAIL / ACLED_PASSWORD in .env and no terminal to ask in.'); process.exit(1); }
    email = await ask(`myACLED e-mail${email ? ` [${email}]` : ''}: `) || email;
    password = await ask('myACLED password (hidden): ', { hidden: true });
    prompted = true;
  }
  result = requestToken({ grant_type: 'password', client_id: 'acled', scope: 'authenticated', username: email, password });
  const { status, body } = result;
  if (status === 200 && body?.access_token) break;
  if (body?.error === 'invalid_grant') console.error('ACLED rejected the e-mail/password (invalid_grant). Check that you can sign in at https://acleddata.com/user/login (node scripts/acled-token.mjs --open).');
  else if (!body) console.error(`Unexpected answer (HTTP ${status}); probably a Cloudflare challenge. Try again later or from another network.`);
  else console.error(`ACLED answered HTTP ${status}: ${body.error || 'error'} ${body.error_description || ''}`.trim());
  if (body?.error !== 'invalid_grant' || !interactive || attempt >= 3) process.exit(1);
  result = null;
}

const { body } = result;
const values = { ACLED_ACCESS_TOKEN: body.access_token, ...(body.refresh_token ? { ACLED_REFRESH_TOKEN: body.refresh_token } : {}) };
if (prompted && interactive) {
  const keep = (await ask('Also save the e-mail and password in .env so Crucix can sign in on its own? [y/N] ')).toLowerCase();
  if (keep === 'y' || keep === 'yes') Object.assign(values, { ACLED_EMAIL: email, ACLED_PASSWORD: password });
}
const file = saveToEnv(values);
const hours = body.expires_in ? Math.round(body.expires_in / 3600) : '?';
console.log(`OK: token saved to ${file} (access token valid ~${hours}h${body.refresh_token ? ', refresh token saved' : ''}).`);
