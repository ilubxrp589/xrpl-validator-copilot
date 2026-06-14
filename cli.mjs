#!/usr/bin/env node
// CLI for the validator ops copilot.
//
//   node cli.mjs "is the validator healthy?"          # uses your claude account (no key)
//   node cli.mjs --dry-run "..."                       # verdict + config only, no model call
//   COPILOT_PROVIDER=api ANTHROPIC_API_KEY=... node cli.mjs "..."   # use the SDK instead

import { config } from './config.mjs';
import { ask } from './copilot.mjs';
import { assess } from './assess.mjs';
import { readAll } from './tools.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const question = args.filter((a) => !a.startsWith('--')).join(' ').trim()
  || 'Give me a current health summary of the validator.';

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyn: '\x1b[36m' };

if (dry) {
  const v = assess(await readAll());
  console.log(JSON.stringify({ provider: config.provider, model: config.model, apiBase: config.apiBase, verdict: v.verdict, one_liner: v.one_liner, triggers: v.triggers }, null, 2));
  process.exit(0);
}

console.log(`${C.dim}provider ${config.provider} · model ${config.model} · reading ${config.apiBase}${C.reset}`);
console.log(`${C.bold}Q:${C.reset} ${question}\n`);

try {
  const { reply, provider, toolsUsed } = await ask(question, [], (name) =>
    process.stdout.write(`${C.cyn}· ${name}${C.reset}\n`),
  );
  console.log(`\n${C.bold}Copilot:${C.reset}\n${reply}\n`);
  console.log(`${C.dim}via ${provider}${toolsUsed?.length ? ` · ${toolsUsed.join(', ')}` : ''}${C.reset}`);
} catch (e) {
  console.error(`\n[error] ${e.message}`);
  if (config.provider === 'api' && !config.apiKey) console.error('Set ANTHROPIC_API_KEY, or unset COPILOT_PROVIDER to use your claude account (cli).');
  process.exit(1);
}
