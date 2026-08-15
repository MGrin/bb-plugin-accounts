// Where should new work START?
//
// Switching is REACTIVE: it moves a thread once the active account is nearly
// spent. Placement is the other half — choosing the landing site before any
// tokens are burned. On 2026-08-15 that distinction stopped being theoretical:
// two of four accounts sat at 7d 100%, the active one was at 5h 98%, and
// exactly one account had room. Where the next spawn lands decided whether work
// continued at all.
//
// Pure by convention: every database read happens in server.ts and arrives here
// as plain data.

export interface PlacementAccount {
  slot: string;
  /** 0..100, or null when the poller has not seen this account yet. */
  fiveUtil: number | null;
  /** 0..100, or null. */
  sevenUtil: number | null;
  active: boolean;
}

export interface PlacementArgs {
  accounts: readonly PlacementAccount[];
  /**
   * Utilisation points this model costs per unit of work, from the model_weight
   * calibration. Measured on this machine: fable 0.1, other 0.02, haiku 0.00606,
   * sonnet 0.00169, opus 0.00116 — Fable costs ~86x Opus.
   */
  modelWeight: number;
  /** The auto-switch threshold. An account already past it is not a landing site. */
  switchAt?: number;
  /** Work must fit at least this many units, or the slot is not worth starting on. */
  minUnits?: number;
}

export interface Placement {
  slot: string | null;
  /** Usable headroom in utilisation points, bounded by BOTH windows. */
  headroom: number;
  /** How many units of this model that headroom buys. */
  units: number;
  reason: string;
}

export const DEFAULT_SWITCH_AT = 97;
export const DEFAULT_MIN_UNITS = 20;

/**
 * Usable headroom is the MINIMUM of the two windows, never the 5-hour figure
 * alone. An account at 5h 0% and 7d 100% looks completely free and can do
 * nothing — that is exactly the state two accounts were in when this was
 * written, and reading only the 5h window would have routed work straight into
 * a wall.
 */
export function usableHeadroom(a: PlacementAccount, switchAt: number): number {
  const five = a.fiveUtil ?? 100;
  const seven = a.sevenUtil ?? 100;
  return Math.max(0, Math.min(switchAt - five, 100 - seven));
}

/**
 * Best FIT, not most room: among slots that can hold the work, take the
 * tightest. Cheap models (haiku at 0.006) then consume nearly-capped accounts,
 * which leaves the roomy ones intact for the models that cannot fit anywhere
 * else. Taking the emptiest account every time spends the scarce resource —
 * large contiguous headroom — on work that never needed it.
 */
export function placeWork(args: PlacementArgs): Placement {
  const switchAt = args.switchAt ?? DEFAULT_SWITCH_AT;
  const minUnits = args.minUnits ?? DEFAULT_MIN_UNITS;
  const weight = args.modelWeight > 0 ? args.modelWeight : Number.POSITIVE_INFINITY;

  const scored = args.accounts
    .map((a) => {
      const headroom = usableHeadroom(a, switchAt);
      return { a, headroom, units: headroom / weight };
    })
    .filter((s) => s.headroom > 0);

  if (scored.length === 0) {
    return {
      slot: null,
      headroom: 0,
      units: 0,
      reason: "no account has headroom in both windows — every slot is at a cap",
    };
  }

  const fits = scored.filter((s) => s.units >= minUnits);
  const pool = fits.length > 0 ? fits : scored;
  // Tightest fit first; ties go to the slot with more weekly budget left, since
  // the 5-hour window refills and the weekly one does not.
  const best = [...pool].sort(
    (x, y) => x.units - y.units || (x.a.sevenUtil ?? 100) - (y.a.sevenUtil ?? 100),
  )[0];

  return {
    slot: best.a.slot,
    headroom: best.headroom,
    units: best.units,
    reason:
      fits.length > 0
        ? `tightest slot that fits ${minUnits}+ units (${best.headroom.toFixed(0)} pts headroom)`
        : `nothing fits ${minUnits} units; most capacity available is ${best.units.toFixed(0)}`,
  };
}
