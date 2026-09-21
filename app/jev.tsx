// Jev spend on the Subscription usage page (MX-1172). The numbers come from
// `mx jev usage --json` through the `jev` rpc and are never recomputed here.
// Three states and no fourth, same as the Übersicht widget: a reading, NO DATA
// (no log, or nothing in it — not zero spend), and UNKNOWN with its reason.
// Only a reading prints a figure; a failed refresh drops the old one rather
// than leaving a number on screen nobody can vouch for. Pure, so it renders
// under test; the fetching half lives in providers.tsx beside Codex's.
import { JEV_COVERS, jevAge, type JevSpend } from "../telemetry.ts";

const usd = (v: number) => `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;

export function JevCard({ spend, failed, now }: { spend: JevSpend | null; failed: boolean; now: number }) {
  const status = failed ? "UNKNOWN — Jev usage could not be refreshed" : !spend ? "Loading Jev usage…" :
    spend.state === "unknown" ? `UNKNOWN — ${spend.reason}` : spend.state === "no-data" ? `No data — ${spend.reason}` : null;
  const s = !failed && spend?.state === "ok" ? spend : null;
  return <div className="space-y-2">
    {s ? <>
      <div className="text-xs text-muted-foreground">
        newest decision {s.lastDecisionAt === null ? "unknown" : `${jevAge(now - s.lastDecisionAt)} ago`}
        {" · "}reading {s.generatedAt === null ? "age unknown" : `${jevAge(now - s.generatedAt)} old`}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {s.windows.map(w => <div key={w.name} className="rounded-md border border-border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">{w.name}</div>
          <div className="text-base tabular-nums text-foreground">{usd(w.usd)}</div>
          <div className="text-xs tabular-nums text-muted-foreground">{w.calls.toLocaleString("en-US")} calls</div>
          <div className="text-xs tabular-nums text-muted-foreground">{w.inputTokens.toLocaleString("en-US")} input tokens</div>
        </div>)}
      </div>
    </> : <p className="text-xs text-muted-foreground">{status}</p>}
    <p className="text-xs text-muted-foreground">
      An estimate, not a bill: input tokens × {s?.usdPerMtok === null || !s ? "a price constant" : `$${s.usdPerMtok}/MTok`}.
      TypeSafe publishes no billing or usage endpoint to check it against.
    </p>
    <p className="text-xs text-muted-foreground">Covers {spend?.covers ?? JEV_COVERS}.</p>
  </div>;
}
