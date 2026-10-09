// /tui from Telegram (2026-10-09; James: "I wish I had a way to look at the tui on my phone"): one live picture of the
// validator's terminal dashboard (HALCYON, xrpl-watch), sent back as a full-size PNG. A Telegram photo is recompressed
// to a size where the dashboard's text cannot be read, so it goes out as a document, which keeps every pixel.
// The inbox calls this for the owner's /tui (owner only: inbox.mjs checks the chat first). The picture comes from
// ~/bin/tui-snap OUT.png, which runs the dashboard once on the validator host and draws it; nothing here talks to the
// validator itself. Run the tests: npm run test:tui
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SNAP = path.join(os.homedir(), 'bin', 'tui-snap');
const exec = promisify(execFile);
export const PATTERN = /^\/tui(?:@\w+)?\s*$/i;

const snap = (out) => exec(SNAP, [out], { timeout: 60000 });

// The picture's path and its caption, or an error message to send instead.
export async function tuiPicture(run = snap, dir = os.tmpdir()) {
  const out = path.join(dir, `halcyon-${Date.now()}.png`);
  try {
    await run(out);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) return { error: 'the dashboard gave no picture' };
    const when = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    return { file: out, caption: `HALCYON · ${when} ET` };
  } catch (e) {
    return { error: `the dashboard did not answer: ${String(e.stderr || e.message || '').slice(0, 200)}` };
  }
}

// sendDocument with the PNG as a multipart upload (the JSON api() in inbox.mjs cannot carry a file).
export async function sendPicture(token, chatId, pic) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', pic.caption);
  form.append('disable_notification', 'true');
  form.append('document', new Blob([fs.readFileSync(pic.file)], { type: 'image/png' }), path.basename(pic.file));
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form }).then((x) => x.json());
  fs.rmSync(pic.file, { force: true });
  return r;
}
