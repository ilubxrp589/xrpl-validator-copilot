#!/usr/bin/env node
// Tiny HTTP service for the validator ops copilot. Fits the existing dashboard
// architecture: run it as a backend, point a dashboard rewrite at it (just like
// /api/* → validator). Zero deps beyond the Anthropic SDK already installed.
//
//   node server.mjs                 # listens on COPILOT_PORT (default 3780)
//   pm2 start server.mjs --name validator-copilot
//
// Routes:
//   GET  /health    -> deterministic verdict JSON (no LLM, free, fast)
//   POST /copilot   -> { question, history? } -> { reply, toolsUsed }  (LLM)
//   GET  /          -> service info

import { createServer } from 'node:http';
import { config } from './config.mjs';
import { readAll } from './tools.mjs';
import { assess } from './assess.mjs';
import { ask } from './copilot.mjs';
import { startSampler, getTrend } from './trend.mjs';
import * as watchdog from './watchdog.mjs';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.COPILOT_PORT || 3780);

// PIN gate: the paid /copilot endpoint requires a PIN when one is configured.
// Read fresh each request from .copilot-pin (or COPILOT_PIN env) so changing it
// takes effect with NO restart. Unset → /copilot is open (warned at boot).
function currentPin() {
  try { return readFileSync(new URL('./.copilot-pin', import.meta.url), 'utf8').trim(); }
  catch { return process.env.COPILOT_PIN || ''; }
}

// Light per-IP rate limit so a leaked/shared PIN can't drain the account.
const RL = new Map();
function rateLimited(ip, max = 30, windowMs = 600_000) {
  const now = Date.now();
  const arr = (RL.get(ip) || []).filter((t) => now - t < windowMs);
  RL.set(ip, arr);
  if (arr.length >= max) return true;
  arr.push(now);
  return false;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, assess(await readAll()));
    }
    if (req.method === 'GET' && req.url.startsWith('/trend')) {
      const mins = Number(new URL(req.url, 'http://x').searchParams.get('mins') || 60);
      return send(res, 200, getTrend(mins));
    }
    if (req.method === 'GET' && req.url.startsWith('/alert-test')) {
      const pin = currentPin();
      if (pin && (req.headers['x-copilot-pin'] || '') !== pin) return send(res, 401, { error: 'PIN required or invalid' });
      return send(res, 200, await watchdog.sendTest());
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      return send(res, 200, { service: 'xrpl-validator-copilot', model: config.model, provider: config.provider, apiBase: config.apiBase, pinRequired: !!currentPin(), routes: ['GET /health', 'GET /trend', 'GET /alert-test', 'POST /copilot'] });
    }
    if (req.method === 'POST' && req.url === '/copilot') {
      if (config.provider === 'api' && !config.apiKey) return send(res, 503, { error: 'provider=api but ANTHROPIC_API_KEY not set' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) { req.destroy(); return; } }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      const question = (body.question || '').toString().trim();
      if (!question) return send(res, 400, { error: 'missing "question"' });
      const history = Array.isArray(body.history) ? body.history : [];
      const pin = currentPin();
      if (pin && (req.headers['x-copilot-pin'] || body.pin || '') !== pin) {
        return send(res, 401, { error: 'PIN required or invalid' });
      }
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) return send(res, 429, { error: 'too many prompts — slow down a moment' });
      const { reply, toolsUsed, provider } = await ask(question, history);
      return send(res, 200, { reply, toolsUsed, provider });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`validator-copilot listening on :${PORT}  (provider ${config.provider}, model ${config.model}, pin ${currentPin() ? 'ON' : 'OFF — open'}, reading ${config.apiBase})`);
  startSampler(undefined, watchdog.tick);
  console.log(`trend sampler started · watchdog: ${config.alerts.channel || 'disabled'}`);
});
