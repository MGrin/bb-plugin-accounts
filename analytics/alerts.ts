// When to actually interrupt someone. Pure.
//
// There is a standing instruction on this machine never to raise or escalate
// Claude usage limits — it exists because agents nagging mid-task about quota
// is worse than the quota running out. These two alerts were asked for
// explicitly and are scoped so as not to re-create that:
//
//   - They are about AGGREGATE capacity, never one account approaching a wall.
//     "This slot is at 94%" is exactly the nagging that was banned; "all three
//     are gone at 18:40 for four hours" is a plan you can make.
//   - They are never tied to a running task and never suggest conserving,
//     rescheduling, or working around anything.
//   - They fire at most once per predicted episode, and once per day.
//
// If they ever start reading as nagging, cut the weekly-pace class first. It is
// the one closer to the line.
import type { Forecast } from "./forecast.ts";

export interface AlertMemory {
  /** The blackout episode already alerted on, keyed to its predicted start hour. */
  blackoutEpisodeKey: string | null;
  /** Local YYYY-MM-DD of the last weekly-pace alert. */
  weeklyAlertedOn: string | null;
}

export const EMPTY_MEMORY: AlertMemory = { blackoutEpisodeKey: null, weeklyAlertedOn: null };

export type Alert =
  | { kind: "blackout"; title: string; message: string }
  | { kind: "weekly"; title: string; message: string };

export interface AlertPlan {
  fire: Alert[];
  memory: AlertMemory;
}

/** Fire the blackout alert when the predicted start is within this. */
export const BLACKOUT_LEAD_SEC = 3 * 3600;

/** Local hours, inclusive start, exclusive end, wrapping midnight. */
export type QuietHours = [number, number];
export const DEFAULT_QUIET: QuietHours = [22, 8];

export function inQuietHours(ts: number, [from, to]: QuietHours): boolean {
  const hour = new Date(ts * 1000).getHours();
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

const localDay = (ts: number): string => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Bucket the predicted start to the hour.
 *
 * A forecast recomputed every two minutes drifts by minutes constantly. Keying
 * the episode on the exact second would re-alert on every tick, which is the
 * failure mode that trains someone to ignore the alert entirely.
 */
const episodeKey = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 13);

const clock = (ts: number | null): string =>
  ts === null
    ? "unknown"
    : new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function planAlerts(
  forecast: Forecast,
  memory: AlertMemory,
  now: number,
  quiet: QuietHours = DEFAULT_QUIET,
): AlertPlan {
  const unchanged: AlertPlan = { fire: [], memory };

  // A forecast that does not know what it is talking about must not wake
  // anyone. This is the same gate the CLI uses to refuse to print times.
  if (forecast.confidence !== "fitted") return unchanged;
  if (inQuietHours(now, quiet)) return unchanged;

  const fire: Alert[] = [];
  const next: AlertMemory = { ...memory };

  const { likely, endsAt } = forecast.blackout;
  if (likely !== null && likely - now <= BLACKOUT_LEAD_SEC) {
    const key = episodeKey(likely);
    if (memory.blackoutEpisodeKey !== key) {
      next.blackoutEpisodeKey = key;
      const duration =
        endsAt === null
          ? "no recovery within the forecast horizon"
          : `back around ${clock(endsAt)} (~${Math.round((endsAt - likely) / 3600)}h)`;
      fire.push({
        kind: "blackout",
        title: "Claude: all accounts dry soon",
        message:
          `Every account is projected to be walled around ${clock(likely)} ` +
          `(${clock(forecast.blackout.earliest)}–${clock(forecast.blackout.latest)}). ${duration}.`,
      });
    }
  } else if (likely === null) {
    // The episode is over or was never real — forget it, so a genuinely new
    // one later is allowed to alert.
    next.blackoutEpisodeKey = null;
  }

  const slots = Object.entries(forecast.weeklyExhaustedAt);
  const allWeeklyGone = slots.length > 0 && slots.every(([, at]) => at !== null);
  if (allWeeklyGone) {
    const today = localDay(now);
    if (memory.weeklyAlertedOn !== today) {
      next.weeklyAlertedOn = today;
      const soonest = Math.min(...slots.map(([, at]) => at!));
      fire.push({
        kind: "weekly",
        title: "Claude: weekly windows on pace to run out",
        message:
          `At the current pace every 7-day window is projected to be spent before it resets — ` +
          `the first around ${clock(soonest)}.`,
      });
    }
  }

  return { fire, memory: next };
}
