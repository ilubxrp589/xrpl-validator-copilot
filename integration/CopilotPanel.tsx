'use client';

// Minimal advisory-copilot chat panel for the validator dashboard.
// Drop into dashboard/components/ and render <CopilotPanel />.
// POSTs to /copilot (proxied to the copilot service); reads /copilot/health
// for the free deterministic verdict chip. No extra dependencies.

import { useEffect, useRef, useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };

const VERDICT_STYLE: Record<string, string> = {
  HEALTHY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  WATCH: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SYNCING: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  DEGRADED: 'bg-red-500/15 text-red-300 border-red-500/30',
  HALT_SUSPECTED: 'bg-red-500/20 text-red-200 border-red-500/40',
  UNREACHABLE: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
};

export default function CopilotPanel() {
  const [verdict, setVerdict] = useState<{ verdict: string; one_liner: string } | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Free, deterministic verdict chip — safe to poll.
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch('/copilot/health');
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setVerdict({ verdict: d.verdict, one_liner: d.one_liner });
      } catch { /* ignore */ }
    };
    pull();
    const id = setInterval(pull, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  async function ask() {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: q }]);
    setBusy(true);
    try {
      const r = await fetch('/copilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
      });
      const d = await r.json();
      setMsgs((m) => [...m, { role: 'assistant', content: d.reply || d.error || '(no reply)' }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: `request failed: ${String(e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col rounded-xl border border-white/10 bg-black/30 p-4 h-[420px]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold tracking-wide text-white/80">Validator Copilot</h3>
        {verdict && (
          <span
            title={verdict.one_liner}
            className={`text-xs px-2 py-0.5 rounded-full border ${VERDICT_STYLE[verdict.verdict] || VERDICT_STYLE.UNREACHABLE}`}
          >
            ● {verdict.verdict}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-1 text-sm">
        {msgs.length === 0 && (
          <p className="text-white/40">Ask about health, divergences, sync, or recovery. Advisory only — read-only.</p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
            <span className={`inline-block whitespace-pre-wrap rounded-lg px-3 py-2 ${m.role === 'user' ? 'bg-white/10 text-white/90' : 'bg-cyan-500/10 text-cyan-100'}`}>
              {m.content}
            </span>
          </div>
        ))}
        {busy && <p className="text-white/40">copilot is reading the node…</p>}
        <div ref={endRef} />
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="is the validator healthy?"
          className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/90 outline-none focus:border-cyan-500/40"
        />
        <button
          onClick={ask}
          disabled={busy}
          className="rounded-lg bg-cyan-500/20 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-40"
        >
          Ask
        </button>
      </div>
    </div>
  );
}
