import { boundedInteger } from './budgets.mjs';
import { resolveIdeas } from './rule-ideas.mjs';

// Per-process idea cache only. Delta alerts are evaluated separately every sweep.
export class IdeaCadence {
  constructor({ everyNSweeps = 1, now = () => Date.now() } = {}) {
    this.everyNSweeps = boundedInteger(everyNSweeps, 1, 'everyNSweeps', 1, 96);
    this.sweepCount = 0;
    this._now = now;
    this._cachedLlm = null;
  }

  async resolve(provider, data, delta = null, previous = [], language = 'en') {
    this.sweepCount++;
    const due = this.sweepCount === 1 || this.sweepCount % this.everyNSweeps === 0;
    if (provider?.isConfigured && !due && this._cachedLlm) {
      return { ...structuredClone(this._cachedLlm), ideasCached: true };
    }
    // Missing cache or disabled provider: evaluate current rules without an extra LLM call.
    const result = await resolveIdeas(due ? provider : null, data, delta, previous, language);
    const fresh = {
      ...result,
      ideasGeneratedAt: result.ideas.length || result.ideasSource === 'llm' ? new Date(this._now()).toISOString() : null,
      ideasCached: false,
    };
    // A failed model call must not replace a successful cache with rules or a new timestamp.
    if (fresh.ideasSource === 'llm') this._cachedLlm = structuredClone(fresh);
    return fresh;
  }

  // The server's split (since 2.48): the sweep publishes at once with `current()` and the model runs after it (`generate()`), so a slow
  // model (the Cursor CLI takes 45-180 s) never delays the dashboard.

  /** Counts a sweep; whether a model run is due for it (the first sweep, then every N). */
  due() {
    this.sweepCount++;
    return this.sweepCount === 1 || this.sweepCount % this.everyNSweeps === 0;
  }

  /** What the snapshot carries now, without a model call: the last model ideas while there are any, else the rule ideas. */
  async current(data, delta = null, previous = [], language = 'en') {
    if (this._cachedLlm) return { ...structuredClone(this._cachedLlm), ideasCached: true };
    const result = await resolveIdeas(null, data, delta, previous, language);
    return { ...result, ideasGeneratedAt: result.ideas.length ? new Date(this._now()).toISOString() : null, ideasCached: false };
  }

  /** The model run: the fresh ideas when the model answered, else null (the snapshot keeps what `current()` gave). Records its stats. */
  async generate(provider, data, delta = null, previous = [], language = 'en') {
    const stats = { at: new Date(this._now()).toISOString(), provider: provider?.name ?? null };
    const started = Date.now();
    const result = await resolveIdeas(provider, data, delta, previous, language, stats);
    stats.ms = Date.now() - started;
    stats.source = result.ideasSource;
    stats.ideas = result.ideas.length;
    this.lastRun = stats;
    if (result.ideasSource !== 'llm') return null;
    const fresh = { ...result, ideasGeneratedAt: new Date(this._now()).toISOString(), ideasCached: false };
    this._cachedLlm = structuredClone(fresh);
    return fresh;
  }
}
