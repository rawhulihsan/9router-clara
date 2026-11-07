import { injectSystemPrompt, injectChatTurns } from './systemInject.js';
import { FORMATS } from '../translator/formats.js';

export function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid injection');
  if (raw.mode !== undefined && !['single', 'chat'].includes(raw.mode)) throw new Error('Invalid mode');
  if (raw.position !== undefined && !['prepend', 'append'].includes(raw.position)) throw new Error('Invalid position');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Invalid enabled');
  const entry = {mode:raw.mode || 'single',position:raw.position || 'append',enabled:raw.enabled !== false};
  if (entry.mode === 'chat') {
    if (!Array.isArray(raw.turns) || !raw.turns.length || raw.turns.length > 50) throw new Error('Expected 1–50 turns');
    entry.turns = raw.turns.map(t => {
      if (!t || !['user','assistant'].includes(t.role) || typeof t.content !== 'string' || !t.content.trim() || t.content.length > 100000) throw new Error('Invalid chat turn');
      return {role:t.role,content:t.content};
    });
    if (entry.turns.some((t,i,a)=>i && t.role === a[i-1].role)) throw new Error('Chat roles must alternate');
  } else {
    if (typeof raw.content !== 'string' || !raw.content.trim() || raw.content.length > 100000) throw new Error('Expected non-empty content (max 100000 characters)');
    entry.content = raw.content;
  }
  return entry;
}

export function selectPromptInjections(config, requestedModel, keyId) {
  return [config.global, keyId && config.userPrompts?.[keyId], config.prompts?.[requestedModel], keyId && config.keyModelPrompts?.[keyId]?.[requestedModel]].filter(e=>e && e.enabled !== false);
}

export function applyPromptInjections(input, path, stack) {
  if (!stack.length) return input;
  const body = structuredClone(input);
  const format = body.conversationState ? FORMATS.KIRO : /\/messages(?:\?|$)/.test(path) ? FORMATS.CLAUDE : body.contents || body.request?.contents ? FORMATS.GEMINI : body.input !== undefined ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI;
  // Responses string inputs need instructions for system prompts and typed input for scripts.
  if (format === FORMATS.OPENAI_RESPONSES && typeof body.input === 'string') {
    if (stack.some(e=>e.mode === 'chat')) body.input = [{type:'message',role:'user',content:[{type:'input_text',text:body.input}]}];
    else if (typeof body.instructions !== 'string') body.instructions = '';
  }
  for (const position of ['prepend','append']) {
    const prompts = stack.filter(e=>e.mode !== 'chat' && (e.position || 'append') === position).map(e=>e.content);
    if (position === 'prepend') prompts.reverse();
    for (const prompt of prompts) {
      const target = format === FORMATS.KIRO && body.conversationState.currentMessage?.userInputMessage
        ? {conversationState:{currentMessage:body.conversationState.currentMessage}} : body;
      injectSystemPrompt(target,format,prompt,position);
    }
  }
  const turns = stack.filter(e=>e.mode === 'chat').flatMap(e=>e.turns);
  if (turns.length) {
    if (format === FORMATS.KIRO) {
      const history = body.conversationState.history ||= [];
      const block = turns.map(t => t.role === 'user' ? {userInputMessage:{content:t.content}} : {assistantResponseMessage:{content:t.content}});
      if (JSON.stringify(history.slice(0, block.length)) !== JSON.stringify(block)) history.unshift(...block);
    } else injectChatTurns(body,format,turns);
  }
  return body;
}
