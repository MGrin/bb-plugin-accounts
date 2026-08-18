// Current per-account usage — the thing looked at DAILY, which is why it sits
// at the top of the page and the forecast sits below it.
//
// Everything here already exists in the `status` RPC; the big page simply
// never asked for it, which is why the only way to see 5h/7d per account was
// the Übersicht desktop widget. This is rendering, not collection.
//
// Two rules the rest of the file is built around:
//  - A null NEVER renders as a zero. An unpolled account showing 0% reads as
//    "completely free" and is the exact inverse of the truth. Same for a
//    missing reset time. See app/format.ts.
//  - It must not be FROZEN at page load. The panel's other effect only re-runs
//    when the range changes, so this polls on its own 30s timer (the same
//    cadence as the homepage tiles) and tears the timer down on unmount.
import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { clock, clockMs, formatPct, formatReset } from "./format.ts";
import { Meter, Section } from "./ui.tsx";

export type Status = {
  polledAt: number | null;
  stale: boolean;
  accounts: {
    slot: string;
    email: string;
    active: boolean;
    fiveHour: number | null;
    sevenDay: number | null;
    fiveHourResetsAt: string | null;
    sevenDayResetsAt: string | null;
  }[];
  lastSwitch: { at: number; from: string; to: string; reason: string } | null;
};

const POLL_MS = 30_000;

function Window({
  label,
  window: name,
  util,
  resetsAt,
  now,
}: {
  label: string;
  window: string;
  util: number | null;
  resetsAt: string | null;
  now: number;
}) {
  const reset = formatReset(resetsAt, now);
  const unknown = util === null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-6 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={`w-16 shrink-0 text-right text-xs tabular-nums ${
          unknown ? "italic text-muted-foreground" : "text-foreground"
        }`}
      >
        {formatPct(util)}
      </span>
      <div className="min-w-16 flex-1">
        <Meter value={util} label={name} />
      </div>
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {reset ? (
          <>
            resets {reset.at} · <span className="text-foreground">{reset.rel}</span>
          </>
        ) : (
          <span className="italic">reset time unknown</span>
        )}
      </span>
    </div>
  );
}

export function CurrentUsage() {
  const rpc = useRpc<typeof rpcContract>();
  const [st, setSt] = useState<Status | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  // A failed poll keeps the last reading on screen and says the reading is
  // old, rather than blanking the section — a blank section is read as "no
  // accounts", which is the same lie in a different shape.
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = (await rpc.call("status", null)) as Status;
        if (cancelled) return;
        setSt(next);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) {
          setNow(Date.now());
          setLoaded(true);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useRealtime("accounts.switched", () => {
    void (async () => {
      try {
        setSt((await rpc.call("status", null)) as Status);
        setNow(Date.now());
        setFailed(false);
      } catch {
        setFailed(true);
      }
    })();
  });

  const hint = st?.polledAt
    ? `Polled ${clock(st.polledAt)} by claude.usage-poll, refreshed here every ${POLL_MS / 1000}s.`
    : "Polled by the claude.usage-poll LaunchAgent.";

  if (!loaded && !st) {
    return (
      <Section title="Current usage">
        <div className="text-xs text-muted-foreground">loading…</div>
      </Section>
    );
  }

  if (!st || st.accounts.length === 0) {
    return (
      <Section title="Current usage" hint={hint}>
        <div className="text-xs text-muted-foreground">
          {failed
            ? "could not read the usage cache — the plugin's status call failed"
            : "no accounts in the usage cache — check ~/.config/claude-usage/usage.json"}
        </div>
      </Section>
    );
  }

  return (
    <Section title="Current usage" hint={hint}>
      {(st.stale || failed) && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {failed
            ? "The last refresh failed — the numbers below are as of the reading before it."
            : `The usage cache is behind (last polled ${clock(st.polledAt)}). These numbers are old — check the claude.usage-poll LaunchAgent.`}
        </div>
      )}
      <div className="space-y-2">
        {st.accounts.map((a) => (
          <div key={a.slot} className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm text-foreground">
                {a.active && <span className="text-primary">● </span>}
                {a.email}
              </span>
              {a.active && (
                <span className="shrink-0 rounded-full border border-primary/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                  active
                </span>
              )}
            </div>
            <Window
              label="5h"
              window={`${a.email} 5-hour`}
              util={a.fiveHour}
              resetsAt={a.fiveHourResetsAt}
              now={now}
            />
            <Window
              label="7d"
              window={`${a.email} 7-day`}
              util={a.sevenDay}
              resetsAt={a.sevenDayResetsAt}
              now={now}
            />
          </div>
        ))}
      </div>
      {st.lastSwitch && (
        <div className="mt-3 text-xs text-muted-foreground">
          last switch {clockMs(st.lastSwitch.at)}: {st.lastSwitch.from} → {st.lastSwitch.to} · {st.lastSwitch.reason}
        </div>
      )}
    </Section>
  );
}
