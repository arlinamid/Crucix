#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

// First import: lib/i18n.mjs fixes the language at module evaluation, which an earlier import reaches before crucix.config.mjs.
import './apis/utils/env.mjs';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { openBrowser } from './lib/open-browser.mjs';
import { inlineJson } from './lib/html.mjs';
import { installApiErrorHandler } from './lib/api-errors.mjs';
import { installHttpSecurity } from './lib/http-security.mjs';
import { compressResponses, staticGzip } from './lib/http-compress.mjs';
import { saveSnapshot } from './lib/snapshots.mjs';
import { buildEvents, clusterEvents, stampLiveEventIds } from './lib/intelligence/events.mjs';
import { freshLiveSnapshot } from './lib/intelligence/live-sources.mjs';
import { HistoryStore } from './lib/intelligence/history.mjs';
import { installIntelligenceRoutes } from './lib/intelligence/routes.mjs';
import { EntityStore } from './lib/intelligence/entities.mjs';
import { PredictionJournal } from './lib/intelligence/predictions.mjs';
import { runRiskStep } from './lib/intelligence/risk-step.mjs';
import { GraphStore } from './lib/intelligence/graph.mjs';
import { ThreadStore, summarizeThreads } from './lib/intelligence/threads.mjs';
import { ThreadArchive, backfillGraph } from './lib/intelligence/thread-archive.mjs';
import { importStatePath, importSweepArchives, sweepArchiveDirs } from './lib/intelligence/history-import.mjs';
import { createDictionaries } from './lib/intelligence/extract.mjs';
import { Maintenance } from './lib/maintenance.mjs';
import { installFileLog, SweepTimings } from './lib/logger.mjs';
import { themeAnalysis } from './lib/intelligence/themes.mjs';
import { LinkCache, linkWithModel } from './lib/llm/linker.mjs';
import { KeywordStore } from './lib/intelligence/keywords.mjs';
import { ThermalStore } from './lib/intelligence/thermal.mjs';
import { installRiskRoutes } from './lib/intelligence/risk-routes.mjs';
import { createBriefingService } from './lib/llm/briefing.mjs';
import { renderOfflineShell } from './lib/offline-shell.mjs';
import { createDailyBasemap } from './lib/basemap.mjs';
import { broadcastEvent, writeToClient } from './lib/sse.mjs';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { readAircraft } from './apis/sources/opensky.mjs';
import { startMaritimeCollector } from './apis/sources/ships.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager, computeDelta } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { IdeaCadence } from './lib/llm/cadence.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import { answerQuestion, countryRiskText, createAskLimiter } from './lib/alerts/ask.mjs';
import { briefTopic, buildBotBrief } from './lib/alerts/brief.mjs';
import { AlertEngine } from './lib/alerts/engine.mjs';
import { AlertNotifier } from './lib/alerts/notify.mjs';
import { installAlertRoutes } from './lib/alerts/routes.mjs';
import { attachAlertSummary, runAlertStep } from './lib/alerts/sweep.mjs';
import { SweepArchive } from './lib/sweeps/archive.mjs';
import { installSweepRoutes } from './lib/sweeps/routes.mjs';
import { installSetupRoutes } from './lib/setup-wizard.mjs';
import { archiveSweep } from './lib/sweeps/step.mjs';
import { WORLD_FEEDS, getFeedsByCountry } from './apis/utils/news-feeds.mjs';
import { parseFeed } from './apis/utils/rss.mjs';
import { getWorldNewsByCountry, getWorldNews, getBalancedWorldNews, getWorldRssStats, loadWorldRssCache, startWorldRssScheduler } from './lib/world-rss-runner.mjs';
import { enrichNewsFeed as enrichWorldNews, WORLD_NEWS_PER_COUNTRY } from './lib/news/world-enrich.mjs';
import { openFeedStore, setActiveFeedStore } from './lib/news/feed-store.mjs';
import { installFeedRoutes } from './lib/news/routes.mjs';
import { resolveRunsDir as resolveUserRunsDir, feedsSettingsPath, settingsEnvPath } from './lib/user-paths.mjs';
import { resolveDashboardPublicDir, readJarvisHtml } from './lib/dashboard-path.mjs';
import { alreadyRunningMessage, holdInstanceLock } from './lib/instance-lock.mjs';
import { isBenignHttpParserClose } from './lib/http-parser-error.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
export function resolveRunsDir(configuredDir = config.runsDir) {
  return resolveUserRunsDir({ root: ROOT, configured: configuredDir });
}
const RUNS_DIR = resolveRunsDir();
// The console also goes to runs/logs/crucix-YYYY-MM-DD.log (14 days, 20 MB a day); the last warnings and errors feed /api/health.
const fileLog = installFileLog(RUNS_DIR);
// The post-processing step times of the last 24 hours (/api/health `sweeps`).
const sweepTimings = new SweepTimings();
const MEMORY_DIR = join(RUNS_DIR, 'memory');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === State ===
let currentData = null;    // Current synthesized dashboard data
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
const startTime = Date.now();
const sseClients = new Set();

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);
const ideaCadence = new IdeaCadence({ everyNSweeps: config.llm.everyNSweeps });
const history = new HistoryStore(RUNS_DIR);
let historyStatus = 'ok';
// The background maintenance (lib/maintenance.mjs): saving the risk stores after a sweep, the history's retention and daily backup, the
// graph backfill from the history and the past-thread archive. None of it runs in a sweep's critical path or in a request.
const maintenance = new Maintenance();
function recordSnapshotEvents(snapshot) {
  if (Array.isArray(snapshot.liveSources)) snapshot.liveSources = stampLiveEventIds(snapshot.liveSources);
  snapshot.events = buildEvents(snapshot);
  snapshot.eventClusters = clusterEvents(snapshot.events);
  try { history.add(snapshot.events); historyStatus = 'ok'; }
  catch (error) { historyStatus = 'unavailable'; console.error('[History] Save failed:', error.message); }
}
// Country risk (runs/intelligence/countries.json and predictions.json): a missing or corrupt file starts empty. With
// RISK_ENABLED=false nothing is created, the step never runs and the risk routes are not installed.
const riskStore = config.risk.enabled ? new EntityStore(RUNS_DIR, { retentionDays: config.risk.retentionDays }) : null;
const riskJournal = config.risk.enabled ? new PredictionJournal(RUNS_DIR) : null;
const riskKeywords = config.risk.enabled ? new KeywordStore(RUNS_DIR) : null;
const riskThermal = config.risk.enabled ? new ThermalStore(RUNS_DIR) : null;
// The entity graph (runs/intelligence/graph.json): events linked through chokepoints, sites, actors, CVEs and shared stories.
const riskGraph = config.risk.enabled ? new GraphStore(RUNS_DIR) : null;
const riskThreads = config.risk.enabled ? new ThreadStore(RUNS_DIR) : null;
riskStore?.load();
riskGraph?.load();
riskThreads?.load();
const threadArchive = config.risk.enabled ? new ThreadArchive(RUNS_DIR) : null;
// The stores a sweep changed, saved by one background job after it (the graph's big file off the main thread).
const dirtyStores = new Map();
async function saveDirtyStores(ctx) {
  for (const [name, target] of [...dirtyStores]) {
    dirtyStores.delete(name);
    if (typeof target.saveAsync === 'function') await target.saveAsync(console);
    else target.save(console);
    await ctx.slice();
  }
}
function persistStore(name, target) {
  dirtyStores.set(name, target);
  maintenance.schedule('save', saveDirtyStores, { delayMs: 1000 });
}
// History records of the thread window that the graph lacks (it started later than the history): added in time order, then the threads.
async function backfillThreads(ctx) {
  if (!riskGraph || !riskThreads) return;
  const added = await backfillGraph(riskGraph, history, { slice: ctx.slice, dictionaries: createDictionaries({ actors: riskLatest?.inputs?.actors }) });
  if (!added) return;
  const now = Date.now();
  riskThreads.compute(riskGraph, { now });
  if (currentData) currentData.threads = summarizeThreads(riskThreads.threads, now);
  persistStore('graph', riskGraph);
  persistStore('threads', riskThreads);
  console.log(`[Maintenance] Graph backfill: ${added} history record(s) added, ${riskThreads.threads.length} thread(s)`);
}
// The finished days' threads, computed once each; then the days past the 30 kept go.
async function archiveThreads(ctx) {
  if (!threadArchive) return;
  const dictionaries = createDictionaries({ actors: riskLatest?.inputs?.actors });
  // The days overlap by 72 hours: each record's entities are extracted once for the whole run.
  const cache = new Map();
  for (const day of threadArchive.pendingDays(history)) {
    const count = await threadArchive.computeDay(day, history, { dictionaries, slice: ctx.slice, cache });
    console.log(`[Maintenance] Thread archive ${day}: ${count} thread(s)`);
  }
  threadArchive.prune();
}
// The archived sweeps' events into the history (the days before 2.46 kept only the newest 10,000 records; every sweep archive kept its
// events whole). Each file once; the days it adds to are archived again, the live graph is filled again.
async function importSweeps(ctx) {
  const result = await importSweepArchives(history, sweepArchiveDirs(RUNS_DIR), { statePath: importStatePath(RUNS_DIR), slice: ctx.slice, log: console });
  if (!result.files) return;
  console.log(`[Maintenance] History import: ${result.files} sweep file(s), ${result.events} event(s), ${result.added} new record(s)`);
  if (!result.added) return;
  // The daily backup must hold what the import brought in, not wait for tomorrow's.
  maintenance.schedule('history-backup', async () => { if (await history.backup()) lastHistoryBackup = Date.now(); }, { delayMs: 500 });
  if (threadArchive) threadArchive.invalidate(result.days);
  maintenance.schedule('graph-backfill', backfillThreads, { delayMs: 1000 });
  maintenance.schedule('thread-archive', archiveThreads, { delayMs: 2000 });
}
// Rows stored as JSON text before 2.49 rewritten in the compact form (deflated body without the derived quality), a few hundred at a time.
async function compactHistory(ctx) {
  if (typeof history.compact !== 'function') return;
  let total = 0, count;
  while ((count = history.compact({ limit: 150 })) > 0) { total += count; await ctx.slice(); }
  if (!total) return;
  // Once: the file shrinks to its data and switches to incremental vacuuming (the daily trim then gives back free pages a little at a time).
  const started = Date.now();
  history.vacuum();
  console.log(`[Maintenance] History compaction: ${total} record(s) rewritten in the compact form; file vacuumed in ${Date.now() - started} ms`);
}
// The themes of the history (lib/intelligence/themes.mjs) for GET /api/history/themes: computed in the background, at most hourly per
// window and scope, never in a request. `scope` news = the reports only (news, OSINT), all = every kind.
const THEME_DAYS = [1, 3, 7, 14, 30];
const themesCache = new Map(); // `${days}|${scope}` -> { at, result }
function scheduleThemes(days = 7, scope = 'news') {
  const key = `${days}|${scope}`;
  if (Date.now() - (themesCache.get(key)?.at ?? 0) < 3600000) return;
  maintenance.schedule(`themes-${key}`, async ctx => {
    const result = await themeAnalysis(history, { days, slice: ctx.slice, kinds: scope === 'news' ? ['news', 'osint'] : null });
    themesCache.set(key, { at: Date.now(), result });
  }, { delayMs: 30000 });
}
// The history's retention (by days) and its daily backup.
let lastHistoryBackup = 0;
async function keepHistory() {
  const removed = history.prune();
  if (removed) console.log(`[Maintenance] History: ${removed} record(s) past the retention removed`);
  if (typeof history.trim === 'function') history.trim(2000);
  if (Date.now() - lastHistoryBackup > 24 * 3600000 && await history.backup()) lastHistoryBackup = Date.now();
}
// RISK_LLM_LINKING=true: the model's answers on borderline report pairs, kept for the life of the server.
const linkCache = new LinkCache();
riskJournal?.load();
riskKeywords?.load();
riskThermal?.load();
let riskStatus = config.risk.enabled ? 'unavailable' : 'disabled';
let riskLatest = null; // the last successful step: {at, scores, inputs}
// Never throws: on a failure the snapshot goes on without `risk` and /api/health says 'unavailable'.
function recordRisk(snapshot, raw) {
  if (!riskStore) return;
  const result = runRiskStep({ store: riskStore, journal: riskJournal, keywords: riskKeywords, thermal: riskThermal, graph: riskGraph, threads: riskThreads, snapshot, raw, now: Date.now(), language: currentLanguage, persist: persistStore });
  riskStatus = result.ok ? 'ok' : 'unavailable';
  if (result.ok) riskLatest = result;
}
// Alert state lives in runs/alerts/; a missing or corrupt file starts empty and never stops the server.
const alertEngine = new AlertEngine(RUNS_DIR, { config: { maxActivePerRule: config.alerts.maxActivePerRule } });
alertEngine.load();
// Sweep archive in runs/sweeps/: every completed sweep is stored for replay, the changes windows and the source-health matrix.
// previousArchived is the baseline of the next sweep's changes; after a restart it is the newest archived sweep.
const sweepArchive = new SweepArchive(RUNS_DIR, { count: config.sweeps.count, maxMb: config.sweeps.maxMb });
// News feed overrides in the profile's feeds.json (Settings > News feeds): the sweep and the world RSS runner read the
// feeds that are on.
const feedStore = openFeedStore({ runsDir: RUNS_DIR, file: feedsSettingsPath() });
if (feedStore.loadError) console.error('[Feeds] feeds.json could not be read; using the defaults:', feedStore.loadError);
setActiveFeedStore(feedStore);
let previousArchived = null;
try { previousArchived = sweepArchive.latest(); }
catch (error) { console.error('[Sweeps] Could not read the archive:', error.message); }

// === LLM + Telegram + Discord ===
const llmProvider = createLLMProvider(config.llm);
const telegramAlerter = new TelegramAlerter({ ...config.telegram, dashboardUrl: config.alerts.publicUrl });
const discordAlerter = new DiscordAlerter({ ...(config.discord || {}), dashboardUrl: config.alerts.publicUrl });
const askAllowed = createAskLimiter();
const askBot = async (channel, question) => {
  if (!askAllowed(channel)) return { text: 'Too many questions; try again in a minute.', plain: true };
  return { text: await answerQuestion({ question, snapshot: currentData, provider: llmProvider }), plain: true };
};
const riskBot = input => ({ text: countryRiskText(input, { state: riskLatest, snapshot: currentData }), plain: true });
const alertNotifier = new AlertNotifier({
  telegram: telegramAlerter, discord: discordAlerter, notifyChannels: config.alerts.notifyChannels, ntfy: config.alerts.ntfy, webhook: config.alerts.webhook,
  minSeverity: config.alerts.notifyMinSeverity, quietHours: config.alerts.quietHours,
  maxPerSweep: config.alerts.maxNotificationsPerSweep, publicUrl: config.alerts.publicUrl,
});

if (llmProvider) console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
if (telegramAlerter.isConfigured) {
  console.log('[Crucix] Telegram alerts enabled');

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  telegramAlerter.onCommand('/status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `🖥️ *CRUCIX STATUS*`,
      ``,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: ${config.publicUrl}`,
    ].join('\n');
  });

  telegramAlerter.onCommand('/sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    // Fire and forget — don't block the bot response
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  telegramAlerter.onCommand('/brief', async args => buildBotBrief({
    data: currentData, delta: memory.getLastDelta(), held: telegramAlerter.takeHeldAlerts(), topic: briefTopic(args), style: 'telegram',
  }));

  telegramAlerter.onCommand('/ask', async args => askBot('telegram', args));
  telegramAlerter.onCommand('/risk', async args => riskBot(args));

  telegramAlerter.onCommand('/portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start polling for bot commands
  telegramAlerter.startPolling(config.telegram.botPollingInterval);
}

// === Discord Bot ===
if (discordAlerter.isConfigured) {
  console.log('[Crucix] Discord bot enabled');

  // Reuse the same command handlers as Telegram (DRY)
  discordAlerter.onCommand('status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `**🖥️ CRUCIX STATUS**\n`,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: ${config.publicUrl}`,
    ].join('\n');
  });

  discordAlerter.onCommand('sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  discordAlerter.onCommand('brief', async args => buildBotBrief({
    data: currentData, delta: memory.getLastDelta(), held: discordAlerter.takeHeldAlerts(), topic: briefTopic(args), style: 'discord',
  }));

  discordAlerter.onCommand('ask', async args => askBot('discord', args));
  discordAlerter.onCommand('risk', async args => riskBot(args));

  discordAlerter.onCommand('portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start the Discord bot (non-blocking — connection happens async)
  discordAlerter.start().catch(err => {
    console.error('[Crucix] Discord bot startup failed (non-fatal):', err.message);
  });
}

// === Express Server ===
if (config.web.corsOrigins.includes('*') && !config.auth.user) {
  console.warn("[Crucix] CORS_ORIGINS=* without AUTH_USER/AUTH_PASSWORD: any website you open can read this server's API from your browser");
}
const app = express();
installHttpSecurity(app, config.auth, config.web);
const dashboardDir = resolveDashboardPublicDir();
// gzip: the static files once per version, the handlers' bodies (the ~4 MB snapshot and page) on zlib's thread pool.
app.use(compressResponses());
app.use(staticGzip(dashboardDir));
app.use(express.static(dashboardDir));
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.get('/offline-shell', (_req, res) => {
  res.type('html').send(renderOfflineShell(readJarvisHtml(), getLocale()));
});

// Serve an empty dashboard until the first sweep, then inject the current locale.
app.get('/', (req, res) => {
  if (!currentData) {
    res.type('html').send(renderOfflineShell(readJarvisHtml(), getLocale(), { offline: false }));
  } else {
    let html = readJarvisHtml();
    const dataScript = inlineJson(freshLiveSnapshot(currentData));
    
    html = html.replace(/^(let|const) D = .*;\s*$/m, () => `let D = ${dataScript};`);

    // Inject locale data into the HTML
    const locale = getLocale();
    const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${inlineJson(locale)};</script>`;
    html = html.replace('</head>', `${localeScript}\n</head>`);
    
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(freshLiveSnapshot(currentData));
});

// API: every airborne aircraft of the last good OpenSky round, for the map's detail views (compact rows, see AIRCRAFT_FIELDS).
app.get('/api/air', (req, res) => {
  const list = readAircraft();
  if (!list) return res.status(503).json({ error: 'No aircraft list yet — it is written by the next successful OpenSky round' });
  res.set('Cache-Control', 'no-store');
  res.json(list);
});

// API: the most frequent words and phrases of the history, overall, per topic and per kind, and today's rising ones.
app.get('/api/history/themes', (req, res) => {
  const query = req.query ?? {};
  if (Object.keys(query).some(key => key !== 'days' && key !== 'scope')) return res.status(400).json({ error: 'Unknown query parameter', code: 'INVALID_QUERY' });
  const days = query.days === undefined ? 7 : Number(query.days), scope = query.scope === undefined ? 'news' : String(query.scope);
  if (!THEME_DAYS.includes(days)) return res.status(400).json({ error: `days must be one of ${THEME_DAYS.join(', ')}`, code: 'INVALID_DAYS', field: 'days' });
  if (scope !== 'news' && scope !== 'all') return res.status(400).json({ error: 'scope must be news or all', code: 'INVALID_SCOPE', field: 'scope' });
  const cached = themesCache.get(`${days}|${scope}`);
  scheduleThemes(days, scope);
  if (!cached) return res.status(202).json({ pending: true, days, scope });
  res.set('Cache-Control', 'no-store');
  res.json({ computedAt: new Date(cached.at).toISOString(), scope, ...cached.result });
});

// API: the daily globe basemap (NASA GIBS VIIRS true colour of yesterday, cached; see lib/basemap.mjs)
const dailyBasemap = createDailyBasemap();
app.get('/api/basemap/daily.jpg', async (req, res) => {
  if (Object.keys(req.query ?? {}).length) return res.status(400).json({ error: 'Unknown query parameter', code: 'INVALID_QUERY' });
  try {
    const image = await dailyBasemap.get();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'X-Basemap-Date': image.day, 'X-Basemap-Stale': image.stale ? '1' : '0' });
    res.send(image.buffer);
  } catch {
    res.status(503).json({ error: 'Daily basemap unavailable' });
  }
});

installIntelligenceRoutes(app, { getSnapshot: () => freshLiveSnapshot(currentData), history, language: currentLanguage });
if (riskStore) {
  const briefing = createBriefingService({ provider: llmProvider, language: currentLanguage, store: riskStore, history,
    getSnapshot: () => currentData, getScores: () => riskLatest?.scores ?? null });
  installRiskRoutes(app, { store: riskStore, journal: riskJournal, getSnapshot: () => currentData, getState: () => riskLatest, history, briefing, graph: riskGraph, threads: riskThreads, archive: threadArchive, language: currentLanguage,
    security: { publicUrl: config.alerts.publicUrl, allowedHosts: config.alerts.allowedHosts } });
}
// After an operator action the dashboards get the new summary; the next /api/data and page load carry it too.
installAlertRoutes(app, { engine: alertEngine, getSnapshot: () => freshLiveSnapshot(currentData), onChange: (summary, newIds) => {
  if (currentData) currentData.alerts = summary;
  broadcast({ type: 'alerts', data: summary, newIds });
}, security: { publicUrl: config.alerts.publicUrl, allowedHosts: config.alerts.allowedHosts }, language: currentLanguage });
installSweepRoutes(app, { archive: sweepArchive, getCurrent: () => currentData });
installSetupRoutes(app, { security: { publicUrl: config.alerts?.publicUrl, allowedHosts: config.alerts?.allowedHosts } });
installFeedRoutes(app, { store: feedStore, security: { publicUrl: config.alerts.publicUrl, allowedHosts: config.alerts.allowedHosts } });

function archivedSweepCount() {
  try { return sweepArchive.list().length; } catch { return 0; }
}

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    // Which ones: the source-health rows of the snapshot (n = name).
    failingSources: (currentData?.health || []).filter(row => row?.err).map(row => row.n).slice(0, 40),
    staleSources: (currentData?.health || []).filter(row => row?.stale && !row?.err).map(row => row.n).slice(0, 40),
    llmEnabled: !!llmProvider?.isConfigured,
    ideasEveryNSweeps: ideaCadence.everyNSweeps,
    llmProvider: config.llm.provider,
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    language: currentLanguage,
    historyStatus,
    historyEngine: history.engine,
    ideas: { everyNSweeps: ideaCadence.everyNSweeps, running: ideasRunning, last: ideaCadence.lastRun ?? null },
    riskStatus,
    maintenance: maintenance.status(),
    sweeps: sweepTimings.summary(),
    log: fileLog ? { recent: fileLog.recent() } : null,
    archiveStatus: sweepArchive.status,
    archivedSweeps: archivedSweepCount(),
  });
});

// API: available locales
app.get('/api/locales', (req, res) => {
  res.json({
    current: currentLanguage,
    supported: getSupportedLocales(),
  });
});

// API: world news country catalog
app.get('/api/news/countries', (req, res) => {
  const byCountry = new Map();
  for (const f of WORLD_FEEDS) {
    if (!f.country) continue;
    if (!byCountry.has(f.country)) byCountry.set(f.country, { code: f.country, feeds: [] });
    byCountry.get(f.country).feeds.push({ source: f.source, url: f.url, lang: f.lang });
  }
  res.json({
    totalCountries: byCountry.size,
    totalFeeds: WORLD_FEEDS.length,
    countries: Array.from(byCountry.values()).sort((a, b) => a.code.localeCompare(b.code)),
  });
});

// API: fetch on-demand live or cached news for a country
app.get('/api/news/country/:code', async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();
  const feeds = getFeedsByCountry(code);
  if (!feeds.length) return res.status(404).json({ error: `Country ${code} not found in world feeds catalog` });

  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const forceLive = req.query.live === 'true';

  // Return from 30-min background cache if available and not forced live
  if (!forceLive) {
    const cached = getWorldNewsByCountry(code);
    if (cached && cached.length > 0) {
      return res.json({
        country: code,
        cached: true,
        totalSources: feeds.length,
        returned: Math.min(cached.length, limit),
        items: cached.slice(0, limit),
      });
    }
  }

  try {
    const results = await Promise.allSettled(
      feeds.map(async f => {
        const fetchRes = await fetch(f.url, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Crucix Intelligence Reader)' },
        });
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
        const text = await fetchRes.text();
        return parseFeed(text).map(item => ({
          source: f.source,
          title: item.title,
          url: item.link,
          date: item.date,
          country: f.country,
          lang: f.lang,
        }));
      })
    );
    const items = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    res.json({
      country: code,
      cached: false,
      totalSources: feeds.length,
      returned: Math.min(items.length, limit),
      items: items.slice(0, limit),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: cached world news status and top feeds
app.get('/api/news/world', (req, res) => {
  const stats = getWorldRssStats();
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  res.json({
    stats,
    items: getWorldNews(limit),
  });
});

// After the last /api route: JSON for what a route could not answer itself (a broken percent-encoding in an id, an escaped error).
installApiErrorHandler(app);

// SSE: live updates
app.get('/events', (req, res) => {
  if (sseClients.size >= config.maxSseClients) return res.status(503).set('Retry-After', '15').end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected"}\n\n');
  // ?lean=1: `update` messages without the snapshot (the dashboard fetches /api/data); without it the documented full message.
  res.crucixLean = req.query?.lean === '1';
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    if (!writeToClient(res, ': heartbeat\n\n')) sseClients.delete(res);
  }, 15000);
  heartbeat.unref();
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

function broadcast(data) {
  broadcastEvent(sseClients, data);
}

// World-RSS headlines (their own background sweep) join the news feed before the events are built.
const enrichNewsFeed = snapshot => enrichWorldNews(snapshot, getBalancedWorldNews(WORLD_NEWS_PER_COUNTRY));

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Crucix] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing();

    // How long each step after the sources holds the server (they run on the main thread): logged at the end of the sweep. Between two
    // steps the sweep yields to the event loop, so a request waits for one step at most, never for the whole post-processing.
    const steps = [];
    const stepMs = {};
    let stepStart = performance.now();
    const step = async name => {
      stepMs[name] = Math.round(performance.now() - stepStart);
      steps.push(`${name} ${stepMs[name]}`);
      await new Promise(resolve => setImmediate(resolve));
      stepStart = performance.now();
    };

    // 2. Save to runs/latest.json
    saveSnapshot(RUNS_DIR, rawData);
    await step('save');
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);
    enrichNewsFeed(synthesized);
    await step('synthesize');

    // Calculate against the prior run; persist only after ideas have been resolved.
    const previous = memory.getLastRun();
    const delta = computeDelta(synthesized, previous, config.delta.thresholds,
      memory.getRunHistory().map(run => run.data));
    synthesized.delta = delta;
    // Ideas: the snapshot is published with the last model ideas (or the rule ideas) and the model, when due, runs after the broadcast
    // (startIdeas below), so a slow model never delays the dashboard.
    const ideasDue = ideaCadence.due() && !!llmProvider?.isConfigured;
    const previousIdeas = previous?.ideas || [];
    Object.assign(synthesized, await ideaCadence.current(synthesized, delta, previousIdeas, config.llm.tradeIdeasLang));
    memory.addRun(synthesized, config.delta.thresholds);
    await step('delta+ideas');

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Telegram alert error:', err.message);
        });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    recordSnapshotEvents(synthesized);
    await step('events+history');
    // Country risk: sets synthesized.risk before the alert metrics read it and before the sweep is archived; never throws.
    recordRisk(synthesized, rawData);
    await step('risk+graph+threads');
    // The optional model help for the entity graph runs in the background: its links show in the next sweep's threads.
    if (riskGraph && config.risk.llmLinking && llmProvider?.isConfigured) {
      linkWithModel({ graph: riskGraph, provider: llmProvider, now: Date.now(), limit: config.risk.llmLinkingPairs, cache: linkCache })
        .then(edges => { if (edges.length) { riskGraph.link(edges); persistStore('graph', riskGraph); console.log(`[Linker] ${edges.length} model link(s) added`); } })
        .catch(error => console.warn('[Linker] Failed:', error?.message || error));
    }
    // Alert engine: never throws and does not wait for the notifications it sends.
    runAlertStep(synthesized, { engine: alertEngine, notifier: alertNotifier, delta });
    await step('alerts');
    // Sets synthesized.changes and stores the sweep; never throws. After a failed write the next changes are counted from
    // the last sweep on disk, so the next archived sweep also covers this one.
    if (!archiveSweep({ archive: sweepArchive, snapshot: synthesized, timing: rawData.timing, previous: previousArchived }).error) previousArchived = synthesized;
    currentData = synthesized;
    await step('archive');
    // After the sweep, in the background: the history's retention and backup, a day that has just finished goes into the thread archive.
    maintenance.schedule('history', keepHistory, { delayMs: 5000 });
    maintenance.schedule('thread-archive', archiveThreads, { delayMs: 10000 });
    scheduleThemes(7, 'news');

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });
    await step('broadcast');
    console.log(`[Crucix] Post-processing (ms): ${steps.join(' · ')}`);
    sweepTimings.add(stepMs);
    if (ideasDue) startIdeas(synthesized, delta, previousIdeas);

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

// The model ideas of a sweep, after it was published: one run at a time; the result replaces the snapshot's ideas, patches the memory
// run and goes to the dashboards as a small `ideas` message (and to Discord). A run that fails leaves the published ideas in place.
let ideasRunning = false;
function startIdeas(snapshot, delta, previousIdeas) {
  if (ideasRunning) { console.log('[LLM Ideas] Previous run still going; this sweep keeps its ideas'); return; }
  ideasRunning = true;
  ideaCadence.generate(llmProvider, snapshot, delta, previousIdeas, config.llm.tradeIdeasLang).then(fresh => {
    const run = ideaCadence.lastRun;
    console.log(`[LLM Ideas] ${fresh ? `${fresh.ideas.length} idea(s)` : `no model ideas (${run?.error || run?.source})`} in ${run?.ms ?? '?'} ms (prompt ${run?.promptChars ?? '?'} chars)`);
    if (!fresh) return;
    const patch = { ideas: fresh.ideas, ideasSource: fresh.ideasSource, ideasGeneratedAt: fresh.ideasGeneratedAt, ideasCached: false };
    Object.assign(snapshot, patch);
    if (currentData && currentData !== snapshot) Object.assign(currentData, patch);
    memory.patchLastIdeas(fresh.ideas);
    broadcast({ type: 'ideas', data: patch });
    if (discordAlerter.isConfigured) {
      discordAlerter.sendActionableIdeas(fresh.ideas).catch(error => console.error('[Discord] Idea delivery failed:', error.message));
    }
  }).catch(error => console.error('[LLM Ideas] Failed:', error?.message || error)).finally(() => { ideasRunning = false; });
}

// === Startup ===
async function start() {
  // On Ctrl+C or a stop signal the stores a sweep changed but the background has not saved yet are written before the process leaves.
  const lock = holdInstanceLock(RUNS_DIR, { beforeExit: () => { for (const [name, target] of dirtyStores) { try { target.save(console); } catch { /* leaving */ } dirtyStores.delete(name); } } });
  if (lock.error) {
    console.error(alreadyRunningMessage(lock, { port: config.port, lang: currentLanguage }));
    process.exit(1);
  }

  const port = config.port;

  const isHeadless =
    process.env.NO_AUTO_OPEN === '1' ||
    process.env.HEADLESS === '1' ||
    process.env.CI ||
    process.argv.includes('--headless') ||
    process.argv.includes('--no-open') ||
    process.argv.includes('--collector') ||
    process.argv.includes('--daemon');

  const modeDisplay = isHeadless ? 'Headless / Adatgyűjtő' : 'Standard (Web Dashboard)';

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║           CRUCIX INTELLIGENCE ENGINE         ║
  ║          Local Intelligence Engine          ║
  ╠══════════════════════════════════════════════╣
  ║  Mode:       ${modeDisplay.padEnd(31)}║
  ║  Dashboard:  http://localhost:${port}${' '.repeat(14 - String(port).length)}║
  ║  Health:     http://localhost:${port}/api/health${' '.repeat(Math.max(0, 4 - String(port).length))}║
  ║  Refresh:    Every ${config.refreshIntervalMinutes} min${' '.repeat(20 - String(config.refreshIntervalMinutes).length)}║
  ║  LLM:        ${(config.llm.provider || 'disabled').padEnd(31)}║
  ║  Telegram:   ${config.telegram.botToken ? 'enabled' : 'disabled'}${' '.repeat(config.telegram.botToken ? 24 : 23)}║
  ║  Discord:    ${config.discord?.botToken ? 'enabled' : config.discord?.webhookUrl ? 'webhook only' : 'disabled'}${' '.repeat(config.discord?.botToken ? 24 : config.discord?.webhookUrl ? 20 : 23)}║
  ╚══════════════════════════════════════════════╝
  `);

  const server = app.listen(port, config.host);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Crucix] FATAL: Port ${port} is already in use!`);
      console.error(`[Crucix] A previous Crucix instance may still be running.`);
      console.error(`[Crucix] Identify the process using this port, or change PORT in .env.\n`);
    } else {
      console.error(`[Crucix] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  server.on('listening', async () => {
    console.log(`[Crucix] Server running on http://localhost:${port}`);

    if (isHeadless) {
      console.log('[Crucix] Fejetlen (Headless / Adatgyűjtő) mód: a böngésző nem nyílik meg automatikusan');
    } else {
      // Auto-open browser
      openBrowser(`http://localhost:${port}`);
    }

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      const data = await synthesize(existing, { news: [] });
      // The world-RSS cache of the last run (the scheduler below loads it again and refreshes it).
      loadWorldRssCache();
      enrichNewsFeed(data);
      recordSnapshotEvents(data);
      // The stored references and VIEWS/INFORM inputs of runs/latest.json give the dashboard a risk summary at once; the
      // event ids are cached, so the next sweep does not count these events twice.
      recordRisk(data, existing);
      // Stale data without a delta: show the stored alerts, do not evaluate. Not archived: this copy is re-synthesized without its
      // news, and the sweep behind runs/latest.json was archived when it ran - except on the first start after the upgrade to a
      // version with an archive, when that sweep ran before there was one. The initial sweep below is then the first one stored.
      attachAlertSummary(data, alertEngine);
      currentData = data;
      lastSweepTime = data.meta?.timestamp || null;
      console.log('[Crucix] Loaded existing data from runs/latest.json — dashboard ready instantly');
      broadcast({ type: 'update', data: currentData });
    } catch {
      console.log('[Crucix] No existing data found — first sweep required');
    }

    // Live AIS vessel counts at the maritime chokepoints: one aisstream.io WebSocket for the life of the server, only with a key.
    if (process.env.AISSTREAM_API_KEY) startMaritimeCollector(process.env.AISSTREAM_API_KEY);

    // Run first sweep (refreshes data in background)
    console.log('[Crucix] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Crucix] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);
    // The background maintenance's start-up work, after the first sweep has had time to finish: the history's retention and backup, the
    // graph backfill from the history (the records of the thread window the graph never saw), the past-thread archive.
    maintenance.schedule('history', keepHistory, { delayMs: 60000 });
    maintenance.schedule('history-import', importSweeps, { delayMs: 75000 });
    maintenance.schedule('graph-backfill', backfillThreads, { delayMs: 90000 });
    maintenance.schedule('thread-archive', archiveThreads, { delayMs: 120000 });
    maintenance.schedule('history-compact', compactHistory, { delayMs: 150000 });

    // Start 30-minute background world RSS runner (539 feeds)
    startWorldRssScheduler(30);
  });
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
});
let httpParserCloseWarned = false;
process.on('uncaughtException', (err) => {
  if (isBenignHttpParserClose(err)) {
    if (!httpParserCloseWarned) {
      httpParserCloseWarned = true;
      console.warn('[Crucix] Node HTTP parser hit a paused TLS socket (RSS abort). Continuing; this is not a sweep failure.');
    }
    return;
  }
  console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
});

start().catch(err => {
  console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
  process.exit(1);
});
