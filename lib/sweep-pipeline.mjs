// The derived-data stage of a sweep for the terminal (`crucix --sweep` and `--collector`), without the web server.
// server.mjs runs the same steps in runSweepCycle, in the same order: synthesize -> delta/memory -> events (history) ->
// country risk -> alert engine -> sweep archive. Without this stage a CLI sweep only wrote runs/latest.json, so --history,
// --risk, --alerts, --delta and --sweeps stayed empty until the dashboard had run.
// Left to the server: the SSE broadcast, the LLM trade ideas, the Telegram/Discord bots and the notification channels
// (a terminal sweep never sends anything outside the machine; the alerts it raises are stored for the next dashboard start).
import { synthesize as synthesizeSweep } from '../dashboard/inject.mjs';
import { MemoryManager, computeDelta } from './delta/index.mjs';
import { buildEvents, clusterEvents, stampLiveEventIds } from './intelligence/events.mjs';
import { HistoryStore } from './intelligence/history.mjs';
import { EntityStore } from './intelligence/entities.mjs';
import { PredictionJournal } from './intelligence/predictions.mjs';
import { KeywordStore } from './intelligence/keywords.mjs';
import { ThermalStore } from './intelligence/thermal.mjs';
import { GraphStore } from './intelligence/graph.mjs';
import { ThreadStore } from './intelligence/threads.mjs';
import { runRiskStep } from './intelligence/risk-step.mjs';
import { AlertEngine } from './alerts/engine.mjs';
import { runAlertStep } from './alerts/sweep.mjs';
import { SweepArchive } from './sweeps/archive.mjs';
import { archiveSweep } from './sweeps/step.mjs';
import { enrichNewsFeed, WORLD_NEWS_PER_COUNTRY } from './news/world-enrich.mjs';
import { getBalancedWorldNews, loadWorldRssCache } from './world-rss-runner.mjs';

const NO_NOTIFICATIONS = Object.freeze({ dispatch: async () => ({ sent: [] }) });
// The world-RSS headlines of the server's last background run, read from its cache file (none before the server has run).
const cachedWorldNews = () => (loadWorldRssCache() ? getBalancedWorldNews(WORLD_NEWS_PER_COUNTRY) : []);
const messageOf = error => String(error?.message || error).split('\n')[0].slice(0, 200);

/**
 * Opens the stores under `runsDir` once (a collector loop reuses them) and returns `run(rawData)`.
 * `synthesize` and `worldNews` are injectable for tests (the real ones fetch the news feeds and read the world-RSS cache).
 * `run` never throws: every step reports `ok` and the first line of its error, and a failing step does not stop the next.
 */
export function createSweepPipeline({ runsDir, config, language = 'en', logger = console, synthesize = synthesizeSweep, worldNews = cachedWorldNews }) {
  const memory = new MemoryManager(runsDir);
  const history = new HistoryStore(runsDir);
  const riskOn = config.risk?.enabled !== false;
  const risk = riskOn ? {
    store: new EntityStore(runsDir, { retentionDays: config.risk.retentionDays }),
    journal: new PredictionJournal(runsDir),
    keywords: new KeywordStore(runsDir),
    thermal: new ThermalStore(runsDir),
    graph: new GraphStore(runsDir),
    threads: new ThreadStore(runsDir),
  } : null;
  for (const store of Object.values(risk ?? {})) store.load();
  const engine = new AlertEngine(runsDir, { config: { maxActivePerRule: config.alerts?.maxActivePerRule } });
  engine.load();
  const archive = new SweepArchive(runsDir, { count: config.sweeps?.count, maxMb: config.sweeps?.maxMb });
  let previousArchived = null;
  try { previousArchived = archive.latest(); } catch (error) { logger.error('[Sweeps] Could not read the archive:', messageOf(error)); }

  async function run(rawData) {
    const steps = {};
    const attempt = (name, fn) => {
      try { const detail = fn(); steps[name] = { ok: true, ...(detail && typeof detail === 'object' ? detail : {}) }; }
      catch (error) { steps[name] = { ok: false, error: messageOf(error) }; logger.error(`[Pipeline] ${name} failed:`, messageOf(error)); }
    };

    let snapshot;
    try {
      snapshot = await synthesize(rawData);
      steps.synthesize = { ok: true };
    } catch (error) {
      steps.synthesize = { ok: false, error: messageOf(error) };
      logger.error('[Pipeline] synthesize failed:', messageOf(error));
      return { snapshot: null, steps };
    }

    // As in the server sweep: the world-RSS headlines join the news feed before the events are built.
    attempt('worldNews', () => ({ added: enrichNewsFeed(snapshot, worldNews()) }));

    let delta = null;
    attempt('delta', () => {
      const previous = memory.getLastRun();
      delta = computeDelta(snapshot, previous, config.delta?.thresholds, memory.getRunHistory().map(item => item.data));
      snapshot.delta = delta;
      memory.addRun(snapshot, config.delta?.thresholds);
      memory.pruneAlertedSignals();
      return { changes: delta?.summary?.totalChanges ?? 0 };
    });

    attempt('events', () => {
      if (Array.isArray(snapshot.liveSources)) snapshot.liveSources = stampLiveEventIds(snapshot.liveSources);
      snapshot.events = buildEvents(snapshot);
      snapshot.eventClusters = clusterEvents(snapshot.events);
      history.add(snapshot.events);
      return { events: snapshot.events.length };
    });

    if (risk) {
      attempt('risk', () => {
        const result = runRiskStep({ ...risk, snapshot, raw: rawData, now: Date.now(), language });
        if (!result.ok) throw new Error(result.error || 'the risk step reported a failure');
        return { countries: Object.keys(result.scores ?? {}).length };
      });
    } else {
      steps.risk = { ok: true, skipped: 'RISK_ENABLED=false' };
    }

    attempt('alerts', () => {
      // runAlertStep never throws and only stores: the notifier is a no-op here.
      runAlertStep(snapshot, { engine, notifier: NO_NOTIFICATIONS, delta, logger });
      return { open: snapshot.alerts?.counts?.total ?? null };
    });

    const archived = archiveSweep({ archive, snapshot, timing: rawData.timing, previous: previousArchived, log: logger });
    steps.archive = archived.error ? { ok: false, error: archived.error } : { ok: true, archived: archived.archived };
    if (!archived.error) previousArchived = snapshot;

    return { snapshot, steps };
  }

  return { run, engine, history, archive, memory };
}
