import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { extractSlipProposal } from '../dist/slip-extraction.js';

const input={turn:{contract:'slip-turn-v1',requestText:'What is offside?',context:null},answerText:'Offside is a football rule.'};
const answer=JSON.stringify({status:'none',change:null});
function anthropicFixture(name){
 const requests=[];
 const provider=createAnthropic({apiKey:'synthetic-adapter-test',...(name?{name}:{}),fetch:async(url,init)=>{
  requests.push({url:String(url),body:JSON.parse(init.body)});
  return new Response(JSON.stringify({id:'msg_synthetic',type:'message',role:'assistant',model:'unknown-extraction-test-model',content:[{type:'text',text:answer}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}}),{status:200,headers:{'content-type':'application/json'}});
 }});
 return {requests,model:provider('unknown-extraction-test-model')};
}

test('actual Anthropic adapter uses native JSON, never its synthetic json tool, within total token ceiling',async()=>{
 const f=anthropicFixture();
 const providerOptions={anthropic:{thinking:{type:'enabled',budgetTokens:8192}}};
 const before=structuredClone(providerOptions);
 const r=await extractSlipProposal(input,{model:f.model,providerOptions});
 assert.equal(r.status,'none');assert.equal(f.requests.length,1);
 const b=f.requests[0].body;
 assert.equal(b.output_format?.type,'json_schema');
 assert.equal(b.tools?.length??0,0);assert.equal(b.tool_choice,undefined);
 assert.ok(b.max_tokens<=8192,`wire max_tokens=${b.max_tokens}`);
 assert.deepEqual(providerOptions,before,'caller options are not mutated');
});

test('actual Anthropic wire does not add thinking tokens above the total extraction ceiling',async()=>{
 const f=anthropicFixture();
 await extractSlipProposal(input,{model:f.model,providerOptions:{anthropic:{thinking:{type:'enabled',budgetTokens:8192}}}});
 assert.equal(f.requests.length,1);
 assert.ok(f.requests[0].body.max_tokens<=8192,`actual wire ceiling was ${f.requests[0].body.max_tokens}`);
});

test('custom Anthropic namespace cannot override native-only mode or raise the token ceiling',async()=>{
 const f=anthropicFixture('custom.messages');
 const r=await extractSlipProposal(input,{model:f.model,providerOptions:{anthropic:{thinking:{type:'enabled',budgetTokens:8192}},custom:{structuredOutputMode:'jsonTool',thinking:{type:'enabled',budgetTokens:16000}}}});
 assert.equal(r.status,'none');assert.equal(f.requests.length,1);
 const b=f.requests[0].body;
 assert.equal(b.output_format?.type,'json_schema');assert.equal(b.tools?.length??0,0);assert.equal(b.tool_choice,undefined);assert.ok(b.max_tokens<=8192);
});

test('unsupported Anthropic native output fails once without a synthetic-tool retry',async()=>{
 const requests=[];
 const model=createAnthropic({apiKey:'synthetic-unsupported-adapter',fetch:async(url,init)=>{
  requests.push(JSON.parse(init.body));
  return new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Native JSON unsupported for this synthetic model'}}),{status:400,headers:{'content-type':'application/json'}});
 }})('unknown-extraction-test-model');
 const r=await extractSlipProposal(input,{model});
 assert.equal(r.status,'failed');assert.equal(r.reasonCode,'inference_unavailable');assert.equal(requests.length,1);
 assert.equal(requests[0].output_format?.type,'json_schema');assert.equal(requests[0].tools?.length??0,0);assert.equal(requests[0].tool_choice,undefined);
});

test('provider-side MCP configuration is refused before any adapter dispatch',async()=>{
 const f=anthropicFixture();
 const r=await extractSlipProposal(input,{model:f.model,providerOptions:{anthropic:{mcpServers:[{type:'url',name:'unapproved',url:'https://example.invalid/mcp',authorizationToken:'synthetic-not-to-send'}]}}});
 assert.equal(r.status,'failed');assert.equal(f.requests.length,0);
});

test('Google native JSON request keeps its supported provider options and 8192 token ceiling',async()=>{
 const requests=[];
 const model=createGoogleGenerativeAI({apiKey:'synthetic-google-adapter',fetch:async(url,init)=>{
  requests.push(JSON.parse(init.body));
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:answer}]},finishReason:'STOP',index:0}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15},modelVersion:'gemini-3.5-flash'}),{status:200,headers:{'content-type':'application/json'}});
 }})('gemini-3.5-flash');
 const options={google:{thinkingConfig:{thinkingBudget:8192,includeThoughts:true}}};
 const r=await extractSlipProposal(input,{model,providerOptions:options});
 assert.equal(r.status,'none');assert.equal(requests.length,1);
 assert.equal(requests[0].generationConfig.maxOutputTokens,8192);
 assert.equal(requests[0].generationConfig.responseMimeType,'application/json');
 assert.deepEqual(requests[0].generationConfig.thinkingConfig,options.google.thinkingConfig);
 assert.ok(!JSON.stringify(requests[0]).includes('structuredOutputMode'));
});
