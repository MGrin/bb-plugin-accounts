import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Timeline} from './charts.tsx';
import {CodexTokens} from './codex-analytics.tsx';
import type {CodexForecast} from '../analytics/codex-forecast.ts';
const forecast:CodexForecast={accountId:'a',label:'Account A',window:'primary',durationMins:300,confidence:'fitted',polls:1441,neededPolls:1440,observedAt:100,usedPercent:25,resetsAt:200,ratePerHour:2,points:[{ts:100,remaining:75},{ts:200,remaining:70}]};
test('forecast overlays use common timestamps and separate labeled scales; thin history has no path',()=>{
 const html=renderToStaticMarkup(createElement(Timeline,{points:[{ts:100,headroom:200,blacked:false},{ts:300,headroom:0,blacked:true}],codex:[forecast,{...forecast,accountId:'b',label:'Account B',confidence:'provisional',points:[]}]}));
 assert.match(html,/Claude.*200/);assert.match(html,/Codex.*100%/);assert.match(html,/Account A.*primary/);assert.match(html,/Account B.*provisional/);
 assert.match(html,/data-codex-series="a:primary"/);assert.doesNotMatch(html,/data-codex-series="b:primary"/);
 // Codex reset at 200 is halfway across the common 100..300 time axis.
 assert.match(html,/M0.00,32.00 L50.00,37.60/);
});
test('Codex raw breakdown prints input/output/cache provenance without adding cache twice',()=>{
 const html=renderToStaticMarkup(createElement(CodexTokens,{rows:[{key:'gpt-6',responses:1,inputTokens:100,outputTokens:20,cacheReadTokens:60,cacheWriteTokens:0,reasoningTokens:5,totalTokens:120}]}));
 assert.match(html,/gpt-6/);assert.match(html,/120/);assert.match(html,/Input includes cached input/);assert.match(html,/60/);assert.doesNotMatch(html,/weighted/i);
});
