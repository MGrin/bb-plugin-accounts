// Shared Claude and Codex subscription cards on the homepage and usage panel.
import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { ProviderAccount } from "../telemetry.ts";
import type { Status } from "./current.tsx";
import { AccountCard, type CardAccount } from "./account-card.tsx";
import { claudeCards, codexCards } from "./cards.ts";
import { clockMs, capacityNotice } from "./format.ts";
import { Notice, LoadingBlock } from "./ui.tsx";

const POLL_MS = 30_000;
/** Provider reads settle independently. */
export function SubscriptionsSection({ compact = false }: { compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [codex, setCodex] = useState<ProviderAccount[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const [pending, setPending] = useState({claude:true, codex:true});
  const [errors, setErrors] = useState({claude:false, codex:false});
  // Each source settles independently; one failed request cannot strand another provider.
  const load = async (cancelled = () => false) => {
    await Promise.all([
      rpc.call("status", null).then(value => { if (!cancelled()) {setStatus(value as Status); setErrors(e=>({...e,claude:false}));} })
        .catch(()=>{if (!cancelled()) setErrors(e=>({...e,claude:true}));})
        .finally(()=>{if (!cancelled()) setPending(p=>({...p,claude:false}));}),
      rpc.call("telemetry", null).then(value => { if (!cancelled()) {setCodex((value.accounts ?? []).filter(a=>a.providerId==="codex" && a.scope!=="thread")); setErrors(e=>({...e,codex:false}));} })
        .catch(()=>{if (!cancelled()) setErrors(e=>({...e,codex:true}));})
        .finally(()=>{if (!cancelled()) setPending(p=>({...p,codex:false}));}),
    ]);
    if (!cancelled()) setNow(Date.now());
  };
  useEffect(() => {
    let cancelled = false;
    void load(()=>cancelled);
    const t = setInterval(() => void load(()=>cancelled), POLL_MS);
    return () => {cancelled=true; clearInterval(t);};
  }, []);
  useRealtime("accounts.switched", () => void load());
  useRealtime("accounts.paused", () => void load());

  // Pause / Resume (MX-1527) — mgrin's button, nothing else calls these. Confirm before a pause
  // because it silences polling and switching for the account until he resumes it.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const setPaused = async (card: CardAccount, pause: boolean) => {
    const control = card.control;
    if (!control) return;
    if (pause && typeof window !== "undefined" &&
        !window.confirm(`Pause ${card.label}? No request of any kind will be made on it — no polling, no switching onto it — until you resume it. It stays listed.`)) return;
    const id = `${control.provider}/${control.slot}`;
    setBusy(b => ({ ...b, [id]: true }));
    setNotes(n => ({ ...n, [id]: "" }));
    try {
      const result = await rpc.call(pause ? "pause" : "resume", { provider: control.provider, slot: control.slot });
      setNotes(n => ({ ...n, [id]: result.message }));
      await load();
    } catch {
      setNotes(n => ({ ...n, [id]: `Could not ${pause ? "pause" : "resume"} — the accounts plugin did not answer.` }));
    } finally {
      setBusy(b => ({ ...b, [id]: false }));
    }
  };

  const notice = status ? capacityNotice(status.capacity) : null;
  const groups = [
    {provider:"Claude", cards:claudeCards(status,now), loading:pending.claude, error:errors.claude},
    {provider:"Codex", cards:codexCards(codex,now), loading:pending.codex, error:errors.codex},
  ];
  return <div className="@container space-y-4">
    <div className={`grid items-start gap-4 ${compact ? "" : "@2xl:grid-cols-2"}`}>
      {groups.map(g=><div key={g.provider} className="min-w-0 space-y-2" aria-label={`${g.provider} subscriptions`}>
        <h3 className="text-xs font-medium text-muted-foreground">{g.provider}</h3>
        {g.loading ? <div className="rounded-md border border-border bg-muted/20 p-3"><LoadingBlock label={`Loading ${g.provider} subscriptions`} rows={2} /></div>
          : g.cards.length ? g.cards.map(c=>{
            const id = c.control ? `${c.control.provider}/${c.control.slot}` : "";
            return <AccountCard key={`${c.provider}/${c.label}`} account={c} onSetPaused={c.control ? (p=>void setPaused(c, p)) : undefined}
              busy={Boolean(busy[id])} message={notes[id] || null} />;
          })
          : <div role="status" className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
            {g.error ? `${g.provider} usage unavailable. Retrying automatically.` : `No ${g.provider} accounts reported.`}
          </div>}
        {g.error && g.cards.length>0 && <p role="status" className="text-xs text-muted-foreground">Refresh failed. Showing the last {g.provider} reading.</p>}
        {g.provider==="Claude" && notice ? <Notice tone={notice.tone}>Claude: {notice.text}</Notice> : null}
      </div>)}
    </div>
    {!compact && status?.lastSwitch && (
      <div className="text-xs text-muted-foreground">
        Last Claude {status.lastSwitch.reason.includes("observed") ? "login change observed" : "switch"} {clockMs(status.lastSwitch.at)}: {status.lastSwitch.from} → {status.lastSwitch.to}
        {status.lastSwitch.reason.includes("observed") && " · actual switch time/source unknown"}
      </div>
    )}
  </div>;
}
