import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {MIGRATIONS} from './schema.ts';
import {unknownCodex} from '../telemetry.ts';
import {recordCodexWindows,readCodexForecast,fitCodexWindow} from './codex-forecast.ts';
const start=1_790_000_000, now=start+1440*180;
const samples=Array.from({length:1441},(_,i)=>({at:start+i*180,used:i%100,reset:start+(Math.floor(i/100)+1)*18000}));
test('Codex confidence requires own three-day history and ignores reset deltas and long gaps',()=>{
 const base={accountId:'a',label:'A',window:'primary',durationMins:300};
 const thin=fitCodexWindow(base,samples.slice(-20),now); assert.equal(thin.confidence,'provisional'); assert.deepEqual(thin.points,[]);
 const full=fitCodexWindow(base,samples,now);assert.equal(full.confidence,'fitted');assert.equal(full.ratePerHour,20);
 assert.equal(full.points.at(-1)!.ts,samples.at(-1)!.reset);assert.ok(full.points.every(p=>p.remaining>=0&&p.remaining<=100));
 assert.equal(fitCodexWindow(base,samples,now+181).confidence,'stale');
 const gaps=samples.map((s,i)=>({...s,at:start+i*900,reset:start+2_000_000}));
 assert.equal(fitCodexWindow(base,gaps,gaps.at(-1)!.at).confidence,'provisional');
});
test('records only fresh main subscription windows, dedupes polls and keeps account histories separate',()=>{
 const db=new Database(':memory:');for(const m of MIGRATIONS)db.exec(m);
 const row={...unknownCodex(),accountId:'a',label:'A',scope:'account' as const,slot:'a',fresh:true,observedAt:now,capacity:'available' as const,
 windows:[{bucket:'codex',key:'primary',usedPercent:30,resetsAt:now+300,durationMinutes:300,reportedStatus:null}]};
 recordCodexWindows(db,[row],now);recordCodexWindows(db,[row],now);
 recordCodexWindows(db,[{...row,accountId:'b',windows:row.windows.map(w=>({...w,usedPercent:90}))}],now);
 recordCodexWindows(db,[{...row,accountId:'stale',observedAt:now-181},{...row,accountId:'spark',windows:row.windows.map(w=>({...w,bucket:'spark'}))}],now);
 const fc=readCodexForecast(db,now); assert.equal(fc.length,2);assert.deepEqual(fc.map(f=>f.polls),[1,1]);
 assert.deepEqual(fc.map(f=>f.usedPercent),[30,90]);db.close();
});
