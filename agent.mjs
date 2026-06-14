// Anthropic tool-use loop for the validator ops copilot.
// The model is given the system prompt + the READ-ONLY tools, and runs a
// standard agentic loop until it produces a final answer.

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { config } from './config.mjs';
import { toolDefs, runTool, readAll } from './tools.mjs';
import { assess } from './assess.mjs';

const MAX_TURNS = 8; // safety cap on the tool loop

export async function loadSystemPrompt() {
  const url = new URL('./system-prompt.md', import.meta.url);
  return readFile(url, 'utf8');
}

/**
 * Run the copilot.
 * @param {string} userText
 * @param {Array} history  prior [{role, content}] messages (optional)
 * @param {(t:string)=>void} onTool  optional callback per tool call
 * @returns {Promise<{reply:string, toolsUsed:string[], messages:Array}>}
 */
export async function runAgent(userText, history = [], onTool = () => {}) {
  if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: config.apiKey });
  const system = await loadSystemPrompt();

  const messages = [...history, { role: 'user', content: userText }];
  const toolsUsed = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system,
      tools: toolDefs,
      messages,
    });
    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const reply = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply, toolsUsed, messages };
    }

    const results = [];
    for (const tu of toolUses) {
      toolsUsed.push(tu.name);
      onTool(tu.name);
      let out;
      try { out = await runTool(tu.name, tu.input || {}); }
      catch (e) { out = { error: String(e?.message || e) }; }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: '[copilot] hit max tool turns without a final answer.', toolsUsed, messages };
}

/** No-API-key preview: prove the whole assembly is correct end-to-end. */
export async function dryRun() {
  const system = await loadSystemPrompt();
  const verdict = assess(await readAll());
  return {
    model: config.model,
    apiBase: config.apiBase,
    system_prompt_chars: system.length,
    tools: toolDefs.map((t) => t.name),
    live_verdict_that_would_be_fed: { verdict: verdict.verdict, one_liner: verdict.one_liner, triggers: verdict.triggers },
    note: 'ANTHROPIC_API_KEY not set (or --dry-run). This is exactly what would be sent to the model; add a key to get a natural-language answer.',
  };
}
