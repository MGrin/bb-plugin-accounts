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
export function pickBest(accounts: AccountUsage[], exceptSlot: string): AccountUsage | null {
  const candidates = accounts
    .filter((a) => a.slot !== exceptSlot && a.fiveHour !== null && (a.sevenDay ?? 0) < 100)
    .sort((a, b) => worst(a) - worst(b) || a.slot.localeCompare(b.slot));
  return candidates[0] ?? null;
}

/**
 * Decide whether to switch, and why.
 *
 * `sinceLastSwitchSec` is Infinity when nothing has switched yet. The two
 * cooldowns are deliberately different: an URGENT move only waits out the short
 * one, because a stalled thread costs more than a churned Keychain, while a
 * SPREAD move waits out the long one, because it is an optimization and
 * optimizations must not thrash.
 */
export function decideSwitch(
  accounts: AccountUsage[],
  policy: SwitchPolicy,
  sinceLastSwitchSec: number,
): SwitchDecision {
  if (sinceLastSwitchSec < policy.cooldownSec) {
    return { action: "none", reason: `cooldown (${Math.round(sinceLastSwitchSec)}s < ${policy.cooldownSec}s)` };
  }
  const active = accounts.find((a) => a.active);
  if (!active) return { action: "none", reason: "no active account in the usage cache" };

  const best = pickBest(accounts, active.slot);
  if (!best) return { action: "none", reason: "no eligible alternative slot" };

  const activeFive = active.fiveHour ?? 0;
  if (activeFive >= policy.switchAt) {
    // Only move if the destination is actually better on its worst window —
    // otherwise this is a switch into the same wall, one slot over.
    if (worst(best) >= activeFive) {
      return { action: "none", reason: `active at ${activeFive}% but ${best.slot} is no better (${worst(best)}%)` };
    }
    return {
      action: "urgent",
      to: best.slot,
      reason: `proactive: 5h ${activeFive}% >= ${policy.switchAt}% (best alternative ${best.slot} at ${worst(best)}%)`,
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
