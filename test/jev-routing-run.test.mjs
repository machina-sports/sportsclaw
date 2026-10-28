// Run the actual engine refusal path in an isolated process. MCP init and tool
// construction are fixtures; run(), skill routing and Jev response parsing are real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const engineUrl = new URL('../dist/engine.js', import.meta.url).href;
const typesUrl = new URL('../dist/types.js', import.meta.url).href;

// Advisory shortlist (explicit user decision): a semantic clarify/unsupported
// is no longer a refusal (see the no-input test below). Invalid config, a
// local-only policy, auth/transport failure and abort still refuse here.
test('actual run refuses invalid, local-only, denied and aborted Jev routes even on follow-ups and in yolo mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-run-refusal-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^(SPORTSCLAW|MACHINA)_/.test(key)));
  env.HOME = home;
  env.SPORTSCLAW_MEMORY_BACKEND = 'file';
  const code = `
    import assert from 'node:assert/strict';
    const { sportsclawEngine } = await import(${JSON.stringify(engineUrl)});
    const { DEFAULT_CONFIG } = await import(${JSON.stringify(typesUrl)});
    let count = 0;
    for (const scenario of ['local', 'auth', 'invalid', 'abort']) {
      for (const followup of [false, true]) for (const yoloMode of [false, true]) {
        let httpCalls = 0, modelCalls = 0, toolCalls = 0;
        const transport = async (_url, init) => {
          httpCalls++;
          if (scenario === 'auth') return new Response('{}', {status:403});
          const questions = JSON.parse(init.body).questions;
          const answers = {};
          for (const [id, question] of Object.entries(questions)) {
            const choice = id === 'disposition' ? scenario : 'not_required';
            const labels = Object.keys(question.criteria);
            answers[id] = {type:'choice',choice,confidence:.98,
              probabilities:Object.fromEntries(labels.map(label=>[label,label===choice?.98:.02/(labels.length-1)]))};
          }
          return new Response(JSON.stringify({model:'jev-1.13.0',answers}),{status:200,headers:{'content-type':'application/json'}});
        };
        const engine = Object.create(sportsclawEngine.prototype);
        engine.config = {...DEFAULT_CONFIG, yoloMode, routing:{provider:'jev',dataPolicy:scenario==='local'?'local_only':'cloud_allowed',
          ...(scenario==='invalid' ? {model:'gpt-4'} : {}), env:{TYPESAFE_API_KEY:'synthetic-key'},transport}};
        engine.messages = followup ? [{role:'user',content:'NBA yesterday'},{role:'assistant',content:'Previous fixture answer'}] : [];
        engine.mainModel = {doGenerate(){modelCalls++;throw new Error('generative fallback must not run')}};
        engine.mainModelId = 'synthetic-main-model';
        const specs = ['nba','nfl'].map(skill=>({name:skill+'_get_scores',description:'scores',parameters:{}}));
        engine.registry = {getInstalledSkills:()=>['nba','nfl'],getAllToolSpecs:()=>specs,getSkillName:name=>name.split('_')[0]};
        engine.mcpManager = {serverCount:0,setUserId(){}};
        engine.initAsync = async()=>{};
        engine.buildTools = ()=>Object.fromEntries(specs.map(spec=>[spec.name,{execute(){toolCalls++;throw new Error('tool must not run')}}]));
        const controller = new AbortController();
        if (scenario==='abort') controller.abort();
        const answer = await engine.run('who is winning tonight',{abortSignal:controller.signal});
        assert.equal(modelCalls,0);assert.equal(toolCalls,0);
        assert.equal(httpCalls,['local','abort','invalid'].includes(scenario)?0:1);
        if (scenario==='abort') assert.equal(answer,'Request cancelled.');
        else assert.match(answer,/could not route/);
        assert.equal(engine.messages.at(-1).role,'assistant');
        count++;
      }
    }
    console.log(JSON.stringify({cases:count,modelCalls:0,toolCalls:0}));
  `;
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {env, encoding:'utf8', timeout:30000});
    assert.deepEqual(JSON.parse(output.trim()), {cases:16, modelCalls:0, toolCalls:0});
  } finally {
    rmSync(home, {recursive:true, force:true});
  }
});

const aiUrl = import.meta.resolve('ai');
const aiTestUrl = import.meta.resolve('ai/test');

/** Run `body` in a child process with a temp HOME and no credential-like env. */
function runIsolated(prefix, body) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^(SPORTSCLAW|MACHINA)_/.test(key)));
  env.HOME = home;
  env.SPORTSCLAW_MEMORY_BACKEND = 'file';
  const code = `
    import assert from 'node:assert/strict';
    const { sportsclawEngine } = await import(${JSON.stringify(engineUrl)});
    const { DEFAULT_CONFIG } = await import(${JSON.stringify(typesUrl)});
    const { tool, jsonSchema } = await import(${JSON.stringify(aiUrl)});
    const { MockLanguageModelV3 } = await import(${JSON.stringify(aiTestUrl)});
    const usage = {inputTokens:{total:10},outputTokens:{total:5},totalTokens:{total:15},reasoningTokens:{total:undefined}};
    const VERDICT_OK = () => JSON.stringify({isValid:true, discrepancies:[]});

    // Real run(); MCP init, tool construction and the system prompt are fixtures.
    // Every tool execution, model call, Jev request and credential read is counted.
    function harness({routing, messages = [], reply, attemptTools, parallelAgents = false, verdict}) {
      const counts = {http:0, tools:0, credentialReads:0, executed:[]};
      const bodies = [];
      const env = Object.defineProperty({}, 'TYPESAFE_API_KEY', {get(){counts.credentialReads++;return 'synthetic-key';}});
      const transport = async (_url, init) => {
        counts.http++; bodies.push(init.body);
        const body = JSON.parse(init.body);
        const answers = {};
        for (const [id, question] of Object.entries(body.questions)) {
          // routing.required: opaque refs (c0, c1, ...) answered 'required'; routing.confidence: every answer's.
          const chosen = id === 'disposition' ? routing.disposition : (routing.required ?? []).includes(id) ? 'required' : 'not_required';
          const labels = Object.keys(question.criteria);
          answers[id] = {type:'choice',choice:chosen,confidence:routing.confidence ?? .97,
            probabilities:Object.fromEntries(labels.map(label=>[label,label===chosen?1:0]))};
        }
        return new Response(JSON.stringify({model:body.model,answers}),{status:200,headers:{'content-type':'application/json'}});
      };
      let n = 0;
      const model = new MockLanguageModelV3({doGenerate: async (options) => {
        n++;
        // verdict, when given, answers the tool-less checker/editor calls.
        if (verdict && !options.tools?.length && /isValid|expert sports editor/.test(JSON.stringify(options.prompt))) {
          return {content:[{type:'text', text:verdict(options)}], finishReason:{unified:'stop', raw:undefined}, usage, warnings:[]};
        }
        const content = [{type:'text', text:reply}];
        // A scripted model that tries tools despite any toolChoice: true is the default set, or a list of names.
        const attempted = attemptTools === true ? ['nba_get_scores','spawn_subagent','mcp__unrelated','update_fan_profile'] : (attemptTools || []);
        for (const name of attempted) {
          content.push({type:'tool-call', toolCallId:name+'-'+n, toolName:name, input:name==='spawn_subagent'?JSON.stringify({prompt:'dig in'}):'{}'});
        }
        return {content, finishReason:{unified:attempted.length?'tool-calls':'stop', raw:undefined}, usage, warnings:[]};
      }});
      const skills = ['nba','nfl'];
      const specs = skills.map(skill=>({name:skill+'_get_scores',description:'scores',parameters:{}}));
      const toolNames = [...specs.map(spec=>spec.name), 'spawn_subagent', 'update_fan_profile', 'mcp__unrelated'];
      const engine = Object.create(sportsclawEngine.prototype);
      engine.config = {...DEFAULT_CONFIG, maxTurns:3, parallelAgents,
        routing:{provider:'jev', dataPolicy:routing.dataPolicy ?? 'cloud_allowed', env, transport,
          ...(routing.publicDataTools === undefined ? {} : {publicDataTools:routing.publicDataTools})}};
      engine.messages = messages;
      engine.mainModel = model;
      engine.mainModelId = 'synthetic-main-model';
      engine.registry = {getInstalledSkills:()=>skills, getAllToolSpecs:()=>specs,
        getSkillName:name=>skills.includes(name.split('_')[0]) ? name.split('_')[0] : undefined};
      engine.mcpManager = {serverCount:0,setUserId(){}};
      engine.initAsync = async()=>{};
      engine.buildSystemPrompt = () => 'SYNTHETIC_MAIN_SYSTEM';
      engine.buildTools = () => Object.fromEntries(toolNames.map(name=>[name, tool({description:name,
        inputSchema:jsonSchema({type:'object',properties:{}}), execute:async()=>{counts.tools++;counts.executed.push(name);return 'TOOL_RAN';}})]));
      return {engine, model, counts, bodies};
    }
    ${body}
  `;
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {env, encoding:'utf8', timeout:30000});
    return JSON.parse(output.trim().split('\n').at(-1));
  } finally {
    rmSync(home, {recursive:true, force:true});
  }
}

test('actual run answers an explicit no_tools follow-up with tool execution code-disabled', () => {
  const result = runIsolated('jev-run-no-tools-', `
    // Retained tool history: a prior turn really called nba_get_scores.
    const messages = [
      {role:'user', content:'PRIOR_USER_MARKER how did the Lakers do'},
      {role:'assistant', content:[{type:'text',text:'Checking.'},{type:'tool-call',toolCallId:'prior-1',toolName:'nba_get_scores',input:{}}]},
      {role:'tool', content:[{type:'tool-result',toolCallId:'prior-1',toolName:'nba_get_scores',output:{type:'json',value:{home:101,away:99}}}]},
      {role:'assistant', content:[{type:'text',text:'Lakers won 101-99.'}]},
    ];
    const {engine, model, counts, bodies} = harness({routing:{disposition:'no_tools'}, messages,
      reply:'NO_TOOLS_REPLY', attemptTools:true, parallelAgents:true});
    const answer = await engine.run('Hi, thanks!');

    assert.match(answer, /NO_TOOLS_REPLY/, 'no_tools reaches the existing main answer, not a refusal');
    assert.equal(counts.tools, 0, 'no tool may execute, even when the model emits tool calls');
    assert.equal(counts.http, 1, 'exactly one Jev routing request');
    assert.ok(model.doGenerateCalls.length >= 1, 'the main model answered');
    for (const call of model.doGenerateCalls) {
      assert.ok(!JSON.stringify(call.prompt).includes('You route sports queries'), 'no generative routing call');
      // Prior-tool definitions may be sent for provider compatibility, but then only with toolChoice none.
      if (call.tools && call.tools.length > 0) assert.deepEqual(call.toolChoice, {type:'none'});
    }
    const sent = JSON.parse(bodies[0]);
    assert.equal(sent.state.recentContext, '(none)', 'recent context stays off');
    assert.ok(!bodies[0].includes('PRIOR_USER_MARKER'));
    assert.equal(engine.lastRunTrace.parallelAgents, false, 'no parallel lanes');
    assert.deepEqual(engine.lastRunTrace.routedSkills, [], 'no skills and no helper union');
    assert.ok(engine.messages.some(m=>m.role==='assistant' && Array.isArray(m.content)
      && m.content.some(p=>p.type==='tool-call' && p.toolCallId==='prior-1')), 'tool history retained');
    assert.equal(engine.messages.at(-1).role, 'assistant');
    console.log(JSON.stringify({tools:counts.tools, http:counts.http}));
  `);
  assert.deepEqual(result, {tools:0, http:1});
});

test('actual run keeps the local-only refusal before credentials and the deterministic fast path off Jev', () => {
  const result = runIsolated('jev-run-local-fast-', `
    const local = harness({routing:{disposition:'no_tools', dataPolicy:'local_only'}, reply:'UNUSED'});
    const refused = await local.engine.run('Hi, thanks!');
    assert.match(refused, /could not route/);
    assert.equal(local.counts.http, 0);
    assert.equal(local.counts.credentialReads, 0, 'no credential read under local_only');
    assert.equal(local.model.doGenerateCalls.length, 0);
    assert.equal(local.counts.tools, 0);

    const fast = harness({routing:{disposition:'no_tools'}, reply:'FAST_PATH_REPLY'});
    const answer = await fast.engine.run('NBA and NFL scores');
    assert.match(answer, /FAST_PATH_REPLY/);
    assert.equal(fast.counts.http, 0, 'a complete deterministic route makes no Jev call');
    assert.equal(fast.counts.credentialReads, 0);
    assert.deepEqual(fast.engine.lastRunTrace.routedSkills, ['nba','nfl']);
    console.log(JSON.stringify({localHttp:local.counts.http, fastHttp:fast.counts.http}));
  `);
  assert.deepEqual(result, {localHttp:0, fastHttp:0});
});

// ---------------------------------------------------------------------------
// Advisory input shortlist (explicit user decision): Jev suggests inputs; code
// still owns what may execute.
// ---------------------------------------------------------------------------

test('actual run answers with external executors disabled when the advisory shortlist is empty', () => {
  const result = runIsolated('jev-run-advisory-empty-', `
    // Tool history from a prior turn: its definitions must not restore an executor.
    const history = () => [
      {role:'user', content:'how did the Lakers do'},
      {role:'assistant', content:[{type:'tool-call',toolCallId:'prior-1',toolName:'nba_get_scores',input:{}}]},
      {role:'tool', content:[{type:'tool-result',toolCallId:'prior-1',toolName:'nba_get_scores',output:{type:'json',value:{home:101,away:99}}}]},
      {role:'assistant', content:[{type:'text',text:'Lakers won 101-99.'}]},
    ];
    let cases = 0;
    for (const disposition of ['clarify', 'unsupported']) for (const yoloMode of [false, true]) {
      const {engine, model, counts} = harness({routing:{disposition}, messages:history(), reply:'LOCAL_ANSWER_REPLY', attemptTools:true});
      engine.config.yoloMode = yoloMode;
      const answer = await engine.run('Rewrite my draft: Lakers by 5 tonight');
      const label = disposition + (yoloMode ? ' yolo' : '');
      assert.match(answer, /LOCAL_ANSWER_REPLY/, label + ': the existing main answer, not a refusal');
      assert.equal(counts.tools, 0, label + ': no executor runs, attempted or historical');
      assert.equal(counts.http, 1, label + ': one Jev request');
      assert.ok(model.doGenerateCalls.length >= 1, label + ': the main model answered');
      for (const call of model.doGenerateCalls) {
        assert.ok(!JSON.stringify(call.prompt).includes('You route sports queries'), label + ': no second classifier');
        if (call.tools && call.tools.length > 0) assert.deepEqual(call.toolChoice, {type:'none'}, label);
      }
      assert.deepEqual(engine.lastRunTrace.routedSkills, [], label);
      cases++;
    }
    console.log(JSON.stringify({cases}));
  `);
  assert.deepEqual(result, {cases:4});
});

test('actual run hands a low-confidence advisory shortlist to the main answer without widening it', () => {
  const result = runIsolated('jev-run-advisory-shortlist-', `
    // A low-confidence follow-up is exactly where the legacy path drops the skill filter.
    const messages = [{role:'user', content:'NBA last night'}, {role:'assistant', content:[{type:'text', text:'Lakers won.'}]}];
    const {engine, model, counts} = harness({routing:{disposition:'select', required:['c0'], confidence:.3},
      messages, reply:'SHORTLIST_REPLY'});
    const answer = await engine.run('and how did the other game go');
    assert.match(answer, /SHORTLIST_REPLY/, 'the main answer, not a clarification refusal');
    assert.equal(counts.http, 1, 'one Jev request');
    assert.ok(model.doGenerateCalls.length >= 1, 'the main model answered');
    for (const call of model.doGenerateCalls) {
      assert.ok(!JSON.stringify(call.prompt).includes('You route sports queries'), 'no second classifier');
      const offered = (call.tools ?? []).map(t => t.name);
      assert.ok(offered.includes('nba_get_scores'), 'the suggested input is offered');
      assert.ok(!offered.includes('nfl_get_scores'), 'no widening to an unsuggested skill');
    }
    assert.deepEqual(engine.lastRunTrace.routedSkills, ['nba']);
    console.log(JSON.stringify({http:counts.http}));
  `);
  assert.deepEqual(result, {http:1});
});

test('a nonempty advisory shortlist cannot execute unrelated external or business tools', () => {
  const result = runIsolated('jev-run-advisory-isolation-', `
    const {engine, counts} = harness({routing:{disposition:'select', required:['c0'], confidence:.3}, reply:'SHORTLIST_REPLY', attemptTools:true});
    await engine.run('how did the Lakers do');
    assert.ok(counts.executed.includes('nba_get_scores'), 'the selected data tool still runs');
    for (const name of ['spawn_subagent','mcp__unrelated','update_fan_profile']) {
      assert.ok(!counts.executed.includes(name), name + ' must not execute outside the shortlist');
    }
    console.log(JSON.stringify({executed:[...new Set(counts.executed)]}));
  `);
  assert.deepEqual(result, {executed:['nba_get_scores']});
});

test('explicit agents cannot restore executors excluded by advisory routing', () => {
  const result = runIsolated('jev-run-explicit-advisory-isolation-', `
    const {createAgent} = await import(${JSON.stringify(new URL('../dist/agents.js', import.meta.url).href)});
    const agent = await createAgent({id:'nba-boundary-check',name:'Boundary check',body:'Use only permitted data tools.',skills:['nba']});
    const {engine, counts} = harness({routing:{disposition:'select', required:['c0'], confidence:.3}, reply:'SHORTLIST_REPLY', attemptTools:true});
    await engine.run('how did the Lakers do', {agentIds:[agent.id]});
    assert.ok(counts.executed.includes('nba_get_scores'), 'the selected data tool still runs');
    for (const name of ['spawn_subagent','mcp__unrelated','update_fan_profile']) {
      assert.ok(!counts.executed.includes(name), name + ' must remain excluded for an explicit agent');
    }
    console.log(JSON.stringify({executed:[...new Set(counts.executed)]}));
  `);
  assert.deepEqual(result, {executed:['nba_get_scores']});
});

test('actual run never lets an advisory hint grant a tool outside the caller allowlist', () => {
  const result = runIsolated('jev-run-advisory-allowlist-', `
    const {engine, model, counts} = harness({routing:{disposition:'select', required:['c0'], confidence:.3}, reply:'ALLOWLIST_REPLY'});
    engine.config.toolAllowlist = ['nfl_get_scores'];
    const answer = await engine.run('how did the Lakers do');
    assert.match(answer, /ALLOWLIST_REPLY/);
    assert.equal(counts.tools, 0);
    assert.ok(model.doGenerateCalls.length >= 1, 'the main model answered');
    for (const call of model.doGenerateCalls) {
      const offered = (call.tools ?? []).map(t => t.name);
      for (const name of ['nba_get_scores', 'spawn_subagent', 'update_fan_profile']) {
        assert.ok(!offered.includes(name), name + ' is outside the caller allowlist');
      }
    }
    console.log(JSON.stringify({tools:counts.tools}));
  `);
  assert.deepEqual(result, {tools:0});
});

// ---------------------------------------------------------------------------
// Operator-approved public data pool (explicit user decision): approved public
// schedule/scoreboard reads stay available when the advice is empty; nothing
// else is restored, and every existing limit applies to the union.
// ---------------------------------------------------------------------------

const EVERY_ATTEMPT = "['nba_get_scores','nfl_get_scores','spawn_subagent','mcp__unrelated','update_fan_profile']";

test('an approved public pool lets an empty-advice turn read NBA data, and nothing else', () => {
  const result = runIsolated('jev-run-pool-empty-', `
    // "Who’s playing today" -> "NBA": the prior turn used an unapproved NFL read.
    const history = () => [
      {role:'user', content:'PRIOR_USER_MARKER Who’s playing today'},
      {role:'assistant', content:[{type:'tool-call',toolCallId:'prior-1',toolName:'nfl_get_scores',input:{}}]},
      {role:'tool', content:[{type:'tool-result',toolCallId:'prior-1',toolName:'nfl_get_scores',output:{type:'json',value:{events:[]}}}]},
      {role:'assistant', content:[{type:'text',text:'Which league?'}]},
    ];
    let cases = 0;
    for (const disposition of ['no_tools', 'clarify', 'unsupported']) {
      const {engine, model, counts, bodies} = harness({routing:{disposition, publicDataTools:['nba_get_scores']},
        messages:history(), reply:'POOL_REPLY', attemptTools:${EVERY_ATTEMPT}, verdict:VERDICT_OK});
      const answer = await engine.run('NBA');
      assert.match(answer, /POOL_REPLY/, disposition);
      assert.ok(counts.executed.includes('nba_get_scores'), disposition + ': the approved public read runs');
      for (const name of ['nfl_get_scores','spawn_subagent','mcp__unrelated','update_fan_profile']) {
        assert.ok(!counts.executed.includes(name), disposition + ': ' + name + ' must not execute');
      }
      const main = model.doGenerateCalls.filter((call) => call.tools?.length);
      assert.ok(main.length >= 1, disposition + ': the main model answered with tools offered');
      for (const call of main) {
        assert.ok(call.tools.some((t) => t.name === 'nba_get_scores'), disposition + ': the pool tool is offered');
        assert.notDeepEqual(call.toolChoice, {type:'none'}, disposition + ': empty advice no longer forces none');
      }
      assert.equal(counts.http, 1, disposition + ': one Jev request');
      assert.equal(JSON.parse(bodies[0]).state.recentContext, '(none)', disposition + ': raw history stays off Jev');
      assert.ok(!bodies[0].includes('PRIOR_USER_MARKER'), disposition);
      assert.ok(engine.messages.some((m) => m.role==='assistant' && Array.isArray(m.content)
        && m.content.some((p) => p.type==='tool-call' && p.toolCallId==='prior-1')), disposition + ': main history retained');
      cases++;
    }
    console.log(JSON.stringify({cases}));
  `);
  assert.deepEqual(result, {cases:3});
});

test('the public pool stays inside explicit-agent, caller-allowlist and validity limits', () => {
  const result = runIsolated('jev-run-pool-limits-', `
    const {createAgent} = await import(${JSON.stringify(new URL('../dist/agents.js', import.meta.url).href)});
    const agent = await createAgent({id:'nba-pool-check',name:'Pool check',body:'Use only permitted data tools.',skills:['nba']});

    // An NBA-only explicit agent cannot restore an approved NFL pool.
    const scoped = harness({routing:{disposition:'clarify', publicDataTools:['nfl_get_scores']}, reply:'AGENT_REPLY',
      attemptTools:${EVERY_ATTEMPT}, verdict:VERDICT_OK});
    await scoped.engine.run('Who’s playing today', {agentIds:[agent.id]});
    assert.deepEqual(scoped.counts.executed, [], 'the agent filter applies to the union');

    // A caller allowlist can exclude the whole pool.
    const listed = harness({routing:{disposition:'clarify', publicDataTools:['nba_get_scores']}, reply:'ALLOW_REPLY',
      attemptTools:${EVERY_ATTEMPT}, verdict:VERDICT_OK});
    listed.engine.config.toolAllowlist = ['nfl_get_scores'];
    await listed.engine.run('Who’s playing today');
    assert.deepEqual(listed.counts.executed, [], 'the allowlist applies to the union');
    for (const call of listed.model.doGenerateCalls) {
      assert.ok(!(call.tools ?? []).some((t) => t.name === 'nba_get_scores'), 'nba_get_scores is outside the allowlist');
    }

    // Only installed skill-owned SDK tools are valid pool entries; anything else refuses.
    let refused = 0;
    // query_tool_result is a reader of approved results, never a pool entry of its own.
    for (const pool of [['mcp__unrelated'], ['spawn_subagent'], ['update_fan_profile'], ['nba_get_standings'], ['*'], 'nba_get_scores', [''],
      ['query_tool_result'], ['nba_get_scores', 'query_tool_result']]) {
      const label = JSON.stringify(pool);
      const bad = harness({routing:{disposition:'clarify', publicDataTools:pool}, reply:'UNUSED', attemptTools:${EVERY_ATTEMPT}});
      const answer = await bad.engine.run('Who’s playing today');
      assert.match(answer, /could not route/, label);
      assert.equal(bad.model.doGenerateCalls.length, 0, label + ': no generation');
      assert.equal(bad.counts.tools, 0, label + ': no tool');
      refused++;
    }

    // Existing refusals still win over a configured pool.
    const local = harness({routing:{disposition:'clarify', dataPolicy:'local_only', publicDataTools:['nba_get_scores']}, reply:'UNUSED', attemptTools:${EVERY_ATTEMPT}});
    assert.match(await local.engine.run('Who’s playing today'), /could not route/);
    assert.equal(local.counts.http, 0);
    assert.equal(local.counts.credentialReads, 0, 'no credential read under local_only');
    const denied = harness({routing:{disposition:'clarify', publicDataTools:['nba_get_scores']}, reply:'UNUSED', attemptTools:${EVERY_ATTEMPT}});
    denied.engine.config.routing.transport = async () => { denied.counts.http++; return new Response('{}', {status:403}); };
    assert.match(await denied.engine.run('Who’s playing today'), /could not route/);
    assert.equal(denied.counts.http, 1);
    const aborted = harness({routing:{disposition:'clarify', publicDataTools:['nba_get_scores']}, reply:'UNUSED', attemptTools:${EVERY_ATTEMPT}});
    assert.equal(await aborted.engine.run('Who’s playing today', {abortSignal:AbortSignal.abort()}), 'Request cancelled.');
    assert.equal(aborted.counts.http, 0);
    for (const h of [local, denied, aborted]) {
      assert.equal(h.model.doGenerateCalls.length, 0, 'no generation after a refusal');
      assert.equal(h.counts.tools, 0, 'no tool after a refusal');
    }
    console.log(JSON.stringify({refused}));
  `);
  assert.deepEqual(result, {refused:9});
});

test('a deterministic selection cannot restore unrelated executors in public-data mode', () => {
  const result = runIsolated('jev-pool-deterministic-isolation-', `
    const {engine,counts}=harness({routing:{disposition:'no_tools',publicDataTools:['nba_get_scores']},reply:'SAFE_REPLY',attemptTools:['nba_get_scores','nfl_get_scores','mcp__unrelated','spawn_subagent','update_fan_profile'],verdict:VERDICT_OK});
    await engine.run('NBA and NFL scores');
    assert.equal(counts.http,0,'the deterministic path was exercised');
    assert.ok(counts.executed.includes('nba_get_scores'));
    for(const name of ['mcp__unrelated','spawn_subagent','update_fan_profile'])assert.ok(!counts.executed.includes(name),name+' remains outside bounded public data authority');
    console.log(JSON.stringify({unrelatedBlocked:true}));
  `);
  assert.deepEqual(result,{unrelatedBlocked:true});
});

test('parallel agents cannot execute another sport restored only by history', () => {
  const result = runIsolated('jev-pool-parallel-isolation-', `
    const {createAgent} = await import(${JSON.stringify(new URL('../dist/agents.js', import.meta.url).href)});
    await createAgent({id:'nba-one',name:'NBA one',body:'NBA only',skills:['nba']});
    await createAgent({id:'nba-two',name:'NBA two',body:'NBA only',skills:['nba']});
    const messages=[
      {role:'user',content:'Earlier NFL scores'},
      {role:'assistant',content:[{type:'tool-call',toolCallId:'old-nfl',toolName:'nfl_get_scores',input:{}}]},
      {role:'tool',content:[{type:'tool-result',toolCallId:'old-nfl',toolName:'nfl_get_scores',output:{type:'json',value:{score:7}}}]},
      {role:'assistant',content:[{type:'text',text:'Earlier result.'}]},
    ];
    const {engine,counts}=harness({routing:{disposition:'select',required:['c0'],publicDataTools:['nfl_get_scores']},messages,reply:'NBA_REPLY',attemptTools:['nba_get_scores','nfl_get_scores'],parallelAgents:true,verdict:VERDICT_OK});
    await engine.run('And the NBA games?');
    assert.equal(engine.lastRunTrace.parallelAgents,true,'the test actually used parallel lanes');
    assert.ok(counts.executed.includes('nba_get_scores'));
    assert.ok(!counts.executed.includes('nfl_get_scores'),'NBA-only lanes must not execute NFL from global pool/history');
    console.log(JSON.stringify({executed:[...new Set(counts.executed)]}));
  `);
  assert.deepEqual(result,{executed:['nba_get_scores']});
});

test('a configured public pool fails closed when no SDK schemas are installed', () => {
  const result = runIsolated('jev-pool-no-schemas-', `
    for(const dataPolicy of ['cloud_allowed','local_only']){
      const {engine,counts,model}=harness({routing:{disposition:'no_tools',dataPolicy,publicDataTools:['nba_get_scores']},reply:'UNSAFE',attemptTools:['mcp__unrelated']});
      engine.registry={getInstalledSkills:()=>[],getAllToolSpecs:()=>[{name:'mcp__unrelated',description:'private',parameters:{}}],getSkillName:()=>undefined};
      const answer=await engine.run('Who plays today?');
      assert.match(answer,/could not route/);
      assert.equal(model.doGenerateCalls.length,0);
      assert.equal(counts.tools,0);
      assert.equal(counts.http,0);
      assert.equal(counts.credentialReads,0);
    }
    console.log(JSON.stringify({refused:true}));
  `);
  assert.deepEqual(result,{refused:true});
});

test('a successful advisory selection keeps the approved pool but no unrelated executor', () => {
  const result = runIsolated('jev-run-pool-selected-', `
    const {engine, counts} = harness({routing:{disposition:'select', required:['c0'], confidence:.3, publicDataTools:['nfl_get_scores']},
      reply:'UNION_REPLY', attemptTools:${EVERY_ATTEMPT}, verdict:VERDICT_OK});
    await engine.run('Who’s playing today');
    for (const name of ['spawn_subagent','mcp__unrelated','update_fan_profile']) {
      assert.ok(!counts.executed.includes(name), name + ' must not execute');
    }
    console.log(JSON.stringify({executed:[...new Set(counts.executed)].sort()}));
  `);
  assert.deepEqual(result, {executed:['nba_get_scores', 'nfl_get_scores']});
});

// ---------------------------------------------------------------------------
// Reading an oversized approved result in public-data mode: the real
// buildTools() and per-turn ToolResultStore, model -> big result ->
// query_tool_result -> answer. Registry dispatch, Jev transports and the model
// are synthetic fixtures; nothing reaches the network.
// ---------------------------------------------------------------------------

const REAL = `
  const NOTES = 'n'.repeat(120);
  /** Over 30k chars of rows; the marked row sits deep inside, never in the overview preview. */
  const bigSchedule = (sport, marker) => JSON.stringify({status:true, data:{date:'2026-10-28', events:
    Array.from({length:400}, (_, i) => i === 250
      ? {id:marker, home:'Lakers', away:'Celtics', start:'19:30', notes:NOTES}
      : {id:sport + '-' + i, home:'Team ' + i, away:'Team ' + (i + 1), start:'12:00', notes:NOTES})}});
  const jevAnswer = (choose) => async (_url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const chosen = choose(id);
      const labels = Object.keys(question.criteria);
      answers[id] = {type:'choice', choice:chosen, confidence:.97,
        probabilities:Object.fromEntries(labels.map((label) => [label, label === chosen ? 1 : 0]))};
    }
    return new Response(JSON.stringify({model:body.model, answers}), {status:200, headers:{'content-type':'application/json'}});
  };
  /** Tool results the model was shown, in order. */
  const shown = (options) => options.prompt.filter((m) => m.role === 'tool').flatMap((m) => m.content)
    .filter((p) => p.type === 'tool-result').map((p) => ({toolName:p.toolName, text:JSON.stringify(p.output)}));
  const idOf = (text) => text.match(/result_id[^r]{0,8}(r\\d+)/)?.[1];
  const call = (toolName, input) => ({type:'tool-call', toolCallId:toolName + '-' + Math.random().toString(36).slice(2), toolName, input:JSON.stringify(input)});
  const reply = (content) => ({content, finishReason:{unified:content.some((p) => p.type === 'tool-call') ? 'tool-calls' : 'stop', raw:undefined}, usage, warnings:[]});

  function realHarness({pool, disposition = 'clarify', required = [], allowlist, publicToolNames, parallelAgents = false, payloads, script}) {
    const counts = {routingHttp:0, dispatched:[], evidenceStates:[], mainPrompts:[]};
    const skills = ['nba','nfl'];
    const specs = skills.map((s) => ({name:s + '_get_scores', description:'scores', parameters:{}, input_schema:{type:'object', properties:{}}}));
    const routingTransport = jevAnswer((id) => id === 'disposition' ? disposition : required.includes(id) ? 'required' : 'not_required');
    const engine = Object.create(sportsclawEngine.prototype);
    engine.config = {...DEFAULT_CONFIG, maxTurns:8, parallelAgents,
      routing:{provider:'jev', dataPolicy:'cloud_allowed', env:{TYPESAFE_API_KEY:'synthetic-key'}, publicDataTools:pool,
        transport:async (url, init) => { counts.routingHttp++; return routingTransport(url, init); }},
      ...(publicToolNames ? {evidenceVerifier:{provider:'jev', dataPolicy:'cloud_allowed', publicToolNames, env:{TYPESAFE_API_KEY:'synthetic-key'},
        transport:async (url, init) => { counts.evidenceStates.push(JSON.parse(init.body).state); return jevAnswer(() => 'supported')(url, init); }}} : {}),
      ...(allowlist ? {toolAllowlist:allowlist} : {})};
    engine.messages = [];
    engine.mainModelId = 'synthetic-main-model';
    engine.mainModel = new MockLanguageModelV3({doGenerate: async (options) => {
      const text = JSON.stringify(options.prompt);
      // Tool-less calls are the checker (answered clean) or lane synthesis.
      if (!options.tools?.length) return reply([{type:'text', text:/isValid/.test(text) ? VERDICT_OK() : 'SYNTHESIZED'}]);
      counts.mainPrompts.push({offered:options.tools.map((t) => t.name), text});
      return reply(await script(shown(options), options, text));
    }});
    engine.registry = {getInstalledSkills:() => skills, getAllToolSpecs:() => specs,
      getSkillName:(name) => skills.includes(name.split('_')[0]) ? name.split('_')[0] : undefined,
      dispatchToolCall:async (name) => { counts.dispatched.push(name); return {isError:false, content:payloads[name]}; }};
    engine.mcpManager = {serverCount:0, setUserId(){}, getToolSpecs:() => [], getMachinaLoopServer:() => undefined};
    engine.initAsync = async () => {};
    engine.buildSystemPrompt = (args) => 'SYNTHETIC_MAIN_SYSTEM LANE:' + (args.agents ?? []).map((a) => a.id).join(',');
    return {engine, counts};
  }
  /** fetch -> query -> answer: the model reads the stored result through query_tool_result. */
  const fetchQueryAnswer = (toolName, query, answer) => async (results) => {
    if (results.length === 0) return [call(toolName, {})];
    if (results.length === 1) return [call('query_tool_result', {result_id:idOf(results[0].text), ...query})];
    return [{type:'text', text:answer}];
  };
`;

const LAKERS = "where:[{field:'home', op:'eq', value:'Lakers'}]";

test('public-data mode lets the main model and the checker read the selected rows of an approved oversized result', () => {
  const result = runIsolated('jev-query-public-', `
    ${REAL}
    const payloads = {nba_get_scores:bigSchedule('nba', 'NBA_ROW_MARKER'), nfl_get_scores:'{}'};
    assert.ok(payloads.nba_get_scores.length > 30000, 'the fixture is over the output cap');
    const draft = 'FINAL: Lakers host the Celtics at 19:30.';
    let cases = 0;
    // Unrestricted caller, and the probe's 3-tool caller allowlist that names the reader.
    for (const allowlist of [undefined, ['nba_get_scores', 'nfl_get_scores', 'query_tool_result']]) {
      const label = allowlist ? '3-tool allowlist' : 'unrestricted caller';
      const {engine, counts} = realHarness({pool:['nba_get_scores'], allowlist, publicToolNames:['nba_get_scores'], payloads,
        script:fetchQueryAnswer('nba_get_scores', {${LAKERS}, fields:['id','home','away','start']}, draft)});
      const answer = await engine.run('Who’s playing today?');
      assert.equal(counts.routingHttp, 1, label + ': one Jev routing request');
      assert.deepEqual(counts.dispatched, ['nba_get_scores'], label + ': the query reads the stored result; no new data request');
      assert.ok(counts.mainPrompts.length >= 3, label + ': fetch, query and answer steps all ran');
      assert.ok(counts.mainPrompts.every((p) => p.offered.includes('query_tool_result')), label + ': the reader is offered beside the approved read');
      assert.ok(counts.mainPrompts.at(-1).text.includes('NBA_ROW_MARKER'), label + ': the main model saw the selected row');
      assert.equal(counts.evidenceStates.length, 1, label + ': queried public evidence reaches the Jev checker');
      const state = counts.evidenceStates[0];
      assert.ok(state.includes('NBA_ROW_MARKER'), label + ': the checker sees the selected row, not another blind preview');
      assert.ok(state.includes('only an overview is shown'), label + ': the original overview evidence is retained');
      assert.match(state, /matched_rows\\W+1/, label + ': with the actual matched count');
      assert.equal(engine.evidenceReceipts[0]?.status, 'supported', label);
      assert.equal(answer, draft, label);
      cases++;
    }
    console.log(JSON.stringify({cases}));
  `);
  assert.deepEqual(result, {cases:2});
});

test('a caller allowlist that omits the reader, or leaves no data tool, never offers or runs it', () => {
  const result = runIsolated('jev-query-denied-', `
    ${REAL}
    const payloads = {nba_get_scores:bigSchedule('nba', 'NBA_ROW_MARKER'), nfl_get_scores:'{}'};
    let cases = 0;
    for (const allowlist of [['nba_get_scores', 'nfl_get_scores'], ['query_tool_result']]) {
      const label = JSON.stringify(allowlist);
      const {engine, counts} = realHarness({pool:['nba_get_scores'], allowlist, payloads,
        script:fetchQueryAnswer('nba_get_scores', {${LAKERS}}, 'FINAL: Lakers host the Celtics at 19:30.')});
      await engine.run('Who’s playing today?');
      for (const prompt of counts.mainPrompts) {
        assert.ok(!prompt.offered.includes('query_tool_result'), label + ': the reader is not offered');
        assert.ok(!prompt.text.includes('NBA_ROW_MARKER'), label + ': no stored row was read');
      }
      assert.deepEqual(counts.dispatched, allowlist.includes('nba_get_scores') ? ['nba_get_scores'] : [], label);
      cases++;
    }
    console.log(JSON.stringify({cases}));
  `);
  assert.deepEqual(result, {cases:2});
});

test('the reader refuses a query with no source this turn, an unknown id and a previous turn id', () => {
  const result = runIsolated('jev-query-unknown-', `
    ${REAL}
    const payloads = {nba_get_scores:bigSchedule('nba', 'NBA_ROW_MARKER'), nfl_get_scores:'{}'};
    let firstTurnId;
    let turn = 1;
    let stale;
    const script = async (results, options) => {
      if (turn === 2) {
        if (options.prompt.at(-1).role === 'user') return [call('query_tool_result', {result_id:firstTurnId})];
        stale = JSON.stringify(options.prompt.at(-1));
        return [{type:'text', text:'FINAL: no stored result this turn.'}];
      }
      if (results.length === 0) return [call('query_tool_result', {result_id:'r1'})];
      if (results.length === 1) return [call('nba_get_scores', {})];
      if (results.length === 2) {
        firstTurnId = idOf(results[1].text);
        return [call('query_tool_result', {result_id:firstTurnId, ${LAKERS}}), call('query_tool_result', {result_id:'r99'})];
      }
      return [{type:'text', text:'FINAL: Lakers host the Celtics at 19:30.'}];
    };
    const {engine, counts} = realHarness({pool:['nba_get_scores'], payloads, script});
    await engine.run('Who’s playing today?');
    const results = shown({prompt:JSON.parse(counts.mainPrompts.at(-1).text)});
    assert.equal(results.length, 4, 'every attempted read produced a result');
    const [noSource, , own, unknown] = results;
    for (const [label, refused] of [['no source', noSource], ['unknown id', unknown]]) {
      assert.doesNotMatch(refused.text, /matched_rows|NBA_ROW_MARKER/, label + ' must be refused');
    }
    assert.ok(own.text.includes('NBA_ROW_MARKER'), 'the current turn result is readable');

    turn = 2;
    await engine.run('And the late game?');
    assert.ok(stale, 'the second turn attempted the stale read');
    assert.doesNotMatch(stale, /matched_rows|NBA_ROW_MARKER/, 'a previous turn id is refused');
    console.log(JSON.stringify({refused:3}));
  `);
  assert.deepEqual(result, {refused:3});
});

test('an NBA-only parallel lane reads its own result but never NFL rows another lane cached', () => {
  const result = runIsolated('jev-query-parallel-', `
    ${REAL}
    const {createAgent} = await import(${JSON.stringify(new URL('../dist/agents.js', import.meta.url).href)});
    await createAgent({id:'nba-lane', name:'NBA lane', body:'NBA only', skills:['nba']});
    await createAgent({id:'nfl-lane', name:'NFL lane', body:'NFL only', skills:['nfl']});
    const payloads = {nba_get_scores:bigSchedule('nba', 'NBA_ROW_MARKER'), nfl_get_scores:bigSchedule('nfl', 'NFL_ROW_MARKER')};
    let releaseNfl;
    const nflId = new Promise((resolve) => { releaseNfl = resolve; });
    const nbaLanePrompts = [];
    let nbaQueries = [];
    const script = async (results, _options, text) => {
      if (text.includes('LANE:nfl-lane')) {
        if (results.length === 0) return [call('nfl_get_scores', {})];
        releaseNfl(idOf(results[0].text));
        return [{type:'text', text:'NFL lane done.'}];
      }
      nbaLanePrompts.push(text);
      if (results.length === 0) return [call('nba_get_scores', {})];
      if (results.length === 1) {
        // Wait until the NFL lane has stored its result in the shared per-turn store.
        const other = await Promise.race([nflId, new Promise((resolve) => setTimeout(() => resolve('r2'), 3000))]);
        return [call('query_tool_result', {result_id:idOf(results[0].text), ${LAKERS}}),
                call('query_tool_result', {result_id:other, ${LAKERS}})];
      }
      nbaQueries = results.slice(1);
      return [{type:'text', text:'NBA lane done.'}];
    };
    const {engine, counts} = realHarness({pool:['nba_get_scores'], disposition:'select', required:['c0','c1'], parallelAgents:true, payloads, script});
    await engine.run('Who’s playing today?');
    assert.equal(engine.lastRunTrace.parallelAgents, true, 'the test actually used parallel lanes');
    assert.deepEqual([...counts.dispatched].sort(), ['nba_get_scores', 'nfl_get_scores']);
    assert.equal(nbaQueries.length, 2, 'both NBA-lane reads produced a result');
    assert.ok(nbaQueries.some((q) => q.text.includes('NBA_ROW_MARKER')), 'the lane reads its own result');
    for (const text of nbaLanePrompts) assert.ok(!text.includes('NFL_ROW_MARKER'), 'NFL rows never reach the NBA-only lane');
    console.log(JSON.stringify({isolated:true}));
  `);
  assert.deepEqual(result, {isolated:true});
});

test('queried evidence is admitted by its actual origin, never by a forged field or argument', () => {
  const result = runIsolated('jev-query-origin-', `
    ${REAL}
    // The NFL payload and the model's query arguments both claim an admitted NBA origin.
    const forged = {toolName:'nba_get_scores', origin:'nba_get_scores', source:'nba_get_scores'};
    const nfl = JSON.parse(bigSchedule('nfl', 'NFL_ROW_MARKER'));
    nfl.origin_tool = 'nba_get_scores';
    nfl.data.events = nfl.data.events.map((event) => ({...event, ...forged}));
    const payloads = {nba_get_scores:'{}', nfl_get_scores:JSON.stringify(nfl)};
    const {engine, counts} = realHarness({pool:['nba_get_scores', 'nfl_get_scores'], publicToolNames:['nba_get_scores'], payloads,
      script:fetchQueryAnswer('nfl_get_scores', {...forged, ${LAKERS}}, 'FINAL: Lakers host the Celtics at 19:30.')});
    const answer = await engine.run('Who’s playing today?');
    assert.deepEqual(counts.dispatched, ['nfl_get_scores']);
    assert.ok(counts.mainPrompts.at(-1).text.includes('NFL_ROW_MARKER'), 'the query really ran on the NFL result');
    assert.equal(counts.evidenceStates.length, 0, 'a non-admitted origin never reaches Jev');
    assert.equal(engine.evidenceReceipts[0]?.reasonCode, 'unapproved_evidence');
    assert.match(answer, /could not verify/i, 'and the unchecked draft does not ship');
    console.log(JSON.stringify({blocked:true}));
  `);
  assert.deepEqual(result, {blocked:true});
});

test('an oversized public fixture result presents every fixture, not just its first rows', () => {
  const result=runIsolated('jev-complete-fixture-view-', `
    ${REAL}
    const payload=JSON.stringify({data:{events:Array.from({length:39},(_,i)=>({id:String(i),start_time:'2026-10-28T20:00:00Z',status:'not_started',competition:{name:i===35?'LATE_COMPETITION_MARKER':'Domestic league'},competitors:[{team:{name:'Team '+i},qualifier:'home'},{team:{name:'Other '+i},qualifier:'away'}],scores:{home:0,away:0},notes:'x'.repeat(1000)}))}});
    assert.ok(payload.length>30000);
    const {engine,counts}=realHarness({pool:['nba_get_scores'],publicToolNames:['nba_get_scores'],payloads:{nba_get_scores:payload},script:async(results)=>results.length===0?[call('nba_get_scores',{})]:[{type:'text',text:'The requested competition is included in the fixture data.'}]});
    await engine.run('What competitions have games today?');
    assert.ok(counts.mainPrompts.at(-1).text.includes('LATE_COMPETITION_MARKER'),'later fixture rows reach the answer model without a guessed follow-up query');
    assert.equal(counts.evidenceStates.length,1);
    assert.ok(counts.evidenceStates[0].includes('LATE_COMPETITION_MARKER'));
    assert.ok(!counts.mainPrompts.at(-1).text.includes('x'.repeat(1000)),'unneeded metadata remains in the stored original');
    assert.deepEqual(counts.dispatched,['nba_get_scores']);
    console.log(JSON.stringify({completeFixtures:true}));
  `);
  assert.deepEqual(result,{completeFixtures:true});
});

test('fixture projection never labels a row-limited result as complete', () => {
  const result=runIsolated('jev-fixture-view-bounded-', `
    ${REAL}
    const payload=JSON.stringify({data:{events:Array.from({length:201},(_,i)=>({id:String(i),name:'Fixture '+i,start_time:'2026-10-28T20:00:00Z',status:'not_started',notes:'x'.repeat(200)}))}});
    const {engine,counts}=realHarness({pool:['nba_get_scores'],publicToolNames:['nba_get_scores'],payloads:{nba_get_scores:payload},script:async(results)=>results.length===0?[call('nba_get_scores',{})]:[{type:'text',text:'The source needs a narrower query.'}]});
    await engine.run('Check fixtures');
    assert.ok(counts.mainPrompts.at(-1).text.includes('only an overview is shown'));
    assert.ok(!counts.mainPrompts.at(-1).text.includes('field projection only; all'));
    console.log(JSON.stringify({partial:true}));
  `);
  assert.deepEqual(result,{partial:true});
});

test('the checker sees the same filtered projection beyond the narrator page', () => {
  const result=runIsolated('jev-query-evidence-page-', `
    ${REAL}
    const payload={data:{events:Array.from({length:39},(_,i)=>({id:i===35?'LATE_MATCH_MARKER':String(i),name:'Match '+i,notes:'x'.repeat(1000)}))}};
    const {engine,counts}=realHarness({pool:['nba_get_scores'],publicToolNames:['nba_get_scores'],payloads:{nba_get_scores:JSON.stringify(payload)},script:fetchQueryAnswer('nba_get_scores',{path:'data.events',fields:['id','name'],limit:20},'The referenced fixture is listed.')});
    await engine.run('Check the schedule');
    const presented=counts.mainPrompts.flatMap(p=>shown({prompt:JSON.parse(p.text)})).find(r=>r.toolName==='query_tool_result')?.text ?? '';
    assert.ok(presented&&!presented.includes('LATE_MATCH_MARKER'),'narrator query page stays unchanged');
    const wrapper=JSON.parse(presented);
    const page=typeof wrapper.value==='string'?JSON.parse(wrapper.value):wrapper.value;
    assert.equal(page.returned_rows,20);
    assert.equal(counts.evidenceStates.length,1);
    assert.ok(counts.evidenceStates[0].includes('LATE_MATCH_MARKER'),'verification reads authorized rows beyond the presentation page');
    assert.ok(counts.evidenceStates[0].includes('matched_rows')&&counts.evidenceStates[0].includes('39'));
    console.log(JSON.stringify({completeEvidence:true}));
  `);
  assert.deepEqual(result,{completeEvidence:true});
});

test('private content beyond the narrator page is refused before Jev egress', () => {
  const result=runIsolated('jev-query-expanded-private-', `
    ${REAL}
    const payload={data:{events:Array.from({length:39},(_,i)=>({id:i===35?'https://reports.example.test/rpt_ABCDEFGHIJKLMNOPQRSTUV?t=PRIVATE_LATE_TOKEN':String(i),name:'Match '+i,notes:'x'.repeat(1000)}))}};
    const {engine,counts}=realHarness({pool:['nba_get_scores'],publicToolNames:['nba_get_scores'],payloads:{nba_get_scores:JSON.stringify(payload)},script:fetchQueryAnswer('nba_get_scores',{path:'data.events',fields:['id','name'],limit:20},'There are games.')});
    const answer=await engine.run('Check the schedule');
    assert.ok(!counts.mainPrompts.at(-1).text.includes('PRIVATE_LATE_TOKEN'));
    assert.equal(counts.evidenceStates.length,0);
    assert.equal(engine.evidenceReceipts[0]?.reasonCode,'private_content');
    assert.match(answer,/could not verify/);
    console.log(JSON.stringify({privateBlocked:true}));
  `);
  assert.deepEqual(result,{privateBlocked:true});
});

test('queried private rows refuse before any checker request, even with the reader named as public', () => {
  const result=runIsolated('jev-query-private-', `
    ${REAL}
    const marker='https://reports.example.test/rpt_ABCDEFGHIJKLMNOPQRSTUV?t=SYNTHETIC_BEARER';
    const {engine,counts}=realHarness({pool:['nba_get_scores'],publicToolNames:['nba_get_scores','query_tool_result'],payloads:{nba_get_scores:bigSchedule('nba',marker)},script:fetchQueryAnswer('nba_get_scores',{${LAKERS},fields:['id','home']},'There is a game.')});
    const answer=await engine.run('Who plays today?');
    assert.ok(counts.mainPrompts.at(-1).text.includes('SYNTHETIC_BEARER'),'the query actually returned the private-marked row');
    assert.equal(counts.evidenceStates.length,0);
    assert.equal(engine.evidenceReceipts[0]?.reasonCode,'private_content');
    assert.match(answer,/could not verify/);
    console.log(JSON.stringify({blocked:true}));
  `);
  assert.deepEqual(result,{blocked:true});
});

test('the combined overview and queried rows retain the verifier whole-state bound', () => {
  const result=runIsolated('jev-query-size-', `
    ${REAL}
    const {engine,counts}=realHarness({pool:['nba_get_scores','nfl_get_scores'],publicToolNames:['nba_get_scores','nfl_get_scores'],payloads:{nba_get_scores:bigSchedule('nba','NBA_MARKER'),nfl_get_scores:bigSchedule('nfl','NFL_MARKER')},script:async(results)=>{
      if(results.length===0)return [call('nba_get_scores',{})];
      if(results.length===1)return [call('nfl_get_scores',{})];
      if(results.length===2)return [call('query_tool_result',{result_id:idOf(results[0].text),limit:200})];
      if(results.length===3)return [call('query_tool_result',{result_id:idOf(results[1].text),limit:200})];
      return [{type:'text',text:'All games are listed.'}];
    }});
    const answer=await engine.run('Show the complete slate');
    assert.ok(counts.mainPrompts.length>=5,'both query steps were exercised');
    assert.equal(counts.evidenceStates.length,0);
    assert.equal(engine.evidenceReceipts[0]?.reasonCode,'request_too_large');
    assert.match(answer,/could not verify/);
    console.log(JSON.stringify({bounded:true}));
  `);
  assert.deepEqual(result,{bounded:true});
});

test('an explicit NBA agent can query its approved NBA rows without opening NFL', () => {
  const result=runIsolated('jev-query-explicit-', `
    ${REAL}
    const {createAgent}=await import(${JSON.stringify(new URL('../dist/agents.js',import.meta.url).href)});
    const agent=await createAgent({id:'nba-reader',name:'NBA reader',body:'NBA only',skills:['nba']});
    const {engine,counts}=realHarness({pool:['nfl_get_scores'],disposition:'select',required:['c0'],publicToolNames:['nba_get_scores'],payloads:{nba_get_scores:bigSchedule('nba','NBA_ROW_MARKER')},script:fetchQueryAnswer('nba_get_scores',{${LAKERS},fields:['id','home']},'NBA_ROW_MARKER')});
    await engine.run('Check the NBA slate',{agentIds:[agent.id]});
    assert.deepEqual(counts.dispatched,['nba_get_scores']);
    assert.ok(counts.mainPrompts.at(-1).text.includes('NBA_ROW_MARKER'));
    assert.ok(counts.mainPrompts.every(p=>!p.offered.includes('nfl_get_scores')));
    assert.equal(counts.evidenceStates.length,1);
    console.log(JSON.stringify({scoped:true}));
  `);
  assert.deepEqual(result,{scoped:true});
});

test('an empty filtered result reaches the checker with its actual filter and matched count', () => {
  const result = runIsolated('jev-query-empty-', `
    ${REAL}
    const payloads = {nba_get_scores:bigSchedule('nba', 'NBA_ROW_MARKER'), nfl_get_scores:'{}'};
    const {engine, counts} = realHarness({pool:['nba_get_scores'], publicToolNames:['nba_get_scores'], payloads,
      script:fetchQueryAnswer('nba_get_scores', {where:[{field:'home', op:'eq', value:'NO_SUCH_TEAM_MARKER'}]},
        'FINAL: The schedule lists no game for that team today.')});
    await engine.run('Who’s playing today?');
    assert.match(counts.mainPrompts.at(-1).text, /matched_rows\\W+0/, 'the model saw the empty result of the actual query');
    assert.equal(counts.evidenceStates.length, 1);
    const state = counts.evidenceStates[0];
    assert.ok(state.includes('NO_SUCH_TEAM_MARKER'), 'a claimed absence carries the actual filter');
    assert.match(state, /matched_rows\\W+0/, 'and its matched count');
    console.log(JSON.stringify({scoped:true}));
  `);
  assert.deepEqual(result, {scoped:true});
});
