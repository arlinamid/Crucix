// The bots' /brief: one builder for Telegram (legacy Markdown) and Discord. Alerts below a bot's minimum tier are
// listed here instead of being sent on their own; /brief <topic> adds the sweep's events that mention the topic.

import { safeLink } from './evidence.mjs';

const STYLES = Object.freeze({
  // Legacy Markdown treats only these as markup.
  telegram: { strong: text => `*${text}*`, em: text => `_${text}_`, esc: tgEscape, url: tgEscape },
  discord: { strong: text => `**${text}**`, em: text => `_${text}_`, esc: text => String(text).replace(/([\\*_~`|>\[\]()])/g, '\\$1'), url: text => `<${text}>` },
});

function tgEscape(text) {
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

const TIER_EMOJI = { FLASH: '🔴', PRIORITY: '🟡', ROUTINE: '🔵' };

function line(value, max) {
  const text = String(value ?? '').replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The topic as at most 60 characters of words, or null. */
export function briefTopic(raw) {
  const topic = line(raw, 60).toLowerCase();
  return topic.length >= 2 ? topic : null;
}

export function buildBotBrief({ data, delta = null, held = [], topic = null, style = 'telegram', now = Date.now() } = {}) {
  const fmt = STYLES[style] ?? STYLES.telegram;
  if (!data) return '⏳ No data yet — waiting for first sweep to complete.';
  const tg = data.tg || {};
  const energy = data.energy || {};
  const metals = data.metals || {};
  const ideas = (data.ideas || []).slice(0, 3);
  const sections = [fmt.strong('📋 CRUCIX BRIEF'), fmt.em(`${new Date(now).toISOString().replace('T', ' ').substring(0, 19)} UTC`), ''];

  if (delta?.summary) {
    const direction = String(delta.summary.direction || 'mixed');
    const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', mixed: '↔️' }[direction] || '↔️';
    sections.push(`${dirEmoji} Direction: ${fmt.strong(direction.toUpperCase())} | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical`, '');
  }

  const vix = data.fred?.find(f => f.id === 'VIXCLS');
  const hy = data.fred?.find(f => f.id === 'BAMLH0A0HYM2');
  if (vix || energy.wti || metals.gold || metals.silver) {
    sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
    sections.push(`   Gold: $${metals.gold || '--'} | Silver: $${metals.silver || '--'}${hy ? ` | HY Spread: ${hy.value}` : ''}`);
    sections.push(`   NatGas: $${energy.natgas || '--'}`, '');
  }

  if (tg.urgent?.length > 0) {
    sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
    for (const post of tg.urgent.slice(0, 2)) sections.push(`  • ${fmt.esc(line(post.text, 80))}`);
    sections.push('');
  }

  if (held.length) {
    sections.push(fmt.strong(`🗂️ Held alerts (${held.length}):`));
    for (const alert of held.slice(-5)) {
      const link = alert.evidence?.find(item => item.url)?.url;
      sections.push(`  ${TIER_EMOJI[alert.tier] || '⚪'} ${fmt.esc(line(alert.headline, 120))}${link ? `\n    ${fmt.url(link)}` : ''}`);
    }
    sections.push('');
  }

  if (topic) {
    const events = Array.isArray(data.events) ? data.events : [];
    const matches = events.filter(event => typeof event?.title === 'string'
      && `${event.title} ${event.location?.label ?? ''}`.toLowerCase().includes(topic)).slice(0, 5);
    sections.push(fmt.strong(`🔎 ${fmt.esc(topic)}: ${matches.length ? `${matches.length} items` : 'nothing in the latest sweep'}`));
    for (const event of matches) {
      const url = safeLink(event.source?.url);
      sections.push(`  • ${fmt.esc(line(event.title, 140))}${url ? `\n    ${fmt.url(url)}` : ''}`);
    }
    sections.push('');
  }

  if (ideas.length > 0) {
    sections.push(fmt.strong('💡 Top Ideas:'));
    for (const idea of ideas) sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${fmt.esc(line(idea.title, 120))}`);
  }

  return sections.join('\n').trimEnd();
}
