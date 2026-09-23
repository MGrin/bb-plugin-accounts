// Provider adapters for the one account card (MX-1226).
//
// Pure, and deliberately separate from the card: this is where each provider's own
// vocabulary is translated into the shared one, and it is the part worth testing
// exhaustively — a wrong `state` here is how a dead account reads as a healthy one.
//
// The rule both adapters obey: `unreadable` is not an amount. A stale poll, a failed
// refresh or a missing window is `unreadable`, never 0% and never `walled`.
import type { CardAccount, CardWindow } from "./account-card.tsx";
import type { ProviderAccount } from "../telemetry.ts";
import type { Status } from "./current.tsx";
import { clock, formatReset } from "./format.ts";

/** A window is spent when the provider says 100, not when we failed to read it. */
const spent = (w: { usedPercent: number | null }) => w.usedPercent !== null && w.usedPercent >= 100;

function resetTextFromIso(iso: string | null, nowMs: number): string | null {
  const r = formatReset(iso, nowMs);
  return r === null ? null : `resets ${r.at} · ${r.rel}`;
}

/**
 * Claude accounts, from the `status` RPC.
 *
 * `stale` is the poll-level verdict and it applies to EVERY account in the read: the
 * cache is written whole, so one account cannot be fresher than another.
 */
export function claudeCards(status: Status | null, nowMs: number): CardAccount[] {
  if (!status) return [];
  return status.accounts.map((a) => {
    const windows: CardWindow[] = [
      { label: "5h", usedPercent: a.fiveHour, resetsAt: null, resetText: resetTextFromIso(a.fiveHourResetsAt, nowMs) },
      { label: "7d", usedPercent: a.sevenDay, resetsAt: null, resetText: resetTextFromIso(a.sevenDayResetsAt, nowMs) },
    ];
    const unreadable = status.stale || windows.every((w) => w.usedPercent === null);
    return {
      provider: "Claude" as const,
      label: a.email || "Claude account (identity unavailable)",
      active: a.active,
      state: unreadable ? "unreadable" : windows.some(spent) ? "walled" : "ok",
      stateNote: unreadable
        ? status.stale
          ? "poll is stale"
          : "no window was read"
        : windows.some(spent)
          ? `${windows.filter(spent).map((w) => w.label).join(" and ")} spent`
          : null,
      windows,
    };
  });
}

/** Codex accounts, from the `telemetry` RPC. Its windows already carry epoch resets. */
export function codexCards(accounts: readonly ProviderAccount[]): CardAccount[] {
  return accounts.map((a) => {
    const main = a.windows.filter((w) => w.bucket === "codex");
    const windows: CardWindow[] = main.map((w) => ({
      label: w.durationMinutes === 10080 ? "7d" : w.durationMinutes === 300 ? "5h" : w.durationMinutes ? `${w.durationMinutes / 60}h` : "usage",
      usedPercent: a.fresh ? w.usedPercent : null,
      resetsAt: w.resetsAt,
      resetText: w.resetsAt === null ? null : `resets ${clock(w.resetsAt)}`,
    }));
    const unreadable = !a.fresh || a.capacity === "unknown" || windows.every((w) => w.usedPercent === null);
    return {
      provider: "Codex" as const,
      label: a.email ?? "Codex account (identity unavailable)",
      // Codex has one subscription on this machine and no switching, so there is no
      // "active" to claim. Claiming one would invent a distinction Claude has and it
      // does not.
      active: false,
      state: unreadable ? "unreadable" : windows.some(spent) || a.capacity === "exhausted" ? "walled" : "ok",
      stateNote: unreadable
        ? a.fresh
          ? "subscription usage unknown"
          : "reading unavailable or stale"
        : windows.some(spent) || a.capacity === "exhausted"
          ? "window spent"
          : null,
      windows,
    };
  });
}
