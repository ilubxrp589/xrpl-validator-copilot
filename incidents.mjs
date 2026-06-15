// Phase 3 — incident memory.
//
// A small persistent log of alert-worthy events (verdict flips, predictive trips) so
// alerts carry context ("3rd WATCH this week") and COP / the digest can report how the
// node has behaved over time instead of only "right now". Read-only and local:
// append-only jsonl + in-memory ring; nothing here touches the node.

import { readFileSync, appendFileSync } from 'node:fs';

const FILE = new URL('./incidents.jsonl', import.meta.url);
const MAX = 2000;
const WEEK_MS = 7 * 86_400_000;
const ring = [];
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const recs = readFileSync(FILE, 'utf8').trimEnd().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    ring.push(...recs.slice(-MAX));
  } catch { /* none yet */ }
}

/** Record one incident. kind e.g. 'watch'|'degraded'|'divergence_growing'; level 'warning'|'critical'. */
export function recordIncident(inc) {
  ensureLoaded();
  const rec = { ts: Date.now(), kind: inc.kind, level: inc.level || 'warning', verdict: inc.verdict || null, detail: String(inc.detail || '').slice(0, 300) };
  ring.push(rec);
  while (ring.length > MAX) ring.shift();
  try { appendFileSync(FILE, JSON.stringify(rec) + '\n'); } catch { /* ignore */ }
  return rec;
}

/** How many of this kind happened in the window (incl. the one just recorded). */
export function countOfKind(kind, windowMs = WEEK_MS) {
  ensureLoaded();
  const since = Date.now() - windowMs;
  return ring.filter((r) => r.kind === kind && r.ts >= since).length;
}

/** Rolled-up view over the last `windowHours` for COP context / digest / the endpoint. */
export function incidentSummary(windowHours = 168) {
  ensureLoaded();
  const since = Date.now() - windowHours * 3_600_000;
  const recs = ring.filter((r) => r.ts >= since);
  const byKind = {}, byLevel = {};
  for (const r of recs) { byKind[r.kind] = (byKind[r.kind] || 0) + 1; byLevel[r.level] = (byLevel[r.level] || 0) + 1; }
  const last = ring[ring.length - 1] || null;
  return {
    window_hours: windowHours,
    total: recs.length,
    by_kind: byKind,
    by_level: byLevel,
    last_incident: last ? { ...last, ago_min: Math.round((Date.now() - last.ts) / 60_000) } : null,
    quiet: recs.length === 0,
    note: recs.length === 0 ? `no incidents in the last ${Math.round(windowHours / 24)}d` : undefined,
  };
}

export function getIncidents(n = 20) {
  ensureLoaded();
  return ring.slice(-Math.max(1, Math.min(n, 200)));
}
