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

test('actual run refuses non-selected Jev routes even on follow-ups and in yolo mode', () => {
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
    for (const scenario of ['local', 'auth', 'clarify', 'unsupported', 'abort']) {
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
        engine.config = {...DEFAULT_CONFIG, yoloMode, routing:{provider:'jev',dataPolicy:scenario==='local'?'local_only':'cloud_allowed',env:{TYPESAFE_API_KEY:'synthetic-key'},transport}};
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
        assert.equal(httpCalls,['local','abort'].includes(scenario)?0:1);
        if (scenario==='abort') assert.equal(answer,'Request cancelled.');
        else if (scenario==='clarify') assert.match(answer,/narrow the request/);
        else if (scenario==='unsupported') assert.match(answer,/do not support/);
        else assert.match(answer,/could not route/);
        assert.equal(engine.messages.at(-1).role,'assistant');
        count++;
      }
    }
    console.log(JSON.stringify({cases:count,modelCalls:0,toolCalls:0}));
  `;
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {env, encoding:'utf8', timeout:30000});
    assert.deepEqual(JSON.parse(output.trim()), {cases:20, modelCalls:0, toolCalls:0});
  } finally {
    rmSync(home, {recursive:true, force:true});
  }
});
