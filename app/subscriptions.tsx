// ONE subscriptions section, on the homepage and on the big page (MX-1226).
//
// What mgrin was looking at when he said "not working, not unified, data missing" was the
// HOMEPAGE, not the usage panel — and on the homepage:
//  - Claude accounts rendered as one thin line each, `5h 37% · 7d 84%`, with NO reset
//    times and NO state;
//  - Codex rendered as a different card entirely, `Weekly / 33% used / Resets …`;
//  - Jev was not there AT ALL, so the console bill — the only real dollar figure this
//    machine has — appeared nowhere he looks.
//
// So the fix is one component used by both surfaces, rendering every provider through the
// shared AccountCard, with Jev's bill on the same screen. `compact` trims the prose, never
// the numbers: the homepage is glanced at, and a glance that omits the reset time is the
// thing being fixed.
import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { JevSpend, ProviderAccount, Telemetry } from "../telemetry.ts";
import { jevAge } from "../telemetry.ts";
import type { Status } from "./current.tsx";
import { AccountCard } from "./account-card.tsx";
import { claudeCards, codexCards } from "./cards.ts";
import { capacityNotice } from "./format.ts";
import { Notice } from "./ui.tsx";

const POLL_MS = 30_000;
const n = (v: number) => v.toLocaleString("en-US");

/** The Jev line: the bill first, because it is the only figure that is money. */
export function JevLine({ spend, now, compact }: { spend: JevSpend | null; now: number; compact: boolean }) {
  if (!spend || spend.state !== "ok") {
    return <div className="text-xs text-muted-foreground">
      Jev — {spend === null ? "loading…" : `${spend.state === "no-data" ? "no data" : "UNKNOWN"} — ${spend.reason}`}
    </div>;
  }
  const day = spend.windows.find(w => w.name === "24h") ?? spend.windows[0];
  const compactedDay = spend.compaction?.find(w => w.name === "24h") ?? null;
  return <div className="space-y-1 rounded-md border border-border bg-muted/20 p-3">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Jev</span>
      <span className="text-sm text-foreground">TypeSafe</span>
      <span className="ml-auto text-sm tabular-nums text-foreground">
        {spend.billing ? `$${spend.billing.amountUsd.toFixed(2)}` : "no console reading"}
      </span>
    </div>
    <div className="text-xs text-muted-foreground">
      {spend.billing
        ? `${spend.billing.period} · read ${jevAge(now - spend.billing.recordedAt)} ago from the console, every key`
        : "no dollar figure until TypeSafe's console is read"}
    </div>
    {day && <div className="text-xs tabular-nums text-muted-foreground">
      24h · {n(day.calls)} calls · {n(day.inputTokens)} input tokens
      {/* The number the page used to hide entirely. It dwarfs the metered one. */}
      {compactedDay ? ` · compaction ${n(compactedDay.compactions)} runs, ${n(compactedDay.inputTokens)} tokens` : " · compaction unread"}
    </div>}
    {!compact && day && day.bySet.length > 0 && <div className="text-xs tabular-nums text-muted-foreground">
      {day.bySet.map(s => `${s.set} ${n(s.calls)}`).join(" · ")}
    </div>}
  </div>;
}

/**
 * Claude, Codex and Jev, in that order, every account through the same card.
 *
 * Three rpcs, three independent failures: a Jev read that fails must not blank the Claude
 * accounts, which are the thing looked at daily.
 */
export function SubscriptionsSection({ compact = false }: { compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [codex, setCodex] = useState<ProviderAccount[]>([]);
  const [jev, setJev] = useState<JevSpend | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = async () => {
    try { setStatus((await rpc.call("status", null)) as Status); } catch { /* keep the last good read */ }
    try {
      const t = (await rpc.call("telemetry", null)) as Telemetry;
      setCodex((t.accounts ?? []).filter(a => a.providerId === "codex" && a.scope !== "thread"));
    } catch { /* leave Codex as it was */ }
    try { setJev(await rpc.call("jev", null)); } catch { setJev(null); }
    setNow(Date.now());
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, []);
  useRealtime("accounts.switched", () => void load());

  const cards = [...claudeCards(status, now), ...codexCards(codex)];
  const notice = status ? capacityNotice(status.capacity) : null;
  return <div className="space-y-2">
    {cards.length === 0
      ? <p className="text-xs text-muted-foreground">Loading subscription telemetry…</p>
      : cards.map(c => <AccountCard key={`${c.provider}/${c.label}`} account={c} />)}
    <JevLine spend={jev} now={now / 1000} compact={compact} />
    {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
    {status?.stale && <div className="text-xs text-destructive">usage cache stale — check claude.usage-poll</div>}
    {!compact && status?.lastSwitch && (
      <div className="text-xs text-muted-foreground">
        last switch: {status.lastSwitch.from} → {status.lastSwitch.to} · {status.lastSwitch.reason}
      </div>
    )}
  </div>;
}
