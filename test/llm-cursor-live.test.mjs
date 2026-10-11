// Live timing of the Cursor Agent CLI against the operator's last sweep.
// Measures CLI startup (ping) vs a real ideas prompt so we can see whether the
// ideas budget covers spawn plus generation. Opt-in only (`CRUCIX_LIVE_LLM=1`).
//
// Opt-in (do not use isolate-profile if you want the real ~/.crucix snapshot):
//   set CRUCIX_LIVE_LLM=1
//   node --test --test-timeout=240000 test/llm-cursor-live.test.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CursorProvider } from '../lib/llm/cursor.mjs';
import { compactSweepForLLM, ideasSystemPrompt, parseIdeasResult } from '../lib/llm/ideas.mjs';
import { LLM_BUDGETS } from '../lib/llm/budgets.mjs';

const DEFAULT_IDEAS_MS = LLM_BUDGETS.ideas.timeout;
const LIVE_TIMEOUT_MS = 180000;

function agentOnPath() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['agent'], {
    timeout: 8000, encoding: 'utf8', windowsHide: true,
  });
  return probe.status === 0;
}

function loadLiveSweep() {
  const file = join(homedir(), '.crucix', 'runs', 'memory', 'hot.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const run = Array.isArray(raw?.runs) ? raw.runs[0] : null;
    if (!run?.data || typeof run.data !== 'object') return null;
    return { data: run.data, delta: run.delta || null, timestamp: run.timestamp || run.data.meta?.timestamp || null, file };
  } catch {
    return null;
  }
}

// Opt-in: `npm test` isolates the profile and must not spawn the real Agent CLI.
const available = process.env.CRUCIX_LIVE_LLM && !process.env.CRUCIX_SKIP_LIVE && agentOnPath();
const sweep = available ? loadLiveSweep() : null;

describe('Cursor Agent CLI live timing', {
  skip: !available && (process.env.CRUCIX_LIVE_LLM ? 'agent CLI is not on PATH' : 'set CRUCIX_LIVE_LLM=1 to run the live Agent CLI timing test'),
}, () => {
  it('a one-line ping shows how long the CLI itself takes to answer', async () => {
    const provider = new CursorProvider({ model: process.env.LLM_MODEL || 'auto' });
    const result = await provider.complete(
      'Reply with exactly the word pong and nothing else.',
      'ping',
      { maxTokens: 32, timeout: LIVE_TIMEOUT_MS },
    );
    const ms = result.timing?.ms;
    const first = result.timing?.firstByteMs;
    console.log(`[Cursor live] ping ${ms}ms (first byte ${first ?? 'n/a'}ms) text=${JSON.stringify(result.text.slice(0, 80))} model=${result.model}`);
    assert.ok(result.text.length > 0, 'ping returned no text');
    assert.ok(Number.isFinite(ms) && ms > 0);
    if (ms > DEFAULT_IDEAS_MS) {
      console.log(`[Cursor live] ping alone exceeded the ${DEFAULT_IDEAS_MS}ms ideas budget — the CLI needs more time, not a shorter prompt`);
    }
  });

  it('an ideas prompt built from the last live sweep shows whether 90s is enough', { skip: !sweep && 'no ~/.crucix/runs/memory/hot.json' }, async () => {
    const provider = new CursorProvider({ model: process.env.LLM_MODEL || 'auto' });
    const prompt = compactSweepForLLM(sweep.data, sweep.delta, sweep.data.ideas || []);
    const system = ideasSystemPrompt('en', sweep.data);
    console.log(`[Cursor live] sweep ${sweep.timestamp} prompt=${prompt.length}c system=${system.length}c file=${sweep.file}`);
    const started = Date.now();
    let result;
    try {
      result = await provider.complete(system, prompt, { maxTokens: 4096, timeout: LIVE_TIMEOUT_MS });
    } catch (error) {
      const waited = Date.now() - started;
      console.log(`[Cursor live] ideas FAILED after ${waited}ms: ${error.message}`);
      assert.ok(waited + 1000 >= Math.min(LIVE_TIMEOUT_MS, DEFAULT_IDEAS_MS), 'failed before the measured budget, not a slow model');
      throw error;
    }
    const ms = result.timing?.ms;
    const first = result.timing?.firstByteMs;
    const parsed = parseIdeasResult(result.text);
    console.log(`[Cursor live] ideas ${ms}ms (first byte ${first ?? 'n/a'}ms) text=${result.text.length}c ideas=${parsed.ideas.length} defaultBudget=${DEFAULT_IDEAS_MS}ms wouldHit90s=${ms > DEFAULT_IDEAS_MS}`);
    if (parsed.ideas.length) {
      console.log(`[Cursor live] first idea: ${parsed.ideas[0].type} ${parsed.ideas[0].title}`);
    } else {
      console.log(`[Cursor live] no parseable ideas (reason=${parsed.reason}); head=${JSON.stringify(result.text.slice(0, 160))}`);
    }
    assert.ok(result.text.length > 0, 'ideas returned no text');
    assert.ok(Number.isFinite(ms));
  });
});
