import type { CodexForecast } from '../analytics/codex-forecast.ts';

/** Transport/empty/partial responses change freshness, never the known series roster. */
export function settleCodexForecast(previous: CodexForecast[], result: PromiseSettledResult<CodexForecast[]>): CodexForecast[] {
  const key = (f: CodexForecast) => JSON.stringify([f.accountId,f.window,f.durationMins]);
  const rows = new Map(previous.map(f => [key(f), {...f,confidence:'stale' as const,ratePerHour:null,points:[]} as CodexForecast]));
  if (result.status==='fulfilled') for (const f of result.value) rows.set(key(f),f);
  return [...rows.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,f])=>f);
}
