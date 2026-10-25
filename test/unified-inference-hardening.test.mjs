import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import { once } from 'node:events';
import { generate, stream } from '../dist/inference/run.js';
import { createServerModel } from '../dist/watch-intent-relay.js';
import * as api from '../dist/index.js';

const reply = (text='ok', extra={}) => ({ content:[{type:'text',text}],finishReason:'stop',usage:{inputTokens:1,outputTokens:1},warnings:[],...extra });
const fake = (extra={}) => ({specificationVersion:'v2',provider:'synthetic',modelId:'synthetic-model',supportedUrls:{},async doGenerate(){return reply('default',extra)},async doStream(){return {stream:new ReadableStream({start(c){c.close()}})}}});
const nativeConfig = (route, baseUrl, more={}) => JSON.stringify({route, model:'synthetic-native-model',baseUrl,...more});

describe('unified inference hardening',()=>{
 it('exposes generation, stream, decision and image execution as first-class library API',()=>{
  for(const name of ['generateInference','streamInference','decideInference','imageInference']) assert.equal(typeof api[name],'function',name);
 });
 it('keeps injected generation execution inside the receipt boundary',async()=>{
  const expected={text:'injected',finishReason:'stop',usage:{inputTokens:1,outputTokens:1}};const receipts=[];let calls=0;
  const actual=await generate({purpose:'operator_tick',onReceipt:r=>receipts.push(r)},{model:fake(),prompt:'synthetic'},async()=>{calls++;return expected});
  assert.equal(actual,expected);assert.equal(calls,1);assert.equal(receipts.length,1);assert.equal(receipts[0].status,'completed');
 });
 it('keeps injected stream execution inside completion handling',async()=>{
  const expected={synthetic:'stream'};const receipts=[];let captured;
  const actual=stream({purpose:'operator_tick',onReceipt:r=>receipts.push(r)},{model:fake(),prompt:'synthetic'},params=>{captured=params;return expected});
  assert.equal(actual,expected);assert.equal(receipts.length,0);await captured.onFinish({finishReason:'stop',steps:[]});assert.equal(receipts.length,1);
 });
 it('does not select injected operator implementations outside the unified boundary',()=>{
  const source=fs.readFileSync(new URL('../src/operator-daemon.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/cfg\.(?:generateTextImpl|streamTextImpl)\s*\?\?/);
 });
 it('labels evidence verification, correction and compaction instead of reporting every step as chat',()=>{
  const source=fs.readFileSync(new URL('../src/engine.ts',import.meta.url),'utf8');
  for(const purpose of ['verification','correction','compaction'])assert.ok(source.includes(`purpose: "${purpose}"`),purpose);
 });
 it('keeps arbitrary purpose and provider finish text out of receipts',async()=>{
  const receipts=[];const secret='private-source-text@fixture.invalid';
  await generate({purpose:secret,onReceipt:r=>receipts.push(r)},{model:fake({finishReason:secret}),prompt:'synthetic',maxRetries:0});
  assert.equal(receipts.length,1);assert.ok(!JSON.stringify(receipts).includes(secret));
 });
 it('never reports negative token counts',async()=>{
  const receipts=[];
  await generate({purpose:'chat',onReceipt:r=>receipts.push(r)},{model:fake({usage:{inputTokens:-3,outputTokens:-5}}),prompt:'synthetic',maxRetries:0});
  for(const v of Object.values(receipts[0].usage??{}))assert.ok(v===undefined||(Number.isSafeInteger(v)&&v>=0));
 });
 for(const raw of ['{bad', nativeConfig('openshell','http://127.0.0.1:1/v1',{credentialless:true})]){
  it('fails closed on malformed/native-sandbox configuration without cloud fallback: '+raw,()=>{
   assert.throws(()=>createServerModel({SPORTSCLAW_PROVIDER:'anthropic',SPORTSCLAW_MODEL:'synthetic-cloud-model',SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG:raw}));
  });
 }
 for(const route of ['nim','openshell']){
  it('uses the server-owned '+route+' route for watch interpretation',async()=>{
   let seen;const server=http.createServer((req,res)=>{let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{seen={url:req.url,authorization:req.headers.authorization,body:JSON.parse(raw)};res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic',object:'chat.completion',created:1,model:'synthetic-native-model',choices:[{index:0,message:{role:'assistant',content:'native'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));});});
   server.listen(0,'127.0.0.1');await once(server,'listening');
   try{
    const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
    const env={SPORTSCLAW_PROVIDER:'anthropic',SPORTSCLAW_MODEL:'synthetic-cloud-model',SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG:nativeConfig(route,baseUrl,route==='openshell'?{credentialEnv:'SYNTHETIC_PROFILE_KEY'}:{}),OPENSHELL_SANDBOX:'1',SYNTHETIC_PROFILE_KEY:'synthetic-profile-key'};
    const model=createServerModel(env);assert.equal(model.modelId,'synthetic-native-model','native model must win before any network');
    const result=await generate({purpose:'watch_intent',route},{model,prompt:'synthetic',maxRetries:0,abortSignal:AbortSignal.timeout(2000)});
    assert.equal(result.text,'native');assert.equal(seen.url,'/v1/chat/completions');
    if(route==='openshell')assert.equal(seen.authorization,'Bearer synthetic-profile-key');
   }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
  });
 }
});
