// Provider times of headlines. A feed date that cannot be read stays unknown (it is never replaced with the fetch time), and
// a date further ahead than FUTURE_SLACK_MS is a feed's time zone error (local time labelled UTC, seen up to 33 h ahead), so
// it is unknown too: either would otherwise rank as the newest headline in every time-ordered list.
export const FUTURE_SLACK_MS = 15 * 60 * 1000;

/** ISO time of a provider date (RFC 822, ISO 8601 or GDELT's compact form), or null for an unreadable or impossible one. */
export function sourceTimestamp(raw) {
  if (!raw) return null;
  const compact = String(raw).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact && (Number(compact[4]) > 23 || Number(compact[5]) > 59 || Number(compact[6]) > 59)) return null;
  const value = compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : raw;
  const calendar = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (calendar) {
    const day = new Date(`${calendar[1]}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== calendar[1]) return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** sourceTimestamp, and null as well for a time more than FUTURE_SLACK_MS after `now`. */
export function feedTimestamp(raw, now = Date.now()) {
  const iso = sourceTimestamp(raw);
  return iso && Date.parse(iso) <= now + FUTURE_SLACK_MS ? iso : null;
}
