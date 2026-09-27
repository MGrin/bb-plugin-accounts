import type {CodexBreakdown} from '../analytics/codex.ts';
export function CodexTokens({rows}:{rows:CodexBreakdown[]}) {
 return <div className="mt-4 text-xs">
  <p className="text-muted-foreground mb-2">Codex measured tokens · native session responses. Input includes cached input; reasoning is part of output. Tokens do not measure subscription quota.</p>
  {rows.length===0?<p className="text-muted-foreground">No Codex responses indexed in this window.</p>:
   <div className="overflow-x-auto"><table className="w-full text-right tabular-nums">
    <thead><tr><th className="text-left">Model / project</th><th>Total</th><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th></tr></thead>
    <tbody>{rows.map(r=><tr key={r.key}><td className="text-left break-all pr-2">{r.key}</td>
     {[r.totalTokens,r.inputTokens,r.cacheReadTokens,r.outputTokens,r.reasoningTokens].map((v,i)=><td className="pl-2" key={i}>{v.toLocaleString()}</td>)}
    </tr>)}</tbody>
   </table></div>}
 </div>;
}
