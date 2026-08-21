// bb-plugin-accounts frontend — homepage usage tiles per Claude account.
import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { UsagePanel } from "./app/panel.tsx";
// One Meter and one set of thresholds for both surfaces — the tiles here and
// the big page. Two copies drift, and a meter that disagrees with the page it
// links to is worse than no meter.
import type { Status } from "./app/current.tsx";
import { capacityNotice, creditLabel, formatPct } from "./app/format.ts";
import { Meter, Notice } from "./app/ui.tsx";

type ForecastLine = {
  confidence: "provisional" | "fitted" | "stale";
  blackout: { earliest: number | null; likely: number | null; latest: number | null; endsAt: number | null };
} | null;

const hhmm = (ts: number | null) =>
  ts === null ? "?" : new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function AccountsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [st, setSt] = useState<Status | null>(null);
  const [fc, setFc] = useState<ForecastLine>(null);
  const load = async () => {
    setSt((await rpc.call("status", null)) as Status);
    // Its own await so a forecast failure cannot blank the tiles, which are
    // the thing that is useful every single day.
    try {
      setFc((await rpc.call("forecast", null)) as ForecastLine);
    } catch {
      setFc(null);
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);
  useRealtime("accounts.switched", () => void load());
  if (!st || !st.accounts.length) return null;
  return (
    <div className="space-y-2">
      {st.accounts.map((a) => (
        <div key={a.slot} className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-foreground">
              {a.active ? "● " : ""}{a.email}
            </span>
            {/* `?? 0` here used to turn an UNPOLLED account into "0%", which
                reads as completely free and is the inverse of the truth. */}
            <span className="text-xs text-muted-foreground tabular-nums">
              5h {formatPct(a.fiveHour)} · 7d {formatPct(a.sevenDay)}
              {/* Same three-state rule as the big page: `off` is silent,
                  `unknown` is `credits ?`, never "off". */}
              {(() => {
                const label = creditLabel(a.credits, a.creditSpend);
                return label ? (
                  <span className={a.credits === "unknown" ? " italic" : " text-primary"}> · {label}</span>
                ) : null;
              })()}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Meter value={a.fiveHour} label="5-hour" />
            <Meter value={a.sevenDay} label="7-day" />
          </div>
        </div>
      ))}
      {(() => {
        // The same field the big page and `bb accounts outage` read. The
        // homepage is the surface glanced at rather than opened, so the state
        // that costs money has to be legible here too — not one click away.
        const n = capacityNotice(st.capacity);
        return n ? <Notice tone={n.tone}>{n.text}</Notice> : null;
      })()}
      {st.stale && <div className="text-xs text-destructive">usage cache stale — check claude.usage-poll</div>}
      {fc?.confidence === "fitted" && fc.blackout.likely !== null && (
        <div className="text-xs text-destructive">
          all accounts dry ~{hhmm(fc.blackout.likely)} ({hhmm(fc.blackout.earliest)}–{hhmm(fc.blackout.latest)}),
          back ~{hhmm(fc.blackout.endsAt)}
        </div>
      )}
      {st.lastSwitch && (
        <div className="text-xs text-muted-foreground">
          last switch: {st.lastSwitch.from} → {st.lastSwitch.to} · {st.lastSwitch.reason}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({ id: "claude-accounts", title: "Claude accounts", component: AccountsSection });
  app.slots.navPanel({
    id: "usage",
    title: "Claude usage",
    icon: "ChartBar",
    path: "usage",
    component: UsagePanel,
  });
});
