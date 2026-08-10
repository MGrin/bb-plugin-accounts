// The switch decision, as a pure function.
//
// It used to live inside the 2-minute cron callback, tangled with kv reads and
// an execFile — which meant the one piece of logic that decides, unattended and
// all night, which Claude account your work bills to could not be exercised at
// all. Everything I/O-shaped stays in server.ts; everything judgement-shaped is
// here, where `node --test` can ask it awkward questions.

export interface AccountUsage {
  slot: string;
  active: boolean;
  /** Percent utilization of the rolling 5-hour window, null when unknown. */
  fiveHour: number | null;
  /** Percent utilization of the 7-day window, null when unknown. */
  sevenDay: number | null;
}

export interface SwitchPolicy {
  /** 5h % at which the active slot must be abandoned before it 429s. */
  switchAt: number;
  /** Points of max(5h,7d) another slot must be roomier by to switch early. 0 disables. */
  spreadMargin: number;
  /** Seconds since the last switch below which no switch may happen at all. */
  cooldownSec: number;
  /** Seconds since the last switch below which only an URGENT switch may happen. */
  spreadCooldownSec: number;
  /**
   * 7d % at which the active slot must be abandoned. Deliberately LOWER than
   * switchAt: a 5-hour window can be waited out, a weekly one resets on a
   * calendar date. Also caps which slots may be switched INTO.
   */
  weeklyAt?: number;
  /** Seconds ahead the burn rate is projected. Matches the poller's interval. */
  pollIntervalSec?: number;
}

const WEEKLY_AT = 95;
const POLL_INTERVAL_S = 180;

/** The previous 5h reading for the SAME slot, for measuring a burn rate. */
export interface PrevSample {
  slot: string;
  fiveHour: number;
  polledAt: number;
}

/** Current sample time plus the prior reading, when one exists. */
export interface VelocityInput {
  polledAt: number;
  prev: PrevSample | null;
}

export type SwitchDecision =
  | { action: "none"; reason: string }
  | { action: "urgent" | "spread"; to: string; reason: string };

/**
 * How soon a slot trips, as the WORSE of its two windows.
 *
 * Scoring on one window hides the other: a slot quiet right now but nearly out
 * of week outranked a genuinely roomy one, which is how a switch INTO an
 * exhausted account happened on 2026-08-09. An unknown window counts as 0 —
 * `null` means the poll failed, and candidates with a failed 5h poll are
 * excluded upstream rather than guessed at here.
 */
export const worst = (a: AccountUsage): number => Math.max(a.fiveHour ?? 0, a.sevenDay ?? 0);

/**
 * Best slot to move to: lowest worst(), excluding the current one, anything
 * whose 5h is unknown (an unpolled account only LOOKS free), and anything whose
 * week is spent (switching in trips again on the next poll).
 */
export function pickBest(
  accounts: AccountUsage[],
  exceptSlot: string,
  weeklyAt: number = WEEKLY_AT,
): AccountUsage | null {
  const candidates = accounts
    .filter((a) => a.slot !== exceptSlot && a.fiveHour !== null && (a.sevenDay ?? 0) < weeklyAt)
    .sort((a, b) => worst(a) - worst(b) || a.slot.localeCompare(b.slot));
  return candidates[0] ?? null;
}

/**
 * Points per second the active slot's 5h window is burning, or null when that
 * cannot be known.
 *
 * `prev.slot` is load-bearing. A switch resets the series: two accounts'
 * readings are not one sequence, and subtracting across a switch invents a burn
 * rate out of unrelated numbers. Python guards this the same way, by only
 * carrying `_prev_five_hour` forward when the active slot is unchanged.
 *
 * A single reading has no rate. A falling rate is not a rate worth acting on —
 * only an upward burn can hit a wall.
 */
function burnRate(activeSlot: string, activeFive: number, v: VelocityInput | undefined): number | null {
  if (!v?.prev || v.prev.slot !== activeSlot) return null;
  const dt = v.polledAt - v.prev.polledAt;
  if (!(dt > 0)) return null;
  const rate = (activeFive - v.prev.fiveHour) / dt;
  return rate > 0 ? rate : null;
}

/**
 * Decide whether to switch, and why.
 *
 * `sinceLastSwitchSec` is Infinity when nothing has switched yet. The two
 * cooldowns are deliberately different: an URGENT move only waits out the short
 * one, because a stalled thread costs more than a churned Keychain, while a
 * SPREAD move waits out the long one, because it is an optimization and
 * optimizations must not thrash.
 *
 * Three things make a move URGENT, and each was bought with an outage:
 *  - BURST: 5h at or past switchAt.
 *  - WEEKLY: 7d at or past weeklyAt. 2026-07-31 — active sat at 7d 100% / 5h 13%
 *    with two idle slots, and a fresh-looking 5-hour window kept a dead account
 *    in place because only spread could move it.
 *  - VELOCITY: the burn rate says the NEXT sample lands past switchAt.
 *    2026-08-09 — read 90% and was walled before the next 180s poll. A static
 *    threshold assumes the next sample arrives in time; a fast fleet means it
 *    does not.
 */
export function decideSwitch(
  accounts: AccountUsage[],
  policy: SwitchPolicy,
  sinceLastSwitchSec: number,
  velocity?: VelocityInput,
): SwitchDecision {
  if (sinceLastSwitchSec < policy.cooldownSec) {
    return { action: "none", reason: `cooldown (${Math.round(sinceLastSwitchSec)}s < ${policy.cooldownSec}s)` };
  }
  const active = accounts.find((a) => a.active);
  if (!active) return { action: "none", reason: "no active account in the usage cache" };

  const weeklyAt = policy.weeklyAt ?? WEEKLY_AT;
  const horizon = policy.pollIntervalSec ?? POLL_INTERVAL_S;

  const best = pickBest(accounts, active.slot, weeklyAt);
  if (!best) return { action: "none", reason: "no eligible alternative slot" };

  const activeFive = active.fiveHour ?? 0;
  const activeSeven = active.sevenDay ?? 0;
  const rate = burnRate(active.slot, activeFive, velocity);
  const projected = rate === null ? null : activeFive + rate * horizon;

  let why: string | null = null;
  if (activeSeven >= weeklyAt) {
    why = `7d ${activeSeven}% >= ${weeklyAt}% (a week does not wait out)`;
  } else if (activeFive >= policy.switchAt) {
    why = `5h ${activeFive}% >= ${policy.switchAt}%`;
  } else if (projected !== null && projected >= policy.switchAt) {
    why = `velocity: 5h ${activeFive}% projected ~${projected.toFixed(0)}% >= ${policy.switchAt}% by next poll`;
  }

  if (why !== null) {
    // Only move if the destination is actually better on its worst window —
    // otherwise this is a switch into the same wall, one slot over.
    if (worst(best) >= worst(active)) {
      return { action: "none", reason: `active at ${worst(active)}% but ${best.slot} is no better (${worst(best)}%)` };
    }
    return {
      action: "urgent",
      to: best.slot,
      reason: `proactive: ${why} (best alternative ${best.slot} at ${worst(best)}%)`,
    };
  }

  if (!(policy.spreadMargin > 0)) return { action: "none", reason: "spread disabled" };
  const gap = worst(active) - worst(best);
  if (gap < policy.spreadMargin) {
    return { action: "none", reason: `gap ${gap} < margin ${policy.spreadMargin}` };
  }
  if (sinceLastSwitchSec < policy.spreadCooldownSec) {
    return {
      action: "none",
      reason: `spread cooldown (${Math.round(sinceLastSwitchSec)}s < ${policy.spreadCooldownSec}s)`,
    };
  }
  return {
    action: "spread",
    to: best.slot,
    reason: `spread: ${active.slot} at max(5h,7d)=${worst(active)}% vs ${best.slot} at ${worst(best)}% (gap ${gap} >= ${policy.spreadMargin})`,
  };
}

/**
 * Does this thread.failed error mean "this account is out of window", as
 * opposed to any of the thousand other ways a thread dies?
 *
 * This is the trigger for the entire reactive path, and it lived as an
 * un-exercised literal in server.ts until 2026-08-10, when Anthropic's wording
 * ("You've hit your session limit · resets 6pm") matched none of its branches
 * and six threads sat stopped while two accounts idled. The lesson is not "add
 * session" — it is that the vocabulary is the vendor's to change, so the match
 * has to be broad on the ways a limit can be phrased and narrow only on the
 * word `limit`/`quota`/`429` itself. False positives cost one wasted switch;
 * false negatives cost a night.
 */
export function isLimitError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /rate.?limit|usage.?limit|session.?limit|weekly.?limit|429|subscription.*(limit|window)|out of.*(quota|usage)|hit your.*limit|reached your.*limit|limit.*resets/i
    .test(error);
}
