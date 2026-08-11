// Hand-rolled SVG chart primitives. No chart library: a heatmap, a labelled
// bar and a banded timeline are simple shapes, and Recharts would roughly
// double the bundle to draw them.
//
// COLOR. The categorical slots below are the reference palette's fixed order,
// validated (not eyeballed) with the dataviz validator against both surfaces:
//
//   light #fcfcfb — lightness band PASS, chroma PASS, CVD ΔE 9.1 worst
//                   adjacent (protan), normal-vision ΔE 19.6, contrast WARN
//   dark  #1a1a19 — all five checks PASS, contrast >= 3:1
//
// The light-mode contrast WARN is what obliges every bar here to carry a
// visible label: relief, not decoration. Slots are assigned in fixed order and
// never cycled, so a series keeps its colour when the set changes.
import { Fragment, useState } from "react";

export const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
export const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];

/** Sequential ramp, one hue light->dark, for magnitude-only encodings. */
const BLUE_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

/** Status. Reserved — never reused as a series colour. */
export const CRITICAL = "#d03b3b";

/**
 * Fixed slot for a key, so colour follows the entity rather than its rank.
 * A filter that drops a series must not repaint the survivors.
 */
export function slotFor(key: string, order: string[]): number {
  const i = order.indexOf(key);
  return i < 0 ? order.length % SERIES_LIGHT.length : i % SERIES_LIGHT.length;
}

export function Swatch({ index }: { index: number }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-[2px] align-middle"
      style={{ background: `var(--acct-series-${index})` }}
    />
  );
}

/**
 * The palette as CSS variables, switched by bb's own dark class rather than by
 * flipping the light values — dark steps are chosen and separately validated.
 */
export function PaletteVars() {
  const rules = [
    `.acct-viz{${SERIES_LIGHT.map((c, i) => `--acct-series-${i}:${c};`).join("")}--acct-ramp:${BLUE_RAMP[3]};}`,
    `.dark .acct-viz{${SERIES_DARK.map((c, i) => `--acct-series-${i}:${c};`).join("")}}`,
  ].join("\n");
  return <style>{rules}</style>;
}

export interface Slice {
  key: string;
  weightedK: number;
  messages: number;
}

/**
 * Horizontal labelled bars — the form for "magnitude, with identity".
 *
 * Direct-labelled rather than legend-and-guess: every row names itself and
 * carries its share, which is also the relief the light-surface contrast WARN
 * requires. Values are text-token ink, never the series colour.
 */
export function BarList({
  slices,
  order,
  unit = "k",
  max: maxOverride,
}: {
  slices: Slice[];
  order: string[];
  unit?: string;
  max?: number;
}) {
  const total = slices.reduce((s, x) => s + x.weightedK, 0) || 1;
  const max = maxOverride ?? Math.max(...slices.map((s) => s.weightedK), 1);
  if (slices.length === 0) {
    return <div className="text-xs text-muted-foreground">nothing recorded in this window</div>;
  }
  return (
    <div className="space-y-1.5">
      {slices.map((s) => {
        const pct = (s.weightedK / total) * 100;
        return (
          <div key={s.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <Swatch index={slotFor(s.key, order)} />
              <span className="truncate text-xs text-foreground" title={s.key}>
                {s.key}
              </span>
            </div>
            <div className="h-2.5 w-full">
              <svg width="100%" height="10" role="img" aria-label={`${s.key}: ${pct.toFixed(1)} percent`}>
                <rect x="0" y="0" width="100%" height="10" rx="4" className="fill-muted" />
                <rect
                  x="0"
                  y="0"
                  width={`${Math.max(0.5, (s.weightedK / max) * 100)}%`}
                  height="10"
                  rx="4"
                  style={{ fill: `var(--acct-series-${slotFor(s.key, order)})` }}
                />
              </svg>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {pct.toFixed(1)}% · {Math.round(s.weightedK).toLocaleString()}
              {unit}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface HourCell {
  dayOfWeek: number;
  hour: number;
  weightedK: number;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Hour-of-week heatmap. Magnitude on two categorical axes, so one hue
 * light->dark — never a rainbow, which would imply categories the data
 * does not have.
 */
export function Heatmap({ cells }: { cells: HourCell[] }) {
  const [hover, setHover] = useState<HourCell | null>(null);
  const byKey = new Map(cells.map((c) => [`${c.dayOfWeek}:${c.hour}`, c.weightedK]));
  const max = Math.max(...cells.map((c) => c.weightedK), 1);
  const step = (v: number) => {
    if (v <= 0) return null;
    const i = Math.min(BLUE_RAMP.length - 1, Math.floor((v / max) * (BLUE_RAMP.length - 1) + 0.5));
    return BLUE_RAMP[i]!;
  };
  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[34rem]">
          <div className="grid grid-cols-[2.2rem_repeat(24,1fr)] gap-[2px]">
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="text-[9px] text-muted-foreground text-center tabular-nums">
                {h % 6 === 0 ? h : ""}
              </div>
            ))}
            {DAYS.map((label, day) => (
              <Fragment key={label}>
                <div className="text-[10px] text-muted-foreground pr-1 self-center">
                  {label}
                </div>
                {Array.from({ length: 24 }, (_, hour) => {
                  const v = byKey.get(`${day}:${hour}`) ?? 0;
                  const fill = step(v);
                  return (
                    <div
                      key={`${day}:${hour}`}
                      className={`h-3.5 rounded-[2px] ${fill ? "" : "bg-muted"}`}
                      style={fill ? { background: fill } : undefined}
                      onMouseEnter={() => setHover({ dayOfWeek: day, hour, weightedK: v })}
                      onMouseLeave={() => setHover(null)}
                      title={`${label} ${String(hour).padStart(2, "0")}:00 — ${Math.round(v).toLocaleString()}k`}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {hover
            ? `${DAYS[hover.dayOfWeek]} ${String(hover.hour).padStart(2, "0")}:00 — ${Math.round(hover.weightedK).toLocaleString()}k weighted tokens`
            : "local time · darker means more burned"}
        </span>
        <span className="flex items-center gap-1">
          less
          {BLUE_RAMP.map((c) => (
            <span key={c} className="inline-block h-2 w-3 rounded-[1px]" style={{ background: c }} />
          ))}
          more
        </span>
      </div>
    </div>
  );
}

export interface TimelinePoint {
  ts: number;
  headroom: number;
  blacked: boolean;
}

/**
 * Projected headroom over time, with blackout stretches called out in the
 * reserved critical colour plus a label — never colour alone.
 */
export function Timeline({ points, height = 120 }: { points: TimelinePoint[]; height?: number }) {
  const [hover, setHover] = useState<TimelinePoint | null>(null);
  if (points.length < 2) {
    return <div className="text-xs text-muted-foreground">not enough forecast to plot</div>;
  }
  const W = 100;
  const max = Math.max(...points.map((p) => p.headroom), 1);
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => height - (v / max) * (height - 8) - 4;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.headroom).toFixed(2)}`).join(" ");
  const area = `${line} L${W},${height} L0,${height} Z`;

  const bands: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    if (!points[i]!.blacked) continue;
    const start = i;
    while (i + 1 < points.length && points[i + 1]!.blacked) i++;
    bands.push([start, i]);
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="projected total headroom over the forecast horizon"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          setHover(points[Math.min(points.length - 1, Math.max(0, Math.round(frac * (points.length - 1))))] ?? null);
        }}
      >
        {bands.map(([a, b]) => (
          <rect
            key={a}
            x={x(a)}
            y={0}
            width={Math.max(0.4, x(b) - x(a))}
            height={height}
            fill={CRITICAL}
            opacity={0.16}
          />
        ))}
        <path d={area} style={{ fill: "var(--acct-series-0)" }} opacity={0.14} />
        <path d={line} fill="none" style={{ stroke: "var(--acct-series-0)" }} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {hover && (
          <line
            x1={x(points.indexOf(hover))}
            x2={x(points.indexOf(hover))}
            y1={0}
            y2={height}
            className="stroke-border"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {hover
            ? `${new Date(hover.ts * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })} — ` +
              `${Math.round(hover.headroom)} points headroom${hover.blacked ? " · all accounts walled" : ""}`
            : "total headroom across every account"}
        </span>
        {bands.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-[1px]" style={{ background: CRITICAL, opacity: 0.35 }} />
            no capacity
          </span>
        )}
      </div>
    </div>
  );
}

/** The counterfactual: blackout hours per week against account count. */
export function SlotCurve({ points, actual }: { points: { slots: number; blackoutHoursPerWeek: number }[]; actual: number }) {
  const max = Math.max(...points.map((p) => p.blackoutHoursPerWeek), 1);
  return (
    <div className="space-y-1.5">
      {points.map((p) => (
        <div key={p.slots} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2">
          <span className={`text-xs tabular-nums ${p.slots === actual ? "text-foreground font-medium" : "text-muted-foreground"}`}>
            {p.slots} slot{p.slots === 1 ? "" : "s"}
          </span>
          <svg width="100%" height="10" role="img" aria-label={`${p.slots} accounts: ${p.blackoutHoursPerWeek.toFixed(1)} hours per week without capacity`}>
            <rect x="0" y="0" width="100%" height="10" rx="4" className="fill-muted" />
            <rect
              x="0"
              y="0"
              width={`${Math.max(0.5, (p.blackoutHoursPerWeek / max) * 100)}%`}
              height="10"
              rx="4"
              fill={CRITICAL}
              opacity={p.slots === actual ? 1 : 0.45}
            />
          </svg>
          <span className="text-xs tabular-nums text-muted-foreground">
            {p.blackoutHoursPerWeek.toFixed(1)}h/wk{p.slots === actual ? " · today" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
