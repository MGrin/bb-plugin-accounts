// bb-plugin-accounts frontend — homepage usage tiles per Claude account.
import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { UsagePanel } from "./app/panel.tsx";

type Status = {
  polledAt: number | null;
  stale: boolean;
  accounts: {
    slot: string; email: string; active: boolean;
    fiveHour: number | null; sevenDay: number | null;
    fiveHourResetsAt: string | null; sevenDayResetsAt: string | null;
  }[];
  lastSwitch: { at: number; from: string; to: string; reason: string } | null;
};

function Meter({ value }: { value: number | null }) {
  const v = Math.min(100, value ?? 0);
  const cls = v >= 85 ? "bg-destructive" : v >= 70 ? "bg-primary/70" : "bg-primary";
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${v}%` }} />
    </div>
  );
}

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
            <span className="text-xs text-muted-foreground tabular-nums">
              5h {a.fiveHour ?? 0}% · 7d {a.sevenDay ?? 0}%
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Meter value={a.fiveHour} />
            <Meter value={a.sevenDay} />
          </div>
        </div>
      ))}
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
