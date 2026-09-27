import type { CodexBreakdown } from "../analytics/codex.ts";
import { BarList, type Slice } from "./charts.tsx";
import { LoadingBlock } from "./ui.tsx";

/** Both providers share the chart; only the explicitly named measurement differs. */
export function UsageBreakdown({ provider, metric, slices, loading = false, error = null, children }: {
  provider: string; metric: string; slices: Slice[]; loading?: boolean; error?: string | null;
  children?: React.ReactNode;
}) {
  return <div className="min-w-0 space-y-3" aria-label={`${provider} usage breakdown`}>
    <div className="flex flex-wrap items-baseline justify-between gap-1">
      <h3 className="text-xs font-medium text-foreground">{provider}</h3>
      <span className="text-xs text-muted-foreground">{metric}</span>
    </div>
    {loading ? <LoadingBlock label={`Loading ${provider} usage`} /> : error
      ? <p role="status" className="text-xs text-muted-foreground">{error}</p>
      : <><BarList slices={slices} order={slices.map(r => r.key)} unit="k" />{children}</>}
  </div>;
}

export function CodexTokens({ rows, loading = false, error = null }: {
  rows: CodexBreakdown[]; loading?: boolean; error?: string | null;
}) {
  return <UsageBreakdown provider="Codex" metric="Measured tokens · thousands" loading={loading} error={error}
    slices={rows.map(r => ({key:r.key, messages:r.responses, weightedK:r.totalTokens / 1000}))}>
    {rows.length > 0 && <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer hover:text-foreground">Token details</summary>
      <p className="mt-2">Native session responses. Input includes cached input; reasoning is part of output. Tokens do not measure subscription quota.</p>
      <div className="mt-3 space-y-3">{rows.map(r => <div key={r.key} className="min-w-0">
        <div className="truncate font-medium text-foreground" title={r.key}>{r.key}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
          <span>Total {r.totalTokens.toLocaleString()}</span><span>Input {r.inputTokens.toLocaleString()}</span>
          <span>Cached {r.cacheReadTokens.toLocaleString()}</span><span>Output {r.outputTokens.toLocaleString()}</span>
          <span>Reasoning {r.reasoningTokens.toLocaleString()}</span>
        </div>
      </div>)}</div>
    </details>}
  </UsageBreakdown>;
}
