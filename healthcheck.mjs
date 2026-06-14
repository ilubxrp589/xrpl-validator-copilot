#!/usr/bin/env node
// No-LLM health verdict. Reads live signals and prints the deterministic
// assessment. Works with zero dependencies and no API key — this is the ground
// truth the copilot is built on. Use it standalone, in cron, or to sanity-check
// what the LLM was handed.
//
//   node healthcheck.mjs           # human-readable
//   node healthcheck.mjs --json    # machine-readable

import { readAll } from './tools.mjs';
import { assess } from './assess.mjs';

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', cyn: '\x1b[36m' };
const color = (s) => ({ ok: C.grn, watch: C.yel, degraded: C.red, syncing: C.cyn, unknown: C.dim }[s] || C.reset);
const verdictColor = (v) => ({ HEALTHY: C.grn, WATCH: C.yel, SYNCING: C.cyn, DEGRADED: C.red, HALT_SUSPECTED: C.red, UNREACHABLE: C.red }[v] || C.reset);

const a = assess(await readAll());

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(a, null, 2));
  process.exit(a.verdict === 'HEALTHY' || a.verdict === 'SYNCING' || a.verdict === 'WATCH' ? 0 : 1);
}

console.log(`\n${C.bold}${verdictColor(a.verdict)}● ${a.verdict}${C.reset}  ${a.one_liner}\n`);
for (const [name, s] of Object.entries(a.signals)) {
  const tag = s.informational ? `${C.dim}info${C.reset}` : `${color(s.status)}${s.status.padEnd(8)}${C.reset}`;
  console.log(`  ${tag} ${C.bold}${name}${C.reset}\n       ${C.dim}${s.detail}${C.reset}`);
}
if (a.read_errors?.length) console.log(`\n  ${C.red}read errors:${C.reset} ${a.read_errors.join('; ')}`);
console.log('');
process.exit(['HEALTHY', 'SYNCING', 'WATCH'].includes(a.verdict) ? 0 : 1);
