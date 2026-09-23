// ONE account card, for every provider (MX-1226).
//
// Claude and Codex each had their own component, their own field order and their own
// words for the same thing — "22% / resets 12:59 PM" against "29% used / Resets Sep 28",
// a dot-and-badge header against a bare email line. Two renderers for one concept drift,
// and mgrin read them side by side on one page and could not compare them.
//
// What the card fixes, and therefore what it must not grow back:
//  - the SAME fields in the SAME order: account, then one row per window, then state.
//  - a null is never a zero. That rule lives in Meter and in `formatPct`; this file must
//    not invent a percentage of its own.
//  - "walled" and "unreadable" are different answers. A 100%-spent window is a fact about
//    the subscription; a poll that failed knows nothing, and showing it as spent is the
//    inverse of the truth.
//
// Providers reach it through an adapter (`claudeCards`, `codexCards`) rather than by
// rendering their own thing, so a new provider is a new adapter and not a new card.
import type { ReactNode } from "react";
import { Meter } from "./ui.tsx";

/** One window of a subscription, already normalized by its provider's adapter. */
export type CardWindow = {
  /** "5h", "7d", "Weekly" — short, because it is a column, not a sentence. */
  label: string;
  usedPercent: number | null;
  /** Epoch SECONDS, or null when the provider did not say. */
  resetsAt: number | null;
  /** Rendered reset text, provider-formatted ("resets 12:59 PM · in 2h 15m"). */
  resetText: string | null;
};

export type CardAccount = {
  provider: "Claude" | "Codex";
  /** The email. Never a UUID and never an internal slot id. */
  label: string;
  active: boolean;
  /**
   * `ok` — the provider answered and there is headroom.
   * `walled` — it answered and a window is spent.
   * `unreadable` — nothing was read: stale, failed or never polled. NOT an amount.
   */
  state: "ok" | "walled" | "unreadable";
  /** Why, when the state is not `ok`. One short clause. */
  stateNote: string | null;
  windows: CardWindow[];
  details?: ReactNode;
};

const STATE_TEXT: Record<CardAccount["state"], string> = {
  ok: "ok",
  walled: "walled",
  unreadable: "unreadable",
};

const STATE_CLASS: Record<CardAccount["state"], string> = {
  ok: "text-muted-foreground",
  walled: "text-destructive",
  // Muted on purpose: an unread account asserts nothing and must not borrow the urgency
  // of a real wall.
  unreadable: "italic text-muted-foreground",
};

function WindowRow({ window: w }: { window: CardWindow }) {
  const unknown = w.usedPercent === null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{w.label}</span>
      <span
        className={`w-12 shrink-0 text-right text-xs tabular-nums ${
          unknown ? "italic text-muted-foreground" : "text-foreground"
        }`}
      >
        {unknown ? "unknown" : `${Math.round(w.usedPercent!)}%`}
      </span>
      <div className="min-w-16 flex-1">
        <Meter value={w.usedPercent} label={`${w.label} usage`} />
      </div>
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {w.resetText ?? "reset time unknown"}
      </span>
    </div>
  );
}

export function AccountCard({ account: a }: { account: CardAccount }) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {a.provider}
        </span>
        <span className="text-sm text-foreground">{a.label}</span>
        {a.active && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
            active
          </span>
        )}
        <span className={`ml-auto text-xs ${STATE_CLASS[a.state]}`}>
          {STATE_TEXT[a.state]}
          {a.stateNote ? ` · ${a.stateNote}` : ""}
        </span>
      </div>
      {a.windows.map((w) => (
        <WindowRow key={`${a.provider}/${a.label}/${w.label}`} window={w} />
      ))}
      {a.details ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <div className="mt-2 space-y-2">{a.details}</div>
        </details>
      ) : null}
    </div>
  );
}
