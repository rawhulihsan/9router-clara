import { getPromptInjections, mutatePromptInjection } from '@/lib/db/repos/promptInjectRepo.js';
import { injectionAuthorized } from '@/lib/promptInjection.js';
import { selectPromptInjections } from '../../../../open-sse/rtk/promptInjection.js';
export const dynamic = 'force-dynamic';
const json = (data,status=200)=>Response.json(data,{status});
async function authorized(request) {
  try { return await injectionAuthorized(request); } catch { return false; }
}
export async function GET(request) {
  if (!await authorized(request)) return json({error:'Unauthorized'},401);
  const config = await getPromptInjections();
  const p = new URL(request.url).searchParams;
  return json(p.has('preview') ? {stack:selectPromptInjections(config,p.get('model'),p.get('keyId'))} : config);
}
export async function PUT(request) {
  if (!await authorized(request)) return json({error:'Unauthorized'},401);
  try {
    const body = await request.json();
    const entry = await mutatePromptInjection(body);
    return json('global' in body ? {global:entry} : {keyId:body.keyId,model:body.model,entry});
  } catch (error) { return json({error:error.message},400); }
}
export async function DELETE(request) {
  if (!await authorized(request)) return json({error:'Unauthorized'},401);
  try {
    const p = new URL(request.url).searchParams;
    await mutatePromptInjection({keyId:p.get('keyId'),model:p.get('model')},true);
    return json({deleted:true});
  } catch (error) { return json({error:error.message},400); }
}
