// Formatting shared by the homepage tiles and the big usage page.
//
// It lives in its own module for two reasons. One, two copies of "how do we
// render a percentage" is how the two surfaces end up disagreeing about the
// same number. Two — and this is the one that matters — the null cases are a
// correctness decision, not a cosmetic one, so they get tests: a `util` of
// null rendered as 0% reads as "this account is completely free" and is the
// exact inverse of the truth. Nothing here may substitute a zero for an
// absence.

import type { CapacityVerdict, CreditSpend, CreditState } from "../lib.ts";

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

/**
 * What the machine can serve, as one line the panel can show (MX-220).
 *
 * The verdict is NOT computed here. `capacity` arrives on the `status` RPC
 * straight from `capacityOf()` in server.ts — the same call `bb accounts
 * outage` and the recovery sweeper read — so the panel, the CLI and the
 * Übersicht widget cannot disagree about whether this machine is working.
 * Deriving it a second time in TSX from `credits` and the two windows is
 * exactly the drift this replaces, and it would be invisible: three surfaces
 * agreeing is how a reader decides which one to believe.
 *
 * The state that matters is `paid-only`: every free window spent with credits
 * open. It looks like an outage to anything that only counts windows, and it
 * is not one — the machine serves, and it BILLS. Rendering it as exhausted
 * stops work that could run; rendering it as plain "available" spends money
 * with nothing on screen saying so.
 *
 * `unknown` gets its own tone rather than being folded into either extreme,
 * the same rule as a null utilization and as `exit 2` on the CLI: a stale poll
 * or an unreadable account asserts nothing.
 */
export type CapacityNotice = { tone: "warn" | "bad" | "unknown"; text: string } | null;

export function capacityNotice(capacity: CapacityVerdict): CapacityNotice {
  switch (capacity) {
    case "paid-only":
      return { tone: "warn", text: "No free window on any account — work here BILLS to usage credits." };
    case "none":
      return { tone: "bad", text: "Every account is walled and no credits are enabled — nothing can serve." };
    case "unknown":
      return {
        tone: "unknown",
        text: "Cannot tell whether this machine can serve — the usage cache is stale or an account could not be read.",
      };
    default:
      return null;
  }
}

/**
 * One account's usage-credit state, three-valued like everything else here.
 *
 * `on` shows the amount, `off` shows NOTHING (the common case, and a label on
 * every row would bury the one row that matters), `unknown` shows `credits ?`.
 * The last one is the rule that costs something to get wrong: a poll that
 * failed knows nothing about credits, and rendering that silence as "off"
 * downgrades a possibly-usable account to exhausted on screen.
 *
 * Amounts are MAJOR currency units — the poller scales `extra_usage` by its
 * `decimal_places` before the plugin ever sees it, so a raw 7462 has already
 * become 74.62 here.
 */
export function creditLabel(credits: CreditState, spend: CreditSpend | null | undefined): string | null {
  if (credits === "off") return null;
  if (credits === "unknown") return "credits ?";
  if (!spend || spend.used === null) return "credits on";
  const cap = spend.limit === null ? "" : `/${spend.limit.toFixed(2)}`;
  return `credits ${spend.used.toFixed(2)}${cap}${spend.currency ? ` ${spend.currency}` : ""}`;
}
