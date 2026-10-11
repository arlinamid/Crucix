# Troubleshooting

Common start-up and data problems. Day-to-day operation is in the [operations guide](OPERATIONS.md).

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

## Troubleshooting

### `npm run dev` exits silently (no output, no error)

This is a known issue where npm's script runner can swallow errors, particularly on Windows PowerShell. Try these in order:

**1. Run Node directly (bypasses npm):**
```bash
node --trace-warnings server.mjs
```
This is functionally identical to `npm run dev` but gives you full error output.

**2. Run the diagnostic script:**
```bash
node diag.mjs
```
This tests every import one by one, checks your Node.js version, and verifies port 3117 is available. It will tell you exactly what's failing.

**3. Check if port 3117 is already in use:**

A previous Crucix instance may still be running in the background.

```powershell
# Windows PowerShell
Get-NetTCPConnection -LocalPort 3117
Get-Process -Id <OwningProcess_from_above>
```

```bash
# macOS / Linux
lsof -i :3117
```

Identify the process before taking action. Reuse an existing Crucix instance or choose `PORT=3118`; avoid stopping unrelated applications. See [the operations guide](OPERATIONS.md). A second dashboard or `--collector` on the same profile now exits with `already running` instead of starting another sweep.

The standalone exe (no Node) is installed with `irm https://github.com/arlinamid/Crucix/releases/latest/download/install.ps1 | iex` on Windows, or `curl -fsSL https://github.com/arlinamid/Crucix/releases/latest/download/install.sh | sh` on Linux/macOS. `npx crucix` is a different install (Node + source). Check `crucix --version` and which path PATH hits.

**4. Check Node.js version:**
```bash
node --version
```
Crucix requires Node.js 22 or later. If you have an older version, download the latest LTS from [nodejs.org](https://nodejs.org/).

### RSS: every feed times out at 8 s and WorldRSS finishes 0/539

That pattern is a connection pile-up, not fifty dead publishers. The core list used to open all ~52 feeds at once while the world runner already had 35 connections; on Windows a broken IPv6 path then burned the abort timer before IPv4 was tried. Crucix now uses 8 IPv4-first workers, 12 s per feed, a 20 s budget for the dashboard list, and keeps the last good headlines when a sweep returns nothing. The 539-feed runner starts 45 s after boot so it does not collide with the first synthesize.

### Dashboard shows empty panels after first start

This is normal — the first sweep takes 30–60 seconds to query all 73 sources. The dashboard will populate automatically once the sweep completes. Check the terminal for sweep progress logs.

### Some sources show errors

Missing keys disable the corresponding source; provider failures have a separate error state. Other sources continue. Check Source Integrity or sanitized server logs for the affected source and reason. Optional keys include `FRED_API_KEY`, `FIRMS_MAP_KEY` and `EIA_API_KEY`.

OpenSky queries the hotspots at most every 120 minutes anonymously (400 credits/day) or every 15 minutes with the optional `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` OAuth2 client (4,000 credits/day). `HTTP 429` is not retried: the pause and the last good round are stored in the profile cache so a restart does not spend another 28 credits. Meanwhile the last good result is shown as stale (or the credit-limit error if there is none). Successful current regions are preserved, and Crucix can reuse an original observation from `runs/` for at most one hour when all regions fail; that one-hour limit applies to the `runs/` fallback only, not to the in-process stale result, which can be as old as the round interval or, during a 429 pause, at most three hours. Expired, missing or invalid timestamps are rejected; stale data stays visibly labelled.

BLS v1 allows about 25 queries a day; a 15-minute sweep would burn that before noon. Crucix caches a successful BLS briefing for 12 hours (labor series update monthly). Set `BLS_API_KEY` for v2 (500/day). A daily-threshold error with an empty registration key is the v1 cap.

ACLED OAuth needs `scope=authenticated`. Cloudflare may still challenge scripted logins (HTTP 403 HTML); the last good briefing is kept for 6 hours. Complete the myACLED profile, accept the terms, and confirm the account has API access.

EPA RadNet is blocked by EPA's own WAF (HTTP 403) on `enviro.epa.gov`. Crucix does not retry for 6 hours. Safecast is the working radiation source.

CelesTrak connect timeouts are common from some networks. Crucix uses IPv4, caches a good answer for 2 hours, and does not download the Starlink/OneWeb mega-lists every sweep.

Launch Library rows stay visible while the newest catalog `last_updated` is within 72 hours (launch records are not edited every 12 hours). Anonymous use is 15 calls an hour; a sweep makes 2 and caches 15 minutes.

### Cursor ideas time out after 90 s

The Cursor Agent CLI typically spends ~50 s before the first byte (spawn + handshake), then a few seconds for the ideas JSON. The default `LLM_IDEAS_TIMEOUT_MS` is 180000. If the profile `.env` still has `90000`, raise it and restart. Opt-in live timing: `CRUCIX_LIVE_LLM=1` then `node --test --test-timeout=240000 test/llm-cursor-live.test.mjs`.

### Telegram bot not responding to commands

Make sure both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env`. The bot only responds to messages from the configured chat ID (security measure). You should see `[Crucix] Telegram alerts enabled` and `[Crucix] Bot command polling started` in the server logs on startup. If not, double-check your token with `curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe`.

### Discord bot not responding to slash commands

Check these in order:
1. Make sure `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are set in `.env`
2. Verify `discord.js` is installed: `npm ls discord.js`. If missing, run `npm install discord.js`
3. If slash commands don't appear, set `DISCORD_GUILD_ID` — without it, global commands can take up to 1 hour to propagate. Guild-specific commands register instantly
4. Confirm the bot was invited with `bot` + `applications.commands` scopes and has `Send Messages` + `Embed Links` permissions in the target channel
5. Check server logs for `[Discord] Bot logged in as ...` on startup. If you see `[Discord] discord.js not installed`, install it and restart
6. **Webhook-only fallback:** If you just want alerts without slash commands, set `DISCORD_WEBHOOK_URL` instead of the bot token. No `discord.js` needed.
