import { getAdapter } from '../driver.js';
import { makeKv } from '../helpers/kvStore.js';
import { cleanEntry } from '../../../../open-sse/rtk/promptInjection.js';
const kv = makeKv('promptInjections');
const EMPTY = {global:null,userPrompts:{},prompts:{},keyModelPrompts:{}};
// No process cache: CRUD and database restore become visible on the next request.
export async function getPromptInjections() {
  return {...EMPTY,...await kv.get('config', {})};
}
export async function mutatePromptInjection({keyId,model,global,...raw}, remove = false) {
  for (const value of [keyId, model]) {
    if (value != null && (typeof value !== 'string' || !value || value.length > 300 || ['__proto__','constructor','prototype'].includes(value))) throw new Error('Invalid target');
  }
  const target = keyId || model;
  if (target && (typeof target !== 'string' || target.length > 300 || ['__proto__','constructor','prototype'].includes(target))) throw new Error('Invalid target');
  if (!('global' in arguments[0]) && !target) throw new Error('Provide global, keyId, or model');
  const entry = remove || global === null ? null : {...cleanEntry('global' in arguments[0] ? global : raw),updatedAt:new Date().toISOString()};
  const db = await getAdapter();
  db.transaction(()=>{
    const row = db.get("SELECT value FROM kv WHERE scope = 'promptInjections' AND key = 'config'");
    const config = {...structuredClone(EMPTY),...(row ? JSON.parse(row.value) : {})};
    if ('global' in arguments[0]) config.global = entry;
    else {
      let map = keyId ? config.userPrompts : config.prompts;
      let name = keyId || model;
      if (keyId && model) { map = config.keyModelPrompts[keyId] ||= {}; name = model; }
      if (entry) map[name] = entry; else delete map[name];
    }
    db.run("INSERT INTO kv(scope,key,value) VALUES('promptInjections','config',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value",[JSON.stringify(config)]);
  });
  return entry;
}
