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

    // Real run(); MCP init, tool construction and the system prompt are fixtures.
    // Every tool execution, model call, Jev request and credential read is counted.
    function harness({routing, messages = [], reply, attemptTools, parallelAgents = false}) {
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
      const model = new MockLanguageModelV3({doGenerate: async () => {
        n++;
        const content = [{type:'text', text:reply}];
        // A scripted model that tries tools despite any toolChoice.
        if (attemptTools) {
          content.push({type:'tool-call', toolCallId:'nba-'+n, toolName:'nba_get_scores', input:'{}'});
          content.push({type:'tool-call', toolCallId:'sub-'+n, toolName:'spawn_subagent', input:JSON.stringify({prompt:'dig in'})});
          content.push({type:'tool-call', toolCallId:'mcp-'+n, toolName:'mcp__unrelated', input:'{}'});
          content.push({type:'tool-call', toolCallId:'profile-'+n, toolName:'update_fan_profile', input:'{}'});
        }
        return {content, finishReason:{unified:attemptTools?'tool-calls':'stop', raw:undefined}, usage, warnings:[]};
      }});
      const skills = ['nba','nfl'];
      const specs = skills.map(skill=>({name:skill+'_get_scores',description:'scores',parameters:{}}));
      const toolNames = [...specs.map(spec=>spec.name), 'spawn_subagent', 'update_fan_profile', 'mcp__unrelated'];
      const engine = Object.create(sportsclawEngine.prototype);
      engine.config = {...DEFAULT_CONFIG, maxTurns:3, parallelAgents,
        routing:{provider:'jev', dataPolicy:routing.dataPolicy ?? 'cloud_allowed', env, transport}};
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
