# Wiring the copilot into the dashboard

Same pattern the dashboard already uses for `/api/*`: run the copilot as a
backend service and proxy to it. No new npm deps in the dashboard, no changes to
the consensus path.

## 1. Run the copilot service
```bash
cd /path/to/xrpl-validator/copilot
cp .env.example .env && $EDITOR .env        # add ANTHROPIC_API_KEY
pm2 start server.mjs --name validator-copilot
```
It listens on :3780 (`COPILOT_PORT`).

## 2. Proxy from the dashboard
Add to `dashboard/next.config.js` `rewrites()` (dev), and the same upstream in
Caddy for production:
```js
const copilot = process.env.COPILOT_API || 'http://localhost:3780';
return [
  // ...existing rewrites...
  { source: '/copilot', destination: `${copilot}/copilot` },
  { source: '/copilot/health', destination: `${copilot}/health` },
];
```
Caddy (production), inside the dashboard site block:
```
handle /copilot* {
    reverse_proxy localhost:3780
}
```

## 3. Add the chat panel
Drop `CopilotPanel.tsx` (in this folder) into `dashboard/components/`, then render
`<CopilotPanel />` somewhere on the page. It POSTs `{question}` to `/copilot` and
shows the reply. The live verdict chip pulls `/copilot/health` (free, no LLM).

## Notes
- `/copilot/health` is free (deterministic, no model call) — safe to poll for a
  status chip. `/copilot` costs a model call per question — don't poll it.
- The service is READ-ONLY end to end; nothing it exposes can mutate the node.
