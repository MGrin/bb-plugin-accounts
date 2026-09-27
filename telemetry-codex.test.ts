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
