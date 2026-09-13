import { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { Telemetry } from "../telemetry.ts";
import { Quota } from "./quota.tsx";

/** Shared by the homepage and dashboard. A transport failure never leaves a green cached verdict. */
export function ProviderTelemetry({ compact = false }: { compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Telemetry | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await rpc.call("telemetry", null);
        if (!cancelled) { setData(next); setFailed(false); }
      } catch { if (!cancelled) setFailed(true); }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const accounts = (data?.accounts ?? []).filter(a => a.providerId === "codex" && a.scope !== "thread");
  return <section className="space-y-2" aria-label="Codex subscription">
    <h2 className="text-sm font-medium">Codex subscription</h2>
    {failed || !accounts.length ? <p className="text-xs text-muted-foreground">{failed ? "UNKNOWN — subscription telemetry could not be refreshed" : "Loading subscription telemetry…"}</p> :
      accounts.map((a, i) => <Quota key={i} account={a} compact={compact} />)}
    {!compact && !failed && data && <>
      <p className="text-xs text-muted-foreground">Token counts describe thread activity, not subscription quota. Thread quota events cannot identify the current account.</p>
      {data.accounts.filter(a => a.scope === "thread").slice(0, 8).map(a => <div key={a.threadId} className="text-xs text-muted-foreground">
        <a href={`/threads/${a.threadId}`}>Codex thread</a> · {a.fresh ? "recent" : "stale"} quota event · account unknown
        {a.windows.map(w => ` · ${w.key}: ${w.reportedStatus ?? "unknown"}`).join("")}
      </div>)}
      {data.tokens.slice(0, 8).map(t => <div key={t.threadId} className="text-xs text-muted-foreground">
        <a href={`/threads/${t.threadId}`}>Codex thread</a> · {t.totalTokens.toLocaleString()} tokens · {t.fresh ? "recent" : "stale"}
      </div>)}
    </>}
  </section>;
}
