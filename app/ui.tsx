// Presentational primitives shared by the homepage tiles and the big usage
// page. One Meter, one Section, one set of thresholds — two meters that drift
// apart is a worse outcome than an import that crosses a file boundary.
import type { ReactNode } from "react";

/**
 * A utilization bar. `null` is NOT zero: an unpolled window draws an empty
 * DASHED track, which reads as "no reading" rather than as "nothing used".
 * A solid empty track is indistinguishable from 0% and is the failure this
 * whole change exists to remove.
 */
export function Meter({ value, label }: { value: number | null; label?: string }) {
  if (value === null || !Number.isFinite(value)) {
    return (
      <div
        className="h-1.5 w-full rounded-full border border-dashed border-muted-foreground/50"
        title={label ? `${label}: no reading in the usage cache` : "no reading in the usage cache"}
        aria-label={label ? `${label} unknown` : "unknown"}
      />
    );
  }
  const v = Math.max(0, Math.min(100, value));
  const cls = v >= 85 ? "bg-destructive" : v >= 70 ? "bg-primary/70" : "bg-primary";
  return (
    <div
      className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
      title={label ? `${label}: ${Math.round(v)}%` : `${Math.round(v)}%`}
      aria-label={label ? `${label} ${Math.round(v)} percent` : `${Math.round(v)} percent`}
    >
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
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
