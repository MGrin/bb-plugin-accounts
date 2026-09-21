import { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { JevSpend, Telemetry } from "../telemetry.ts";
import { Quota, ThreadTelemetry } from "./quota.tsx";
import { JevCard } from "./jev.tsx";
import { Section } from "./ui.tsx";

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

/** Jev spend. Its own rpc, polled every 60 s — mx itself is throttled to one read a minute. */
export function JevSpendSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [spend, setSpend] = useState<JevSpend | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await rpc.call("jev", null);
        if (!cancelled) { setSpend(next); setFailed(false); }
      } catch { if (!cancelled) setFailed(true); }
      if (!cancelled) setNow(Date.now() / 1000);
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  return <Section title="Jev spend" hint="TypeSafe Jev, read from mx jev usage. Rolling windows, not calendar days.">
    <JevCard spend={spend} failed={failed} now={now} />
  </Section>;
}
