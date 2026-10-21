import type { CodexForecast } from "../analytics/codex-forecast.ts";
import { Timeline } from "./charts.tsx";
import { clock } from "./format.ts";
import { Section } from "./ui.tsx";

export type Forecast = {
  confidence: "provisional" | "fitted" | "stale";
  coverage: { distinctPolls: number; neededPolls: number; demandSamples?: number; latestSampleAt: number | null };
  generatedAt: number;
  horizonSec: number;
  blackout: { earliest: number | null; likely: number | null; latest: number | null; endsAt: number | null; expectedSec: number };
  weeklyExhaustedAt: Record<string, number | null>;
  timeline: { ts: number; headroom: number; blacked: boolean }[];
  slotCurve: { slots: number; blackoutHoursPerWeek: number }[];
};

export function ForecastSection({ fc, codex, failed = false }: { fc: Forecast | null; codex: CodexForecast[]; failed?: boolean }) {
  if (!fc) return <Section title="Subscription forecast">
    <div className="text-xs text-muted-foreground">{failed ? "Claude forecast unavailable." : "No Claude accounts in the usage cache."}</div><Timeline points={[]} codex={codex} />
  </Section>;

  if (fc.confidence !== "fitted") {
    const { distinctPolls, neededPolls, demandSamples = 0 } = fc.coverage;
    const pct = Math.min(100, Math.round((distinctPolls / neededPolls) * 100));
    return (
      <Section
        title="Subscription forecast"
        hint={fc.confidence === "stale" ? "The usage cache is behind." : "Claude: not enough recorded history yet."}
      >
        <Timeline points={[]} codex={codex} />
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
    <Section title="Subscription forecast" hint={`Next ${Math.round(fc.horizonSec / 86400)} days, at median demand.`}>
      <div className="mb-3">
        {fc.blackout.likely === null ? (
          <div className="text-sm text-foreground">No projected period where every Claude account is exhausted.</div>
        ) : (
          <div className="text-sm text-foreground">
            All Claude accounts dry <span className="font-medium">{clock(fc.blackout.likely)}</span>{" "}
            <span className="text-muted-foreground">
              ({clock(fc.blackout.earliest)} – {clock(fc.blackout.latest)})
            </span>
            , back <span className="font-medium">{clock(fc.blackout.endsAt)}</span>
          </div>
        )}
      </div>
      <Timeline points={fc.timeline} codex={codex} />
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

