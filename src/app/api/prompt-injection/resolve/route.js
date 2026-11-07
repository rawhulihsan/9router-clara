import { isInternalInjectionRequest, resolvePromptInjection } from '@/lib/promptInjection.js';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  if (!isInternalInjectionRequest(request)) return Response.json({error:'Not found'},{status:404});
  try {
    const {body,path,headers} = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof path !== 'string' || !path.startsWith('/')) return Response.json({error:'Invalid request'},{status:400});
    return Response.json({body:await resolvePromptInjection(body,path,headers)});
  } catch { return Response.json({error:'Injection resolution failed'},{status:502}); }
}
