// Formatting shared by the homepage tiles and the big usage page.
//
// It lives in its own module for two reasons. One, two copies of "how do we
// render a percentage" is how the two surfaces end up disagreeing about the
// same number. Two — and this is the one that matters — the null cases are a
// correctness decision, not a cosmetic one, so they get tests: a `util` of
// null rendered as 0% reads as "this account is completely free" and is the
// exact inverse of the truth. Nothing here may substitute a zero for an
// absence.

/** Absolute time, day included. `null` is an absence, not an epoch. */
export const clock = (ts: number | null): string =>
  ts === null
    ? "—"
    : new Date(ts * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

/**
 * The same, for a millisecond epoch. It exists because passing `Date.now()`
 * to `clock()` silently renders a date around the year 58620 — and `clock()`
 * deliberately omits the year, so the only visible symptom is a plausible
 * wrong month. The plugin stores `polledAt` in SECONDS and `last-switch.at`
 * in MILLISECONDS, so the unit has to be in the function name.
 */
export const clockMs = (ms: number | null): string => (ms === null ? "—" : clock(Math.floor(ms / 1000)));

const hhmm = (d: Date): string => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * A utilization percentage. An unpolled account is UNKNOWN — never 0%.
 * The whole point of the page is telling "I have all my quota" apart from
 * "I have no idea how much quota I have".
 */
export const formatPct = (util: number | null | undefined): string =>
  util === null || util === undefined || !Number.isFinite(util) ? "unknown" : `${Math.round(util)}%`;

/**
 * "in 4h 20m" — the form that answers "can I start this now", which is the
 * question actually being asked of a reset time.
 */
export function formatRelative(ms: number): string {
  if (ms <= 0) return "due now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const restMins = mins % 60;
  if (hours < 24) return restMins === 0 ? `in ${hours}h` : `in ${hours}h ${restMins}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `in ${days}d` : `in ${days}d ${restHours}h`;
}

/**
 * Both forms of a reset instant, from the ISO string the poller cache carries.
 * `null` in, `null` out — a missing reset time is reported as missing rather
 * than guessed at, same rule as the percentage.
 */
export function formatReset(iso: string | null | undefined, nowMs: number): { at: string; rel: string } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const at = new Date(t);
  const now = new Date(nowMs);
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return { at: sameDay ? hhmm(at) : clock(Math.floor(t / 1000)), rel: formatRelative(t - nowMs) };
}
