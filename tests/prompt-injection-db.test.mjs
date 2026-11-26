import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const dir = mkdtempSync(join(process.env.TMPDIR,'injection-db-'));
process.env.DATA_DIR=dir;
process.env.JWT_SECRET='test-only-dashboard-secret';
const repo = await import('../src/lib/db/repos/promptInjectRepo.js');
const { GET,PUT,DELETE } = await import('../src/app/api/prompt-injection/route.js');
const { POST } = await import('../src/app/api/prompt-injection/resolve/route.js');
const { createDashboardAuthToken } = await import('../src/lib/auth/dashboardSession.js');
const { resolvePromptInjection } = await import('../src/lib/promptInjection.js');
const token=await createDashboardAuthToken();
const request=(method,payload,query='')=>new Request('http://local/api/prompt-injection'+query,{method,headers:{cookie:`auth_token=${token}`,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
test('authenticated CRUD, resolve, persistence, backup and restore',async()=>{
 assert.equal((await GET(new Request('http://local/api/prompt-injection'))).status,401);
 assert.equal((await PUT(request('PUT',{global:{content:'global'}}))).status,200);
 assert.equal((await PUT(request('PUT',{model:'combo',content:'model'}))).status,200);
 assert.equal((await PUT(request('PUT',{keyId:'k',content:'key'}))).status,200);
 assert.equal((await PUT(request('PUT',{global:{content:''}}))).status,400);
 const out=await resolvePromptInjection({model:'combo',messages:[{role:'user',content:'hello'}]},'/v1/chat/completions');
 assert.equal(out.messages[0].content,'global\n\nmodel');
 const {exportDb,importDb}=await import('../src/lib/db/index.js');
 const backup=await exportDb();
 assert.equal(backup.promptInjections.config.global.content,'global');
 await DELETE(request('DELETE',null,'?model=combo'));
 assert.equal((await repo.getPromptInjections()).prompts.combo,undefined);
 await importDb(backup);
 assert.equal((await repo.getPromptInjections()).prompts.combo.content,'model');
 assert.equal((await POST(new Request('http://local/api/prompt-injection/resolve',{method:'POST',body:'{}'}))).status,404);
 process.env.PROMPT_INJECTION_INTERNAL_TOKEN='private-test-token';
 const response=await POST(new Request('http://local/api/prompt-injection/resolve',{method:'POST',headers:{'x-9r-injection-internal-token':'private-test-token'},body:JSON.stringify({path:'/v1/chat/completions',body:{messages:[{role:'user',content:'hello'}]}})}));
 assert.equal(response.status,200);
 assert.equal((await response.json()).body.messages[0].content,'global');
 const {createServer}=await import('node:http');
 const blue=createServer((req,res)=>{
   res.setHeader('content-type','application/json');
   if(req.url==='/api/keys') { assert.match(req.headers.cookie,/auth_token=/); res.end(JSON.stringify({keys:[{id:'k',key:'test-inference-key',isActive:true}]})); }
   else res.end(JSON.stringify({authenticated:req.headers.cookie===`auth_token=${token}`}));
 });
 await new Promise(r=>blue.listen(0,'127.0.0.1',r));
 process.env.PROMPT_INJECTION_UPSTREAM=`http://127.0.0.1:${blue.address().port}`;
 try {
   const frontOut=await resolvePromptInjection({model:'combo',messages:[{role:'user',content:'hello'}]},'/v1/chat/completions',{authorization:'Bearer test-inference-key'});
   assert.equal(frontOut.messages[0].content,'global\n\nkey\n\nmodel');
   assert.equal((await GET(request('GET'))).status,200);
   assert.equal((await GET(new Request('http://local/api/prompt-injection'))).status,401);
 } finally { delete process.env.PROMPT_INJECTION_UPSTREAM; await new Promise(r=>blue.close(r)); }
 rmSync(dir,{recursive:true,force:true});
});
