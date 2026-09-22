import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { unknownCodex } from './telemetry.ts';
register('./tests/sdk-loader.mjs', import.meta.url);
const { default: plugin } = await import('./server.ts');
const account = { slot: 'live', email: 'live@example.test', active: true, fiveHour: 20, sevenDay: 40, fiveHourResetsAt: null, sevenDayResetsAt: null, credits: 'off' as const, creditSpend: null };
const failed = makeThreadResponse({ id: 'stuck', providerId: 'claude-code', status: 'error', updatedAt: Date.now() });

test('OAuth failures are tracked without attempting a model downgrade', async () => {
  const { bb, harness } = createFakePluginHost({pluginId:'accounts', settings:{autoSwitch:false}});
  try {
    await plugin(bb as any, {readClaudeUsage:async()=>({polledAt:null,accounts:[]}),readCodexSnapshot:async()=>unknownCodex()});
    await harness.behavior.emitThreadEvent('thread.failed',{thread:failed,error:'Failed to authenticate: OAuth session expired and could not be refreshed'});
    assert.equal((await bb.storage.kv.get<any[]>('stuck-threads'))?.[0].threadId,'stuck');
    assert.ok(harness.inspection.sdk.calls.every(c=>!String(c.method).includes('defaultExecutionOptions')));
  } finally {await harness.lifecycle.dispose();}
});

test('failed capacity is UNKNOWN in the legacy account list', async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'accounts'});
  try {
    await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:Date.now()/1000,accounts:[{...account,fiveHour:null,sevenDay:null,error:'reauthentication required',authState:'reauth-required' as const}]}),readCodexSnapshot:async()=>unknownCodex()});
    const result=await harness.behavior.runCli(['list']);
    assert.match(result.stdout!,/UNKNOWN/); assert.match(result.stdout!,/reauthentication required/); assert.doesNotMatch(result.stdout!,/\b0%/);
  } finally {await harness.lifecycle.dispose();}
});

for (const mode of ['retry','queued','unknown','weekly-unknown','unreadable','older-poll','unrelated-queue'] as const) test(`recovery ${mode} preserves the failed request and requires known active capacity`,async()=>{
  let retries=0,sends=0,queueSends=0;
  const {bb,harness}=createFakePluginHost({pluginId:'accounts',settings:{autoSwitch:true},sdk:{threads:{
    list:async()=>[],get:async()=>failed,events:{list:async()=>[{type:'client/turn/requested',data:{requestId:'turn'}}] as any},
    retry:async()=>{retries++;return {ok:true,delivery:'sent',attempt:2,turnRequestId:'turn'};},
    send:async()=>{sends++;throw new Error('must not fabricate a user message');},
    queuedMessages:{list:async()=>(mode==='queued'||mode==='unrelated-queue')?[{id:'q',createdAt:1,payload:{kind:'retry',retryOfTurnRequestId:mode==='unrelated-queue'?'old-turn':'turn'}}] as any:[],send:async()=>{queueSends++;return {ok:true,delivery:'sent'} as any;}},
  }}});
  try {
    await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:(Date.now()-(mode==='older-poll'?5000:0))/1000,accounts:[{...account,fiveHour:mode==='unknown'?null:20,sevenDay:mode==='weekly-unknown'?null:40}]}),readCodexSnapshot:async()=>unknownCodex(),runClaudeAccount:async()=>{if(mode==='unreadable')throw new Error('unavailable');return 'live';}} as any);
    await bb.storage.kv.set('stuck-threads',[{threadId:'stuck',providerId:'claude-code',firstFailedAt:Date.now()-1000,lastFailedAt:Date.now()-1000,lastAttemptAt:null,attempts:0}]);
    await harness.behavior.runSchedule('watch');
    assert.equal(sends,0);
    assert.equal(retries,(mode==='retry'||mode==='unrelated-queue')?1:0);
    assert.equal(queueSends,mode==='queued'?1:0);
  } finally {await harness.lifecycle.dispose();}
});

test('concurrent failures retain every thread in recovery tracking',async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'accounts',settings:{autoSwitch:false}});
  try {
    await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:null,accounts:[]}),readCodexSnapshot:async()=>unknownCodex()});
    await Promise.all(Array.from({length:12},(_,i)=>harness.behavior.emitThreadEvent('thread.failed',{thread:{...failed,id:`failed-${i}`},error:'429 usage limit reached'})));
    assert.equal((await bb.storage.kv.get<any[]>('stuck-threads'))?.length,12);
  } finally {await harness.lifecycle.dispose();}
});

test('reconciliation adopts OAuth failures from events and ignores an older blocked quota for other errors',async()=>{
  const auth={...failed,id:'auth'},other={...failed,id:'other'};
  const {bb,harness}=createFakePluginHost({pluginId:'accounts',sdk:{threads:{list:async()=>[auth,other],events:{list:async(args:any)=>[
    {type:'provider/error',data:{message:args.threadId==='auth'?'Failed to authenticate: OAuth session expired and could not be refreshed':'ENOENT missing file'}},
    {type:'turn/started',data:{}},
    {type:'provider/rateLimits/updated',data:{rateLimits:{providerId:'claude-code',status:'blocked'}}},
  ] as any}}}});
  try {
    await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:null,accounts:[]}),readCodexSnapshot:async()=>unknownCodex()});
    await harness.behavior.runSchedule('watch');
    assert.deepEqual((await bb.storage.kv.get<any[]>('stuck-threads'))?.map(r=>r.threadId),['auth']);
  } finally {await harness.lifecycle.dispose();}
});

test('generic failure still recognizes blocked quota from the current turn',async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'accounts',settings:{autoSwitch:false},sdk:{threads:{events:{list:async()=>[
    {type:'provider/error',data:{message:'Provider request failed'}},
    {type:'provider/rateLimits/updated',data:{rateLimits:{providerId:'claude-code',status:'blocked'}}},
    {type:'turn/started',data:{}},
  ] as any}}}});
  try {
    await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:null,accounts:[]}),readCodexSnapshot:async()=>unknownCodex()});
    await harness.behavior.emitThreadEvent('thread.failed',{thread:failed,error:null});
    assert.equal((await bb.storage.kv.get<any[]>('stuck-threads'))?.[0].threadId,'stuck');
  } finally {await harness.lifecycle.dispose();}
});

test('the current provider OAuth failure outranks an older system limit error',async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'accounts',sdk:{threads:{events:{list:async()=>[
    {type:'provider/error',data:{message:'Failed to authenticate: OAuth session expired and could not be refreshed'}},
    {type:'turn/started',data:{}},
    {type:'system/error',data:{message:'429 usage limit reached'}},
  ] as any},defaultExecutionOptions:async()=>{throw new Error('must never inspect downgrade model');}}}});
  let reads=0;
  try {
    await plugin(bb as any,{readClaudeUsage:async()=>{reads++;return {polledAt:null,accounts:[]};},readCodexSnapshot:async()=>unknownCodex()});
    await harness.behavior.emitThreadEvent('thread.failed',{thread:failed,error:'429 usage limit reached'});
    assert.equal((await bb.storage.kv.get<any[]>('stuck-threads'))?.[0].threadId,'stuck');
    assert.equal(reads,0);
  } finally {await harness.lifecycle.dispose();}
});

test('outage CLI never announces free capacity when every quota is unreadable',async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'accounts'});
  try {
    await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:Date.now()/1000,accounts:[{...account,fiveHour:null,sevenDay:null,error:'reauthentication required'}]}),readCodexSnapshot:async()=>unknownCodex()});
    const result=await harness.behavior.runCli(['outage']);
    assert.match(result.stdout!,/UNKNOWN|unknown/);
    assert.doesNotMatch(result.stdout!,/at least one account has a free window|live\s+usable/);
  } finally {await harness.lifecycle.dispose();}
});
