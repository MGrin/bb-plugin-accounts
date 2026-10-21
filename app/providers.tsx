import { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { Telemetry } from "../telemetry.ts";
import { Quota, ThreadTelemetry } from "./quota.tsx";

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
    {!compact && <h2 className="text-sm font-medium">Codex subscription</h2>}
    {failed || !accounts.length ? <p className="text-xs text-muted-foreground">{failed ? "UNKNOWN — subscription telemetry could not be refreshed" : "Loading subscription telemetry…"}</p> :
      accounts.map((a, i) => <Quota key={i} account={a}>
        {!compact && data && <ThreadTelemetry data={data} />}
      </Quota>)}
  </section>;
}
