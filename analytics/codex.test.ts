import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS } from './schema.ts';
import { readCursors, writeCursor, unresolvedCwds, writeCwdRepo } from './store.ts';
import { scanTranscripts } from './scan.ts';
import { parseCodexLine, writeCodexRows, codexBreakdown, codexCoverage } from './codex.ts';
const line = (type: string, payload: object) => JSON.stringify({type, timestamp:'2026-09-27T00:00:00Z',payload});
const ctx = line('turn_context',{turn_id:'t1',model:'gpt-6',cwd:'/repo'});
const usage = line('token_usage_record',{turn_id:'t1',session_id:'s1',response_id:'r1',usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20,total_tokens:120},turn_token_usage:{input_tokens:9000},thread_token_usage:{input_tokens:99000}});
function db() { const d=new Database(':memory:'); for(const m of MIGRATIONS)d.exec(m); return d; }
test('Codex per-response tokens join late context, dedupe replay and keep cache inside input',()=>{
 const d=db(); const r=parseCodexLine(usage)!; writeCodexRows(d,[r,r]);
 assert.equal(codexBreakdown(d,'model',0)[0]!.key,'unknown');
 writeCodexRows(d,[parseCodexLine(ctx)!]);
 assert.deepEqual(codexBreakdown(d,'model',0),[{key:'gpt-6',responses:1,inputTokens:100,outputTokens:20,cacheReadTokens:60,cacheWriteTokens:0,reasoningTokens:0,totalTokens:120}]);
 assert.deepEqual(unresolvedCwds(d),['/repo']); writeCwdRepo(d,'/repo','MGrin/example','git',1);
 assert.equal(codexBreakdown(d,'repo',0)[0]!.key,'MGrin/example');
 assert.equal(codexBreakdown(d,'cwd',0)[0]!.key,'/repo');
 assert.equal(codexCoverage(d).responses,1);
 assert.equal(d.prepare('SELECT COUNT(*) AS n FROM transcript_msg').get().n,0);
 d.close();
});
test('Codex malformed or cumulative-only records are not silently zero token responses',()=>{
 for(const payload of [{turn_id:'t',response_id:'r',turn_token_usage:{input_tokens:10}}, {turn_id:'t',response_id:'r',usage:{input_tokens:-1,output_tokens:1}}, {turn_id:'t',response_id:'r',usage:{input_tokens:10,cached_input_tokens:11,output_tokens:1}}]) assert.equal(parseCodexLine(line('token_usage_record',payload)),null);
 assert.equal(parseCodexLine(line('response_item',{text:'not stored'})),null);
});
test('Codex recursive incremental scan keeps partial records and dedupes copied responses',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-index-')); const d=db();
 try {
  const dir=path.join(root,'2026','09','27'); await mkdir(dir,{recursive:true}); const file=path.join(dir,'session.jsonl');
  await writeFile(file,ctx+'\n'+usage.slice(0,80));
  const scan=()=>scanTranscripts(root,readCursors(d),(rows,file,cursor)=>{writeCodexRows(d,rows);writeCursor(d,file,cursor);},parseCodexLine,true);
  await scan(); assert.equal(codexCoverage(d).responses,0);
  await appendFile(file,usage.slice(80)+'\n'); await scan(); assert.equal(codexCoverage(d).responses,1);
  await writeFile(path.join(dir,'fork.jsonl'),usage+'\n'); await scan(); assert.equal(codexCoverage(d).responses,1);
  assert.equal((await scan()).filesRead,0);
 }finally{d.close();await rm(root,{recursive:true,force:true});}
});
