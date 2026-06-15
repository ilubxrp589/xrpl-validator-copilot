// Provider that runs the copilot through the `claude` CLI in print mode (-p),
// using YOUR Claude Code account auth — no ANTHROPIC_API_KEY required.
//
// `claude -p` doesn't expose our custom function tools, so instead of an agentic
// tool loop we use context injection: we run the READ-ONLY readers here in Node,
// compute the deterministic verdict, and inject the full live snapshot + runbooks
// into the prompt. The model answers from that. For this bounded domain that's
// actually better — one call, deterministic about what the model sees, no key.
//
// Safety: tools are disabled on the claude subprocess (--disallowed-tools), and
// -p denies unapproved tools by default anyway, so the subprocess cannot touch
// the node. Everything it reasons over is the injected, read-only snapshot.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { config } from './config.mjs';
import { readAll, runTool, divergenceBreakdownFrom, nodeProfile } from './tools.mjs';
import { assess } from './assess.mjs';
import { getTrend } from './trend.mjs';
import { incidentSummary } from './incidents.mjs';

const DISABLED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'NotebookEdit', 'TodoWrite'];
const RUNBOOKS = ['health-check', 'drift-recovery', 'upgrade', 'spin-up'];

const MODE_NOTE = `

## RUNTIME MODE — injected context (no callable tools)
You have NO tools to call in this mode. Everything described under "Tools" has
ALREADY been read for you THIS turn and is in the <LIVE_DATA> block of the user
message: the deterministic verdict, every signal, the raw engine / state-hash /
consensus / rippled / host-resources payloads, a \`trend\` block (deltas & rates over the last hour — use it for any "is X growing/changing/when did it start" question), an \`incidents\` block (alert-worthy events over the last 7d — use it for "how often / has this happened before / been stable lately"), and all four runbooks. Treat
<LIVE_DATA> as fresh tool output captured just now. Answer ONLY from it. If a
question needs something not present, say which reading is missing rather than
guessing. Report LIVE_DATA.health.verdict and LIVE_DATA.health.one_liner verbatim. If
LIVE_DATA.node_profile is present, it's the operator's notes on what's NORMAL and
what's KNOWN for this specific node — weight it heavily and don't re-flag known quirks.`;

const load = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

async function buildBundle() {
  const raw = await readAll();
  return {
    health: assess(raw),
    trend: getTrend(60),
    incidents: incidentSummary(168),
    tier: raw.ffiAvailable ? 'generic+ffi' : 'generic',
    amendments: raw.amendments,
    validators: raw.validators,
    validations: raw.validations,
    divergences: await divergenceBreakdownFrom(raw),
    node_profile: await nodeProfile(),
    host: raw.host,
    raw: { rippled: raw.rippled, ffi: raw.ffi },
    resources: await runTool('get_node_resources'),
  };
}

async function loadRunbooks() {
  const out = {};
  for (const n of RUNBOOKS) { try { out[n] = await load(`./runbooks/${n}.md`); } catch { /* skip */ } }
  return out;
}

export async function runViaClaudeCli(question, history = []) {
  const system = (await load('./system-prompt.md')) + MODE_NOTE;
  const bundle = await buildBundle();
  const runbooks = await loadRunbooks();
  const hist = history.length
    ? `\n\n<CONVERSATION_SO_FAR>\n${history.map((m) => `${String(m.role).toUpperCase()}: ${m.content}`).join('\n')}\n</CONVERSATION_SO_FAR>`
    : '';

  const prompt =
`<LIVE_DATA>
${JSON.stringify(bundle, null, 1)}
</LIVE_DATA>

<RUNBOOKS>
${Object.entries(runbooks).map(([k, v]) => `### runbook: ${k}\n${v}`).join('\n\n')}
</RUNBOOKS>${hist}

QUESTION: ${question}`;

  return callClaude(system, prompt);
}

function callClaude(system, prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--system-prompt', system,
      '--model', config.model,
      '--output-format', 'text',
      '--disallowed-tools', ...DISABLED_TOOLS, // variadic, kept last
    ];
    const child = spawn(config.claudeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude -p timed out (180s)')); }, 180_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`failed to spawn '${config.claudeBin}': ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ reply: out.trim(), provider: 'claude-cli', toolsUsed: ['(injected snapshot)'] });
      else reject(new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 500)}`));
    });
  });
}

// --- Phase 4: investigate mode — claude -p with native READ-ONLY code tools ---
const INVESTIGATE_SYSTEM = `You are the Validator Ops Copilot in INVESTIGATE mode.
You have READ-ONLY access (Read, Grep, Glob) to the validator's source in the current
directory. Investigate the operator's question by reading the code: locate the relevant
files/functions, trace the logic, and explain the likely root cause in plain English
with file:line references.

Rules:
- You are strictly READ-ONLY — no Bash/Edit/Write. Never edit, run, or change anything.
- Read ONLY source code relevant to the question. NEVER read, summarize, or output the
  contents of credential/secret files (.env, config.local.json, *.pin, keys, tokens).
- If the answer isn't in the code you can see, say so plainly.`;

export async function runInvestigate(question) {
  if (!config.codeRoot) return { reply: 'Investigate mode is not configured (set codeRoot to the validator source dir).', provider: 'investigate', toolsUsed: [] };
  let health = '', profile = '';
  try { const a = assess(await readAll()); health = `Live node verdict: ${a.verdict} — ${a.one_liner}\n\n`; } catch { /* ignore */ }
  try { const p = await nodeProfile(); if (p) profile = `Operator's node profile (known-normal / known-issues — trust this):\n${p}\n\n`; } catch { /* ignore */ }
  const prompt = `${profile}${health}INVESTIGATE: ${question}`;
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--system-prompt', INVESTIGATE_SYSTEM,
      '--model', config.model,
      '--output-format', 'text',
      '--add-dir', config.codeRoot,
      '--allowed-tools', 'Read', 'Grep', 'Glob',
    ];
    const child = spawn(config.claudeBin, args, { cwd: config.codeRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('investigate timed out (240s)')); }, 240_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`failed to spawn '${config.claudeBin}': ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ reply: out.trim(), provider: 'investigate', toolsUsed: ['Read', 'Grep', 'Glob'] });
      else reject(new Error(`investigate exited ${code}: ${(err || out).trim().slice(0, 400)}`));
    });
  });
}
