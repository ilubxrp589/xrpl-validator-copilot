// Provider dispatcher. Picks how to reach the model based on config.provider:
//   'cli' (default) -> `claude` binary, your account auth, no API key
//   'api'           -> Anthropic SDK with ANTHROPIC_API_KEY
// Dynamic imports so the unused path's dependency never has to load.

import { config } from './config.mjs';

/**
 * @returns {Promise<{reply:string, provider:string, toolsUsed:string[]}>}
 */
export async function ask(question, history = [], onTool = () => {}) {
  if (config.provider === 'api') {
    const { runAgent } = await import('./agent.mjs');
    const r = await runAgent(question, history, onTool);
    return { ...r, provider: 'api' };
  }
  const { runViaClaudeCli } = await import('./claude-cli.mjs');
  return runViaClaudeCli(question, history);
}
