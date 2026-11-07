import { timingSafeEqual } from 'node:crypto';
import { getPromptInjections } from './db/repos/promptInjectRepo.js';
import { getApiKeyByKey } from './db/repos/apiKeysRepo.js';
import { createDashboardAuthToken, verifyDashboardAuthToken } from './auth/dashboardSession.js';
import { applyPromptInjections, selectPromptInjections } from '../../open-sse/rtk/promptInjection.js';

export function isInternalInjectionRequest(request) {
  const expected = process.env.PROMPT_INJECTION_INTERNAL_TOKEN;
  const supplied = request.headers.get('x-9r-injection-internal-token');
  if (!expected || !supplied) return false;
  const a=Buffer.from(expected), b=Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a,b);
}
export async function injectionAuthorized(request) {
  const cookie = request.headers.get('cookie') || '';
  if (process.env.PROMPT_INJECTION_UPSTREAM) {
    const response = await fetch(new URL('/api/auth/status',process.env.PROMPT_INJECTION_UPSTREAM),{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(5000)});
    return response.ok && (await response.json()).authenticated === true;
  }
  const token = cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('auth_token='))?.slice(11);
  return verifyDashboardAuthToken(token);
}
export async function resolvePromptInjection(body,path,headers={}) {
  const config = await getPromptInjections();
  const h = new Headers(headers);
  const key = h.get('authorization')?.replace(/^Bearer\s+/i,'') || h.get('x-api-key') || h.get('x-goog-api-key') || new URL(path,'http://local').searchParams.get('key');
  let keyId = null;
  if (key && (Object.keys(config.userPrompts).length || Object.keys(config.keyModelPrompts).length)) {
    if (process.env.PROMPT_INJECTION_UPSTREAM) {
      // Shared explicit JWT_SECRET lets blue authenticate metadata without copying credentials.
      if (!process.env.JWT_SECRET) throw new Error('Front metadata requires shared JWT_SECRET');
      const token = await createDashboardAuthToken();
      const response = await fetch(new URL('/api/keys',process.env.PROMPT_INJECTION_UPSTREAM),{headers:{cookie:`auth_token=${token}`},redirect:'manual',signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error('Upstream key metadata unavailable');
      keyId = (await response.json()).keys?.find(k=>k.key === key && k.isActive !== false)?.id || null;
    } else keyId = (await getApiKeyByKey(key))?.id || null;
  }
  const requestedModel = body.model || decodeURIComponent(path.match(/\/models\/([^:?]+)/)?.[1] || '');
  return applyPromptInjections(body,path,selectPromptInjections(config,requestedModel,keyId));
}
