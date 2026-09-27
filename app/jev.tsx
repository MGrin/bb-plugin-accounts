// One Jev card on both the homepage and usage page. Account billing and local estimates
// have different provenance and periods; failures preserve a labelled account snapshot.
import { JEV_COVERS, JEV_INPUT_USD_PER_MILLION, JEV_PRICE_CHECKED, billingIsStale, billingRefreshLabel, jevLocalEstimates, jevAge, type JevSpend } from "../telemetry.ts";
import { LoadingBlock } from "./ui.tsx";
const n = (v:number)=>v.toLocaleString("en-US");

export function JevCard({spend,failed,now,compact=false}:{spend:JevSpend|null;failed:boolean;now:number;compact?:boolean}) {
  const b=spend?.billing, local=!failed && spend && spend.state !== "unknown" && (spend.windows.length>0 || spend.compaction?.length) ? spend : null;
  const stale=failed || (!!spend && billingIsStale(spend,now));
  const status=failed ? "UNKNOWN — Jev usage could not be refreshed" : spend?.state === "unknown" ? `UNKNOWN — ${spend.reason}` :
    spend?.state === "no-data" ? `No data — ${spend.reason}` : null;
  if (!spend && !failed) return <div className="rounded-md border border-border bg-muted/20 p-3"><LoadingBlock label="Loading Jev usage" rows={2} /></div>;
  const estimates=local ? jevLocalEstimates(local) : [];
  return <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3" aria-label="Jev billing and local usage">
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Jev</span>
      <span className="text-sm text-foreground">TypeSafe</span>
      {b && <span className="ml-auto text-xs text-muted-foreground">{stale ? "Stale reading" : "Last reading"}</span>}
    </div>
    <div className="space-y-1">
      <div className="text-sm tabular-nums text-foreground">{b
        ? `${b.kind === "account-billing" ? "Last account spend" : "Last console estimate"} $${b.amountUsd.toFixed(2)} · ${b.period}`
        : "Account billing: no console reading"}</div>
      {b?.balanceUsd !== undefined && <div className="text-xs tabular-nums text-muted-foreground">Account balance ${b.balanceUsd.toFixed(2)}{b.plan ? ` · ${b.plan.replaceAll("_"," ")}` : ""}</div>}
      {b && <p className="text-xs text-muted-foreground">TypeSafe console, every key · read {jevAge(now-b.recordedAt)} ago{stale ? " · stale; no fresh billing confirmed" : ""}</p>}
      <p role="status" className="text-xs text-muted-foreground">{spend ? billingRefreshLabel(spend) : "Billing refresh unavailable"}
        {spend?.billingRefresh?.attemptedAt ? ` · attempted ${jevAge(now-spend.billingRefresh.attemptedAt)} ago` : ""}
        {spend?.billingRefresh?.rayId ? ` · Ray ID ${spend.billingRefresh.rayId}` : ""}</p>
      {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
    </div>
    {local && <div className="space-y-1 border-t border-border pt-2">
      <div className="text-xs font-medium text-foreground">Local cost estimate · recorded usage only</div>
      <div className="text-xs tabular-nums text-muted-foreground">{(compact ? estimates.slice(0,1) : estimates).map(w=>`${w.name} mx calls $${w.decisionUsd.toFixed(4)}`).join(" · ")}</div>
      <div className="text-xs tabular-nums text-muted-foreground">{local.compaction?.length
        ? (compact ? local.compaction.slice(0,1) : local.compaction).map(w=>`${w.name} compaction $${(w.inputTokens*JEV_INPUT_USD_PER_MILLION/1e6).toFixed(4)}${w.unmetered ? ` · ${n(w.unmetered)} unmetered` : w.unmetered == null ? " · completeness unknown" : ""}`).join(" · ")
        : "Compaction estimate unavailable"}</div>
      <p className="text-xs text-muted-foreground">Partial coverage; excludes unrecorded traffic and account credits.</p>
    </div>}
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Usage details{local ? ` · newest decision ${jevAge(now-(local.lastDecisionAt??now))} ago · reading ${jevAge(now-(local.generatedAt??now))} old` : ""}</summary>
      <div className="mt-2 space-y-2">
        {local && <div className="grid gap-2 @2xl:grid-cols-3">{local.windows.map(w=><div key={w.name} className="rounded-md border border-border p-2">
          <div>{w.name}</div><div>{n(w.calls)} calls</div><div>{n(w.inputTokens)} input tokens</div>
        </div>)}</div>}
        <p>Covers {spend?.covers ?? JEV_COVERS}.</p>
        {local && <p>Estimates use recorded input tokens at ${JEV_INPUT_USD_PER_MILLION}/million; output free. Rate checked {JEV_PRICE_CHECKED} at <a href="https://docs.typesafe.ai/models" target="_blank" rel="noreferrer" className="underline">TypeSafe</a>. Rolling local windows differ from the account billing cycle.</p>}
      </div>
    </details>
  </div>;
}
