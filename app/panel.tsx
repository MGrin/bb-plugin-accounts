// The usage dashboard. Its own route, so it owns the whole page.
//
// SCROLLING IS THE PANEL'S JOB. bb hands a nav panel a fixed-height container,
// so a root that just grows is silently clipped at the viewport — which is
// exactly what happened here: everything below the heatmap was unreachable.
// The root owns the scroll (h-full + overflow-y-auto) and the padded, centred
// column sits inside it, so the scrollbar tracks the panel edge rather than
// the middle of the content.
//
// Responsive because this has to work from a phone over bb.scani.xyz, and any
// state that must outlive navigation goes to localStorage — a route-scoped
// panel unmounts on every navigation, so a useRef would silently reset.
import { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { Heatmap, PaletteVars, SlotCurve } from "./charts.tsx";
import { SubscriptionsSection } from "./subscriptions.tsx";
import { CodexTokens, UsageBreakdown } from './codex-analytics.tsx';
import type { CodexBreakdown } from '../analytics/codex.ts';
import type { CodexForecast } from '../analytics/codex-forecast.ts';
import { settleCodexForecast } from "./forecast.ts";
import { ForecastSection, type Forecast } from "./forecast-section.tsx";
import { Section, LoadingBlock, Notice } from "./ui.tsx";

type Analytics = {
  codex: {coverage:{responses:number;unattributed:number};byModel:CodexBreakdown[];byRepo:CodexBreakdown[];byDirectory:CodexBreakdown[]};
  days: number;
  coverage: { messages: number; firstTs: number | null; lastTs: number | null };
  byModel: { key: string; messages: number; weightedK: number }[];
  byAgent: { key: string; messages: number; weightedK: number }[];
  byProject: { key: string; messages: number; weightedK: number }[];
  byRepo: { key: string; messages: number; weightedK: number }[];
  byHourOfWeek: { dayOfWeek: number; hour: number; weightedK: number }[];
};

const RANGES = [7, 14, 30] as const;
const RANGE_KEY = "accounts.analytics.days";

export function UsagePanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [codexForecast, setCodexForecast] = useState<CodexForecast[]>([]);
  const [fc, setFc] = useState<Forecast | null>(null);
  const [data, setData] = useState<Analytics | null>(null);
  const [days, setDays] = useState<number>(() => {
    const stored = Number(localStorage.getItem(RANGE_KEY));
    return RANGES.includes(stored as (typeof RANGES)[number]) ? stored : 14;
  });
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [f, a, c] = await Promise.allSettled([
        rpc.call("forecast", null) as Promise<Forecast | null>,
        rpc.call("analytics", { days }) as Promise<Analytics>,
        rpc.call("codexForecast", null) as Promise<CodexForecast[]>,
      ]);
      if (cancelled) return;
      setFc(f.status === "fulfilled" ? f.value : null);
      setCodexForecast(previous => settleCodexForecast(previous,c));
      setData(a.status === "fulfilled" ? a.value : null);
      setErrors([...(f.status === "rejected" ? ["Claude forecast"] : []),
        ...(c.status === "rejected" ? ["Codex forecast"] : []),
        ...(a.status === "rejected" ? ["Usage breakdowns"] : [])]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [days, retry]);

  return (
    <div className="acct-viz @container h-full overflow-y-auto">
      <PaletteVars />
      <div className="p-4 pb-10 space-y-4 max-w-6xl mx-auto">

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-medium text-foreground">Subscription usage</h1>
          <p className="text-xs text-muted-foreground">
            {data ? `${data.coverage.messages.toLocaleString()} Claude messages · ${data.codex.coverage.responses.toLocaleString()} Codex responses (${data.codex.coverage.unattributed} missing model/directory) indexed` : loading ? "Loading subscription usage…" : "Usage history unavailable"}
            {data?.coverage.firstTs
              ? ` · since ${new Date(data.coverage.firstTs * 1000).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">History range</span>
          <div role="group" aria-label="History range" className="flex rounded-md border border-border overflow-hidden">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setDays(r);
                  localStorage.setItem(RANGE_KEY, String(r));
                }}
                className={`px-2.5 py-1 text-xs ${
                  days === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {r}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Current usage FIRST: it is the daily question ('can I start this now'),
          the forecast is the occasional one. */}
      <Section title="Subscriptions" hint="Current subscription windows and reset times.">
        <SubscriptionsSection />
      </Section>

      {!loading && errors.length > 0 && <Notice tone="unknown">
        {errors.join(", ")} unavailable. <button className="ml-2 underline underline-offset-2" onClick={()=>setRetry(r=>r+1)}>Retry</button>
      </Notice>}
      {loading ? <Section title="Subscription forecast"><LoadingBlock label="Loading subscription forecasts" rows={4} /></Section>
        : <ForecastSection fc={fc} codex={codexForecast} failed={errors.includes("Claude forecast")} />}


      {!loading && fc && fc.slotCurve.length > 0 && (
        <Section
          title="Would more Claude accounts help?"
          hint="The same simulation re-run with a different number of subscriptions. Assumes an added account has identical limits and that demand does not grow to fill the extra headroom — the second is the weaker assumption."
        >
          {fc.confidence !== "fitted" && (
            // The curve comes from the same demand profile whose blackout times
            // are withheld above. Showing it unmarked would let a number built
            // on a few hours of history argue for buying a subscription.
            <div className="mb-3 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
              Built on the same thin history as the forecast above — read the shape, not the hours.
            </div>
          )}
          <SlotCurve points={fc.slotCurve} actual={Object.keys(fc.weeklyExhaustedAt).length} />
        </Section>
      )}

      <Section title="By model" hint="Share within each provider for the selected period. These metrics do not measure subscription quota.">
        <div className="grid items-start gap-6 @2xl:grid-cols-2">
          <UsageBreakdown provider="Claude" metric="Weighted tokens · thousands" slices={data?.byModel ?? []} loading={loading} error={!data && !loading ? "Usage history unavailable." : null} />
          <CodexTokens rows={data?.codex.byModel ?? []} loading={loading} error={!data && !loading ? "Usage history unavailable." : null} />
        </div>
      </Section>
      <Section title="By project" hint="Usage grouped by repository. Personal workspaces without a repository appear as (no repo).">
        <div className="grid items-start gap-6 @2xl:grid-cols-2">
          <UsageBreakdown provider="Claude" metric="Weighted tokens · thousands" slices={data?.byRepo ?? []} loading={loading} error={!data && !loading ? "Usage history unavailable." : null} />
          <CodexTokens rows={data?.codex.byRepo ?? []} loading={loading} error={!data && !loading ? "Usage history unavailable." : null} />
        </div>
      </Section>
      <Section title="By directory" hint="Usage grouped by working directory.">
        <div className="grid items-start gap-6 @2xl:grid-cols-2">
          <UsageBreakdown provider="Claude" metric="Weighted tokens · thousands" slices={data?.byProject ?? []} loading={loading} error={!data && !loading ? "Usage history unavailable." : null} />
          <CodexTokens rows={data?.codex.byDirectory ?? []} loading={loading} error={!data && !loading ? "Usage history unavailable." : null} />
        </div>
      </Section>
      <div className="grid items-start gap-4 @2xl:grid-cols-2">
        <Section title="Claude activity" hint="Weighted tokens by local hour of week.">
          {loading ? <LoadingBlock label="Loading Claude activity" /> : data ? <div className="overflow-x-auto"><Heatmap cells={data.byHourOfWeek} /></div> : <p className="text-xs text-muted-foreground">Usage history unavailable.</p>}
        </Section>
        <Section title="Claude entrypoints" hint="bb-agent: BB threads · terminal: interactive sessions.">
          <UsageBreakdown provider="Claude" metric="Weighted tokens · thousands" slices={data?.byAgent ?? []} loading={loading} error={!data && !loading ? "Usage history unavailable." : null} />
        </Section>
      </div>
      </div>
    </div>
  );
}
