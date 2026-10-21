import test from 'node:test';
import assert from 'node:assert/strict';
import * as telemetry from './telemetry.ts';
import * as source from './telemetry-source.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const now = 1_800_000_000;
export function slot(slot: string, used: number, active = false, at = now) {
  return { slot, accountId: slot, label: `${slot}@example.test`, active, observedAt: at, error: null,
    snapshot: {version: 1, codex_account_id: slot, codex_account_email: `${slot}@example.test`,
      codex_observed_at: at, codex: used === 100 ? 'exhausted' : 'available',
      codex_usage: {rateLimits: {limitId:'codex',primary:{usedPercent:used,resetsAt:now+3600,windowDurationMins:300},secondary:null},rateLimitsByLimitId:{}}}};
}
test('slot cache preserves two identities and active marker, rejects mismatch and stale evidence',()=>{
  assert.equal(typeof telemetry.normalizeCodexSlots,'function');
  const rows=telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',99,true),slot('two',10)]},now);
  assert.deepEqual(rows.map(r=>[r.slot,r.active,r.capacity]),[['one',true,'available'],['two',false,'available']]);
  const wrong=slot('one',10); wrong.snapshot.codex_account_id='two';
  assert.equal(telemetry.normalizeCodexSlots({version:1,accounts:[wrong]},now)[0].capacity,'unknown');
  assert.equal(telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',10,false,now-181)]},now)[0].capacity,'unknown');
  assert.equal(telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',10),slot('one',10)]},now)[0].capacity,'unknown');
});
test('selection requires stable active identity, fresh lower-use main quota, never credits or Spark',()=>{
  assert.equal(typeof telemetry.chooseCodexSlot,'function');
  const rows=telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',99,true),slot('two',10)]},now);
  assert.equal(telemetry.chooseCodexSlot(rows,'one',97,now),'two');
  assert.equal(telemetry.chooseCodexSlot(rows,'other',97,now),null);
  assert.equal(telemetry.chooseCodexSlot(rows,'one',97,now+181),null);
  const spent=slot('two',100); (spent.snapshot.codex_usage.rateLimits as any).credits={hasCredits:true,balance:'100'};
  (spent.snapshot.codex_usage.rateLimitsByLimitId as any)['codex-spark']={limitId:'codex-spark',primary:{usedPercent:0,resetsAt:now+3600},secondary:null};
  assert.equal(telemetry.chooseCodexSlot(telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',99,true),spent]},now),'one',97,now),null);
});
test('cache reader bounds files and rechecks freshness on every read',async()=>{
  assert.equal(typeof source.createCodexSlotReader,'function');
  const dir=await mkdtemp(path.join(os.tmpdir(),'codex-slots-')); const file=path.join(dir,'usage.json');
  try {
    let clock=now; const read=source.createCodexSlotReader(file,()=>clock);
    assert.equal((await read())[0].capacity,'unknown');
    await writeFile(file,JSON.stringify({version:1,accounts:[slot('one',20,true),slot('two',30)]}));
    assert.equal((await read()).length,2);
    clock+=181; assert.equal((await read())[0].capacity,'unknown');
    await writeFile(file,'x'.repeat(300000)); assert.equal((await read())[0].capacity,'unknown');
  } finally {await rm(dir,{recursive:true,force:true});}
});

// MX-1527: paused means NO request, so the cached row is the PREVIOUS observation.
test('a paused Codex slot keeps identity and last-known windows, reads PAUSED not unknown, and is never fresh',()=>{
  const p={...slot('two',10),paused:{at:now-30}};
  const rows=telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',99,true),p]},now);
  const two=rows.find(r=>r.slot==='two')!;
  assert.deepEqual(two.paused,{at:now-30});
  assert.equal(two.capacity,'unknown');
  assert.equal(two.fresh,false,'a retained observation is never fresh, even inside 180s');
  assert.match(two.reason,/^Paused since 20\d\d-\d\d-\d\dT.*Z — no requests made$/);
  assert.equal(two.windows.find(w=>w.bucket==='codex')?.usedPercent,10,'last-known usage stays visible');
  assert.equal(two.label,'two@example.test');
  assert.ok(!('paused' in rows.find(r=>r.slot==='one')!),'an unpaused row carries no paused key at all (RPC wire)');
});
test('selection never chooses a paused slot, even one that reads available and fresh',()=>{
  const rows=telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',99,true),slot('two',10),slot('three',20)]},now);
  const forced=rows.map(r=>r.slot==='two'?{...r,paused:{at:now-5}}:r);
  assert.equal(forced.find(r=>r.slot==='two')!.capacity,'available');
  assert.equal(telemetry.chooseCodexSlot(forced,'one',97,now),'three');
  assert.equal(telemetry.chooseCodexSlot(forced.filter(r=>r.slot!=='three'),'one',97,now),null);
});
test('a paused slot with no login on this Mac is shown, marked paused, and never chosen (MX-1527)',()=>{
  const away={slot:'new',accountId:null,label:'nikita@scani.xyz',active:false,observedAt:null,snapshot:null,error:null,
    paused:{at:1_761_048_480}};
  const rows=telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',99,true),away]},now);
  assert.deepEqual(rows.map(r=>[r.slot,r.label,r.capacity]),[['one','one@example.test','available'],['new','nikita@scani.xyz','unknown']]);
  assert.deepEqual(rows[1]!.paused,{at:1_761_048_480});
  assert.equal(rows[1]!.accountId,null);
  assert.match(rows[1]!.reason,/^Paused since/);
  assert.equal(telemetry.chooseCodexSlot(rows,'one',97,now),null);
  // CONTROL: a null identity WITHOUT the pause flag is still an invalid manifest.
  const bad=telemetry.normalizeCodexSlots({version:1,accounts:[slot('one',99,true),{...away,paused:undefined}]},now);
  assert.equal(bad.length,1);
  assert.match(bad[0]!.reason,/invalid or duplicate identity/);
});
