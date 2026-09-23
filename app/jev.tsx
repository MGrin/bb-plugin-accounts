// Jev usage on the Subscription usage page (MX-1172), collapsed to three lines (MX-1226).
//
// The numbers come from `mx jev usage --json` (version 2) through the `jev` rpc and are
// never recomputed here. Per-window rows are THIS key's calls and tokens; the ONE dollar
// figure is `billing`, a recorded reading of TypeSafe's console across every key
// (MX-1200). Three states and no fourth, same as the Übersicht widget: a reading, NO DATA
// (no log, or nothing in it — not zero spend), and UNKNOWN with its reason. Only a
// reading prints a figure; a failed refresh drops the old one rather than leaving a
// number on screen nobody can vouch for.
//
// WHAT COLLAPSED, and why it is not information lost: the two caveat paragraphs and the
// per-window cards moved behind `Details`. They are read once, not daily — but they are
// exactly the sentences that stop someone reading this key's token count as the bill, so
// they stay one click away and the dollar line keeps saying "console" in the open.
// Pure, so it renders under test; the fetching half lives in providers.tsx.
import { JEV_COVERS, jevAge, type JevSpend } from "../telemetry.ts";

const n = (v: number) => v.toLocaleString("en-US");

export function JevCard({ spend, failed, now }: { spend: JevSpend | null; failed: boolean; now: number }) {
  const status = failed ? "UNKNOWN — Jev usage could not be refreshed" : !spend ? "Loading Jev usage…" :
    spend.state === "unknown" ? `UNKNOWN — ${spend.reason}` : spend.state === "no-data" ? `No data — ${spend.reason}` : null;
  const s = !failed && spend?.state === "ok" ? spend : null;
  if (!s) return <div className="space-y-2"><p className="text-xs text-muted-foreground">{status}</p></div>;
  return <div className="space-y-1">
    {/* 1. the bill — the only dollar figure, and it says where it came from. */}
    <div className="text-sm tabular-nums text-foreground">
      {s.billing
        ? `Billed $${s.billing.amountUsd.toFixed(2)} · ${s.billing.period} · read ${jevAge(now - s.billing.recordedAt)} ago from the TypeSafe console`
        : "Billed: no console reading, so no dollar figure"}
    </div>
    {/* 2. this key's traffic, one line for every window. */}
    <div className="text-xs tabular-nums text-muted-foreground">
      {s.windows.map(w => `${w.name} ${n(w.calls)} calls · ${n(w.inputTokens)} tok`).join("  ·  ") || "no windows reported"}
    </div>
    {/* 3. freshness, and the door to everything else. */}
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        newest decision {s.lastDecisionAt === null ? "unknown" : `${jevAge(now - s.lastDecisionAt)} ago`}
        {" · "}reading {s.generatedAt === null ? "age unknown" : `${jevAge(now - s.generatedAt)} old`}
        {" · "}details
      </summary>
      <div className="mt-2 space-y-2">
        <div className="grid gap-2 sm:grid-cols-3">
          {s.windows.map(w => <div key={w.name} className="rounded-md border border-border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">{w.name}</div>
            <div className="text-base tabular-nums text-foreground">{n(w.calls)} calls</div>
            <div className="text-xs tabular-nums text-muted-foreground">{n(w.inputTokens)} input tokens</div>
          </div>)}
        </div>
        <p>
          Calls and tokens are this machine's key only; TypeSafe bills the account across every key,
          so the only dollar figure shown is a reading of its console.
        </p>
        <p>Covers {spend?.covers ?? JEV_COVERS}.</p>
      </div>
    </details>
  </div>;
}
