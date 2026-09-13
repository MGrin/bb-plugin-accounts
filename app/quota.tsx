import type { ReactNode } from "react";
import type { ProviderAccount, Telemetry } from "../telemetry.ts";
import { clock } from "./format.ts";
import { Meter } from "./ui.tsx";

type Window = ProviderAccount["windows"][number];
const durationLabel = (w: Window) => w.durationMinutes === 10080 ? "Weekly" :
  w.durationMinutes === 300 ? "5-hour" : w.durationMinutes ? `${w.durationMinutes / 60}-hour` :
    w.key === "secondary" ? "Long window" : "Usage";

function UsageWindow({ window: w, fresh, secondary = false }: { window: Window; fresh: boolean; secondary?: boolean }) {
  const label = secondary ? `${w.bucket} · ${durationLabel(w)}` : durationLabel(w);
  return <div className="space-y-1">
    <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <span>{w.usedPercent === null ? "Unknown" : `${w.usedPercent}% used`}{!fresh ? " · stale" : ""}</span>
    </div>
    <Meter value={fresh ? w.usedPercent : null} label={`${label} subscription usage`} />
    <div className="text-xs text-muted-foreground">Resets {w.resetsAt === null ? "unknown" : clock(w.resetsAt)}</div>
  </div>;
}

export function Quota({ account: a, children }: { account: ProviderAccount; children?: ReactNode }) {
  const main = a.windows.filter(w => w.bucket === "codex");
  const secondary = a.windows.filter(w => w.bucket !== "codex");
  return <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
    {/* Do not fall back to a.label: older servers used the account UUID there. */}
    <div className="text-sm">{a.email ?? "Codex account (email unavailable)"}</div>
    {(!a.fresh || a.capacity === "unknown" || a.capacity === "unavailable") &&
      <div className="text-xs text-muted-foreground">{a.fresh ? "Subscription usage unknown" : "Subscription reading unavailable or stale"}</div>}
    {main.map(w => <UsageWindow key={w.key} window={w} fresh={a.fresh} />)}
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Details</summary>
      <div className="mt-2 space-y-2">
        {secondary.map(w => <UsageWindow key={`${w.bucket}/${w.key}`} window={w} fresh={a.fresh} secondary />)}
        <div>Paid credits {a.credits.hasCredits === null ? "unknown" : a.credits.hasCredits ? "on" : "off"}{a.credits.balance === null ? "" : ` · balance ${a.credits.balance}`} — separate from subscription</div>
        <div>{a.planType ? `Plan ${a.planType} · ` : ""}Subscription {a.capacity} · {a.reason}</div>
        <div>Observed {clock(a.observedAt)} · {a.source}</div>
        {children}
      </div>
    </details>
  </div>;
}

export function ThreadTelemetry({ data }: { data: Telemetry }) {
  return <div className="space-y-2">
    <p>Token counts describe thread activity, not subscription quota. Thread quota events cannot identify the current account.</p>
    {data.accounts.filter(a => a.scope === "thread").slice(0, 8).map(a => <div key={a.threadId}>
      <a href={`/threads/${a.threadId}`}>Codex thread</a> · {a.fresh ? "recent" : "stale"} quota event · account unknown
      {a.windows.map(w => ` · ${w.key}: ${w.reportedStatus ?? "unknown"}`).join("")}
    </div>)}
    {data.tokens.slice(0, 8).map(t => <div key={t.threadId}>
      <a href={`/threads/${t.threadId}`}>Codex thread</a> · {t.totalTokens.toLocaleString()} tokens · {t.fresh ? "recent" : "stale"}
    </div>)}
  </div>;
}
