import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPromptInjections, selectPromptInjections, cleanEntry } from '../open-sse/rtk/promptInjection.js';

test('scope order uses requested combo, not resolved member', () => {
  const entry = content => ({mode:'single',content,enabled:true});
  const config = {global:entry('global'),userPrompts:{k:entry('key')},prompts:{combo:entry('combo'),member:entry('wrong')}};
  assert.deepEqual(selectPromptInjections(config,'combo','k').map(x=>x.content),['global','key','combo']);
});
test('validation rejects empty scripts and unsafe roles', () => {
  assert.throws(()=>cleanEntry({mode:'chat',turns:[{role:'system',content:'x'}]}));
  assert.throws(()=>cleanEntry({content:''}));
});
for (const [path,body,field] of [
 ['/v1/chat/completions',{messages:[{role:'system',content:'native'},{role:'user',content:'hi'}]},'messages'],
 ['/v1/messages',{system:'native',messages:[{role:'user',content:'hi'}]},'system'],
 ['/v1/responses',{input:'hi',instructions:'native'},'instructions'],
 ['/v1beta/models/m:generateContent',{systemInstruction:{parts:[{text:'native'}]},contents:[{role:'user',parts:[{text:'hi'}]}]},'systemInstruction'],
]) test(`wire ${path} preserves input and retries`,()=>{
 const original=structuredClone(body);
 const stack=[{mode:'single',content:'injected',position:'prepend'}];
 const out=applyPromptInjections(body,path,stack);
 assert.deepEqual(body,original);
 assert.match(JSON.stringify(out[field]),/injected/);
 assert.deepEqual(applyPromptInjections(out,path,stack),out);
});
test('Zed tool results always carry boolean is_error', async()=>{
 const {openaiToClaudeRequest}=await import('../open-sse/translator/request/openai-to-claude.js');
 const out=openaiToClaudeRequest('claude-test',{messages:[{role:'tool',tool_call_id:'id',content:'ok'},{role:'user',content:[{type:'tool_result',tool_use_id:'id2',content:'error',is_error:true}]}]},false);
 const results=out.messages.flatMap(m=>m.content).filter(b=>b.type==='tool_result');
 assert.deepEqual(results.map(b=>b.is_error),[false,true]);
});
test('scripts with merged boundary remain retry idempotent',()=>{
 const stack=[{mode:'chat',turns:[{role:'user',content:'script'}]}];
 const out=applyPromptInjections({messages:[{role:'user',content:'real'}]},'/v1/chat/completions',stack);
 assert.deepEqual(applyPromptInjections(out,'/v1/chat/completions',stack),out);
});
