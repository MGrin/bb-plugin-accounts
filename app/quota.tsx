import type { ProviderAccount } from "../telemetry.ts";
import { Meter } from "./ui.tsx";

export function Quota({ account: a, compact }: { account: ProviderAccount; compact: boolean }) {
  return <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
    <div className="flex flex-wrap justify-between gap-2 text-xs">
      <span>{a.label}{a.planType ? ` · ${a.planType}` : ""}</span>
      <span className={a.capacity === "unknown" ? "text-muted-foreground" : "text-foreground"}>Subscription {a.capacity.toUpperCase()}</span>
    </div>
    <p className="text-xs text-muted-foreground">{a.reason}</p>
    {a.windows.filter(w => !compact || w.bucket === "codex").map(w => <div key={`${w.bucket}/${w.key}`} className="space-y-1">
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>{w.bucket} · {w.key} {w.durationMinutes ? `(${w.durationMinutes / 60}h)` : ""}</span>
        <span>{w.usedPercent === null ? "UNKNOWN" : `${w.usedPercent}% used`}{!a.fresh ? " · stale" : ""}</span>
      </div>
      <Meter value={a.fresh ? w.usedPercent : null} label={`${w.bucket} ${w.key} subscription usage`} />
      {!compact && <div className="text-xs text-muted-foreground">Reset {w.resetsAt === null ? "unknown" : new Date(w.resetsAt * 1000).toLocaleString()}</div>}
    </div>)}
    <div className="text-xs text-muted-foreground">
      Paid credits {a.credits.hasCredits === null ? "unknown" : a.credits.hasCredits ? "on" : "off"}{a.credits.balance === null ? "" : ` · balance ${a.credits.balance}`} — separate from subscription
    </div>
    <div className="text-xs text-muted-foreground">Observed {a.observedAt === null ? "unknown" : new Date(a.observedAt * 1000).toLocaleString()} · {a.source}</div>
  </div>;
}
