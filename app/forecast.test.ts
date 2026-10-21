import test from 'node:test';
import assert from 'node:assert/strict';
import { settleCodexForecast } from './forecast.ts';
import type { CodexForecast } from '../analytics/codex-forecast.ts';
const row:CodexForecast={accountId:'a',label:'A',window:'primary',durationMins:300,confidence:'fitted',polls:1441,neededPolls:1440,observedAt:100,usedPercent:25,resetsAt:200,ratePerHour:2,points:[{ts:100,remaining:75},{ts:200,remaining:70}]};
test('failed, empty and partial refreshes retain series identities as UNKNOWN without old projections',()=>{
 const previous=[row,{...row,accountId:'b',label:'B'}];
 for(const result of [{status:'rejected',reason:new Error('timeout')},{status:'fulfilled',value:[]}] as PromiseSettledResult<CodexForecast[]>[]) {
  const next=settleCodexForecast(previous,result);
  assert.deepEqual(next.map(f=>f.accountId),['a','b']);
  assert.ok(next.every(f=>f.confidence==='stale'&&f.points.length===0&&f.ratePerHour===null));
 }
 const next=settleCodexForecast(previous,{status:'fulfilled',value:[{...row,accountId:'b',label:'B'}]});
 assert.deepEqual(next.map(f=>[f.accountId,f.confidence]),[['a','stale'],['b','fitted']]);
 const restored=settleCodexForecast(next,{status:'fulfilled',value:[previous[1]!,row]});
 assert.deepEqual(restored.map(f=>[f.accountId,f.confidence]),[['a','fitted'],['b','fitted']]);
});
