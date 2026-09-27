// Independent measured subscription history. No token weights or Claude demand inputs.
import type { Database } from 'better-sqlite3';
import {z} from 'zod';
import type {ProviderAccount} from '../telemetry.ts';
export const codexForecastShape=z.object({
 accountId:z.string(),label:z.string(),window:z.string(),durationMins:z.number(),
 confidence:z.enum(['provisional','fitted','stale']),polls:z.number(),neededPolls:z.number(),
 observedAt:z.number(),usedPercent:z.number(),resetsAt:z.number(),ratePerHour:z.number().nullable(),
 points:z.array(z.object({ts:z.number(),remaining:z.number()})),
});
export type CodexForecast=z.infer<typeof codexForecastShape>;
type Identity=Pick<CodexForecast,'accountId'|'label'|'window'|'durationMins'>;
type Sample={at:number;used:number;reset:number};
export function fitCodexWindow(identity:Identity,samples:Sample[],now:number):CodexForecast {
 const last=samples.at(-1)!;
 let delta=0,seconds=0,pairs=0;
 for(let i=1;i<samples.length;i++) {
  const a=samples[i-1]!,b=samples[i]!,dt=b.at-a.at;
  // Reset changes, decreases, missing polls, and expired readings are not demand.
  if(dt<=0||dt>600||a.reset!==b.reset||a.reset<=b.at||b.used<a.used)continue;
  delta+=b.used-a.used;seconds+=dt;pairs++;
 }
 const stale=now-last.at>180||last.at>now||last.reset<=now;
 const fitted=samples.length>=1440&&last.at-samples[0]!.at>=3*86400&&pairs>=1296;
 const confidence=stale?'stale':fitted?'fitted':'provisional';
 const rate=confidence==='fitted'?delta/seconds:null;
 const points:CodexForecast['points']=[];
 if(rate!==null) {
  // Start at the measured point and end at this epoch's reset; never invent a refill.
  const end=last.reset;
  for(let i=0;i<=96;i++) {const ts=last.at+(end-last.at)*i/96;points.push({ts,remaining:Math.max(0,100-last.used-rate*(ts-last.at))});}
 }
 return {...identity,confidence,polls:samples.length,neededPolls:1440,observedAt:last.at,
 usedPercent:last.used,resetsAt:last.reset,ratePerHour:rate===null?null:rate*3600,points};
}
export function recordCodexWindows(db:Database,rows:ProviderAccount[],now:number):void {
 const stmt=db.prepare('INSERT OR IGNORE INTO codex_window_sample VALUES (?,?,?,?,?,?,?)');
 db.transaction(()=>{for(const row of rows) {
  const at=row.observedAt;
  if(row.providerId!=='codex'||!row.accountId||!row.fresh||at===null||now-at<0||now-at>180||row.capacity==='unknown')continue;
  for(const w of row.windows) {
   if(w.bucket!=='codex'||w.usedPercent===null||!Number.isFinite(w.usedPercent)||w.usedPercent<0||w.usedPercent>100||
      w.resetsAt===null||w.resetsAt<=now||w.durationMinutes===null||w.durationMinutes<=0)continue;
   stmt.run(row.accountId,row.label,w.key,w.durationMinutes,at,w.usedPercent,w.resetsAt);
  }
 }})();
}
export function readCodexForecast(db:Database,now:number):CodexForecast[] {
 const rows=db.prepare(`SELECT account_id AS accountId,label,window,duration_mins AS durationMins,at,used,reset
   FROM codex_window_sample WHERE at>=? ORDER BY account_id,window,duration_mins,at`).all(now-30*86400) as (Identity&Sample)[];
 const groups=new Map<string,(Identity&Sample)[]>();
 for(const row of rows){const key=JSON.stringify([row.accountId,row.window,row.durationMins]);const g=groups.get(key)??[];g.push(row);groups.set(key,g);}
 return [...groups.values()].map(samples=>{const r=samples.at(-1)!;return fitCodexWindow({accountId:r.accountId,label:r.label,window:r.window,durationMins:r.durationMins},samples,now);});
}
