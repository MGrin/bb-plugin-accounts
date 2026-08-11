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
import { type ReactNode, useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { BarList, Heatmap, PaletteVars, SlotCurve, Timeline } from "./charts.tsx";

type Forecast = {
  confidence: "provisional" | "fitted" | "stale";
  coverage: { distinctPolls: number; neededPolls: number; demandSamples?: number; latestSampleAt: number | null };
  horizonSec: number;
  blackout: { earliest: number | null; likely: number | null; latest: number | null; endsAt: number | null; expectedSec: number };
  weeklyExhaustedAt: Record<string, number | null>;
  timeline: { ts: number; headroom: number; blacked: boolean }[];
  slotCurve: { slots: number; blackoutHoursPerWeek: number }[];
};

type Analytics = {
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

const clock = (ts: number | null) =>
  ts === null
    ? "—"
    : new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function ForecastSection({ fc }: { fc: Forecast | null }) {
  if (!fc) return <Section title="Forecast">
    <div className="text-xs text-muted-foreground">no accounts in the usage cache</div>
  </Section>;

  if (fc.confidence !== "fitted") {
    const { distinctPolls, neededPolls, demandSamples = 0 } = fc.coverage;
    const pct = Math.min(100, Math.round((distinctPolls / neededPolls) * 100));
    return (
      <Section
        title="Forecast"
        hint={fc.confidence === "stale" ? "The usage cache is behind." : "Not enough recorded history yet."}
      >
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <div className="text-xs text-foreground">
            {fc.confidence === "stale"
              ? "The poller has not reported recently — check the claude.usage-poll LaunchAgent."
              : `${distinctPolls.toLocaleString()} of ~${neededPolls.toLocaleString()} polls recorded (${pct}%), ${demandSamples} usable demand sample(s).`}
          </div>
          {fc.confidence === "provisional" && (
            <>
              <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Times are deliberately withheld until there are about three days of polls. A blackout
                prediction off a handful of samples reads as a schedule and is not one. The breakdowns
                below are retroactive and ready now.
              </p>
            </>
          )}
        </div>
      </Section>
    );
  }

  return (
    <Section title="Forecast" hint={`Next ${Math.round(fc.horizonSec / 86400)} days, at median demand.`}>
      <div className="mb-3">
        {fc.blackout.likely === null ? (
          <div className="text-sm text-foreground">No point in the horizon where every account is walled.</div>
        ) : (
          <div className="text-sm text-foreground">
            All accounts dry <span className="font-medium">{clock(fc.blackout.likely)}</span>{" "}
            <span className="text-muted-foreground">
              ({clock(fc.blackout.earliest)} – {clock(fc.blackout.latest)})
            </span>
            , back <span className="font-medium">{clock(fc.blackout.endsAt)}</span>
          </div>
        )}
      </div>
      <Timeline points={fc.timeline.slice(0, 192)} />
      <div className="mt-4 space-y-1">
        {Object.entries(fc.weeklyExhaustedAt).map(([slot, at]) => (
          <div key={slot} className="flex justify-between text-xs">
            <span className="text-muted-foreground truncate">{slot}</span>
            <span className="tabular-nums text-foreground">
              {at === null ? "week survives the horizon" : `week spent ${clock(at)}`}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function UsagePanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [fc, setFc] = useState<Forecast | null>(null);
  const [data, setData] = useState<Analytics | null>(null);
  const [days, setDays] = useState<number>(() => {
    const stored = Number(localStorage.getItem(RANGE_KEY));
    return RANGES.includes(stored as (typeof RANGES)[number]) ? stored : 14;
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [f, a] = await Promise.all([
        rpc.call("forecast", null) as Promise<Forecast | null>,
        rpc.call("analytics", { days }) as Promise<Analytics>,
      ]);
      if (cancelled) return;
      setFc(f);
      setData(a);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const modelOrder = (data?.byModel ?? []).map((s) => s.key);
  const agentOrder = (data?.byAgent ?? []).map((s) => s.key);
  const projectOrder = (data?.byProject ?? []).map((s) => s.key);
  const repoOrder = (data?.byRepo ?? []).map((s) => s.key);

  return (
    <div className="acct-viz h-full overflow-y-auto">
      <PaletteVars />
      <div className="p-4 pb-10 space-y-4 max-w-4xl mx-auto">

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-medium text-foreground">Claude usage</h1>
          <p className="text-xs text-muted-foreground">
            {data ? `${data.coverage.messages.toLocaleString()} messages indexed` : "loading…"}
            {data?.coverage.firstTs
              ? ` · since ${new Date(data.coverage.firstTs * 1000).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <div className="flex rounded-md border border-border overflow-hidden">
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

      <ForecastSection fc={fc} />

      {fc && fc.slotCurve.length > 0 && (
        <Section
          title="Would more accounts help?"
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

      <Section title="When you burn it" hint="Weighted tokens by local hour of week.">
        {data ? <Heatmap cells={data.byHourOfWeek} /> : <div className="text-xs text-muted-foreground">loading…</div>}
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="By model">
          {data ? <BarList slices={data.byModel} order={modelOrder} /> : null}
        </Section>
        <Section title="By who spent it" hint="bb-agent is a bb-spawned thread; terminal is you typing.">
          {data ? <BarList slices={data.byAgent} order={agentOrder} /> : null}
        </Section>
      </div>

      <Section
        title="By repo"
        hint="Resolved from bb's own project records first, then the environment, then git — a bb worktree is disposable, so most of these directories no longer exist. (no repo) is work that genuinely belongs to none: personal workspaces and your home directory."
      >
        {data ? <BarList slices={data.byRepo} order={repoOrder} /> : null}
      </Section>

      <Section title="By directory" hint="The working directory itself, for when the repo is not the interesting part.">
        {data ? <BarList slices={data.byProject} order={projectOrder} /> : null}
      </Section>

        {loading && <div className="text-xs text-muted-foreground">refreshing…</div>}
      </div>
    </div>
  );
}
