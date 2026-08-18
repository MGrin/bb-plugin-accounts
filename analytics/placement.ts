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

import { modelFamily, SEED_PRIORS } from "./calibrate.ts";

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
  /**
   * The 7-day wall, mirroring the plugin's `weeklyAt` setting. 100 by default
   * because the weekly window is the scarce resource and gets ridden to the
   * last point — see the weeklyAt doc in lib.ts. Taking it as an argument
   * rather than hardcoding 100 is what keeps placement and decideSwitch from
   * disagreeing about which accounts are legal destinations.
   */
  weeklyAt?: number;
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
export const DEFAULT_WEEKLY_AT = 100;
export const DEFAULT_MIN_UNITS = 20;

/**
 * Usable headroom is the MINIMUM of the two windows, never the 5-hour figure
 * alone. An account at 5h 0% and 7d 100% looks completely free and can do
 * nothing — that is exactly the state two accounts were in when this was
 * written, and reading only the 5h window would have routed work straight into
 * a wall.
 */
export function usableHeadroom(
  a: PlacementAccount,
  switchAt: number,
  weeklyAt: number = DEFAULT_WEEKLY_AT,
): number {
  const five = a.fiveUtil ?? 100;
  const seven = a.sevenUtil ?? 100;
  return Math.max(0, Math.min(switchAt - five, weeklyAt - seven));
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
  const weeklyAt = args.weeklyAt ?? DEFAULT_WEEKLY_AT;
  const minUnits = args.minUnits ?? DEFAULT_MIN_UNITS;
  const weight = args.modelWeight > 0 ? args.modelWeight : Number.POSITIVE_INFINITY;

  const scored = args.accounts
    .map((a) => {
      const headroom = usableHeadroom(a, switchAt, weeklyAt);
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

/**
 * Points-per-unit for a concrete model id, from the fitted `model_weight`
 * table, falling back to the seed priors.
 *
 * bb hands out ids like `claude-opus-5[1m]` and `claude-haiku-4-5-20251001`;
 * the calibration is fitted per FAMILY for the reason modelFamily documents, so
 * the lookup has to collapse the id first. An unknown family lands on `other`,
 * which is deliberately expensive (0.02) — guessing cheap would route an
 * unmeasured model onto scraps.
 */
export function weightForModel(
  model: string | null | undefined,
  weights: Readonly<Record<string, number>>,
): number {
  const family = modelFamily(model);
  const fitted = weights[family];
  if (typeof fitted === "number" && fitted > 0) return fitted;
  return SEED_PRIORS[family] ?? SEED_PRIORS.other!;
}

export type PlacementPlan =
  | { action: "none"; to: null; reason: string }
  | { action: "switch"; to: string; reason: string }
  | { action: "warn"; to: string | null; reason: string };

export interface PlacementPlanArgs extends PlacementArgs {
  /** The slot the machine is billing right now, or null when unknown. */
  activeSlot: string | null;
  /**
   * True when the active slot is an EXPLICIT choice — a human ran
   * `bb accounts switch`, or asked for a placement switch by hand — recently
   * enough that it still stands.
   */
  activePinned?: boolean;
  /** Model id, for the message only. The weight is passed separately. */
  model?: string;
}

/**
 * Should the machine move BEFORE this work starts, and is it allowed to?
 *
 * Two rules, and they are the whole design:
 *
 * 1. PLACEMENT ONLY MOVES WORK OFF A WALL, never toward a merely roomier
 *    account. If the active slot can hold the work, the answer is `none` even
 *    when something else has ten times the headroom. Spreading load across
 *    slots is already decideSwitch's job (spreadMargin, its own cooldown), and
 *    a second opinion firing on every thread creation would fight it.
 *
 * 2. AN EXPLICIT CHOICE IS NEVER SILENTLY OVERRIDDEN. When a human put the
 *    machine on this account and it turns out to be a bad landing site, the
 *    answer is `warn`, carrying the slot that would have been chosen — say the
 *    choice looks wrong, do not quietly re-route around it. A switch that
 *    undoes a deliberate act, logged only where nobody reads, is the
 *    green-that-lies pattern: the caller believes it is on the account it
 *    picked, and every conclusion after that is drawn about the wrong slot.
 */
export function planPlacement(args: PlacementPlanArgs): PlacementPlan {
  const switchAt = args.switchAt ?? DEFAULT_SWITCH_AT;
  const weeklyAt = args.weeklyAt ?? DEFAULT_WEEKLY_AT;
  const minUnits = args.minUnits ?? DEFAULT_MIN_UNITS;
  const weight = args.modelWeight > 0 ? args.modelWeight : Number.POSITIVE_INFINITY;
  const what = args.model ? `${args.model} work` : "this work";

  const active = args.accounts.find((a) => a.slot === args.activeSlot) ?? null;
  const activeUnits = active ? usableHeadroom(active, switchAt, weeklyAt) / weight : 0;
  if (active && activeUnits >= minUnits) {
    return {
      action: "none",
      to: null,
      reason: `active ${active.slot} holds ${activeUnits.toFixed(0)} units of ${what} (floor ${minUnits}) — placement does not move work off a slot that fits`,
    };
  }

  const best = placeWork(args);
  const short = active
    ? `active ${active.slot} holds only ${activeUnits.toFixed(0)} units of ${what}`
    : `no active slot in the usage cache`;

  if (best.slot === null) {
    return { action: "warn", to: null, reason: `${short}, and ${best.reason}` };
  }
  if (best.slot === args.activeSlot) {
    return {
      action: "none",
      to: null,
      reason: `${short}, but it is still the best available — ${best.reason}`,
    };
  }
  const move = `${best.slot} holds ${best.units.toFixed(0)} (${best.headroom.toFixed(0)} pts)`;
  if (args.activePinned) {
    return {
      action: "warn",
      to: best.slot,
      reason: `${short}; ${move}. NOT switching: ${args.activeSlot} was chosen explicitly`,
    };
  }
  return { action: "switch", to: best.slot, reason: `placement: ${short}; ${move}` };
}
