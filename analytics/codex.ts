// Native Codex structured fields only. Tokens are measured work, never quota.
import type { Database } from 'better-sqlite3';
import { z } from 'zod';

type Turn = { kind: 'turn'; turnId: string; model: string | null; cwd: string | null };
type Response = { kind: 'response'; turnId: string; responseId: string; sessionId: string; ts: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number };
export type CodexRow = Turn | Response;
const str = (x: unknown): string | null => typeof x === 'string' && x.length > 0 && x.length <= 4096 ? x : null;
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
export function parseCodexLine(line: string): CodexRow | null {
  try {
    const r = JSON.parse(line), p = r?.payload;
    if (!p || !str(p.turn_id)) return null;
    if (r.type === 'turn_context') return {kind:'turn',turnId:p.turn_id,model:str(p.model),cwd:str(p.cwd)};
    if (r.type !== 'token_usage_record' || !str(p.response_id) || !str(p.session_id)) return null;
    const u=p.usage, ts=Date.parse(r.timestamp)/1000;
    if (!u || !Number.isFinite(ts) || ts <= 0 || !count(u.input_tokens) || !count(u.output_tokens)) return null;
    for (const key of ['cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens'])
      if (u[key] !== undefined && !count(u[key])) return null;
    if ((u.cached_input_tokens ?? 0) > u.input_tokens || (u.reasoning_output_tokens ?? 0) > u.output_tokens) return null;
    if (u.total_tokens !== undefined && u.total_tokens !== u.input_tokens + u.output_tokens) return null;
    return {kind:'response',turnId:p.turn_id,responseId:p.response_id,sessionId:p.session_id,ts:Math.floor(ts),
      inputTokens:u.input_tokens,outputTokens:u.output_tokens,cacheReadTokens:u.cached_input_tokens ?? 0,
      cacheWriteTokens:u.cache_write_input_tokens ?? 0,reasoningTokens:u.reasoning_output_tokens ?? 0};
  } catch { return null; }
}
export function writeCodexRows(db: Database, rows: CodexRow[]): void {
  const turn=db.prepare(`INSERT INTO codex_turn (turn_id,model,cwd) VALUES (?,?,?)
    ON CONFLICT(turn_id) DO UPDATE SET model=COALESCE(excluded.model,model), cwd=COALESCE(excluded.cwd,cwd)`);
  // A fork may replay a response in another session file; response identity is global.
  const response=db.prepare(`INSERT OR IGNORE INTO codex_response VALUES (?,?,?,?,?,?,?,?,?)`);
  db.transaction(()=>{for(const r of rows) {
    if(r.kind==='turn')turn.run(r.turnId,r.model,r.cwd);
    else response.run(r.responseId,r.turnId,r.sessionId,r.ts,r.inputTokens,r.outputTokens,r.cacheReadTokens,r.cacheWriteTokens,r.reasoningTokens);
  }})();
}
export const codexBreakdownShape = z.object({key:z.string(),responses:z.number(),inputTokens:z.number(),outputTokens:z.number(),cacheReadTokens:z.number(),cacheWriteTokens:z.number(),reasoningTokens:z.number(),totalTokens:z.number()});
export type CodexBreakdown = z.infer<typeof codexBreakdownShape>;
export function codexBreakdown(db: Database, dimension: 'model'|'repo'|'cwd', since: number): CodexBreakdown[] {
  const key={model:"COALESCE(t.model,'unknown')",repo:"COALESCE(c.repo,'unresolved')",cwd:"COALESCE(t.cwd,'unknown')"}[dimension];
  return db.prepare(`SELECT ${key} AS key, COUNT(*) AS responses, SUM(r.input_tokens) AS inputTokens,
    SUM(r.output_tokens) AS outputTokens, SUM(r.cache_read_tokens) AS cacheReadTokens,
    SUM(r.cache_write_tokens) AS cacheWriteTokens, SUM(r.reasoning_tokens) AS reasoningTokens,
    SUM(r.input_tokens+r.output_tokens) AS totalTokens
    FROM codex_response r LEFT JOIN codex_turn t ON t.turn_id=r.turn_id
    LEFT JOIN cwd_repo c ON c.cwd=t.cwd WHERE r.ts>=? GROUP BY ${key} ORDER BY totalTokens DESC`).all(since) as CodexBreakdown[];
}
export function codexCoverage(db: Database): {responses:number; firstTs:number|null; lastTs:number|null; unattributed:number} {
  return db.prepare(`SELECT COUNT(*) AS responses, MIN(r.ts) AS firstTs, MAX(r.ts) AS lastTs,
    COALESCE(SUM(CASE WHEN t.model IS NULL OR t.cwd IS NULL THEN 1 ELSE 0 END),0) AS unattributed
    FROM codex_response r LEFT JOIN codex_turn t ON t.turn_id=r.turn_id`).get() as ReturnType<typeof codexCoverage>;
}
