// Telegram inbox: long-polls the copilot bot for files sent by the owner
// and saves them to ~/telegram-inbox/. It also takes the owner's taps on the
// validator team's ship-request buttons: a tap is recorded in
// ~/.local/state/xrpl-ops/taps.jsonl for the team, answered, and the buttons
// are removed so a request can be answered only once. Telegram allows one
// getUpdates reader per bot, so taps must come through here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.local.json', import.meta.url)));
const { token, chatId } = cfg.alerts.telegram;
const INBOX = path.join(os.homedir(), 'telegram-inbox');
const OFFSET_FILE = path.join(INBOX, '.offset');
const TAPS = path.join(os.homedir(), '.local', 'state', 'xrpl-ops', 'taps.jsonl');
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(path.dirname(TAPS), { recursive: true });

const api = (m, body) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(r => r.json());

let offset = 0;
try { offset = Number(fs.readFileSync(OFFSET_FILE, 'utf8').trim()) || 0; } catch {}
const safe = s => (s || '').replace(/[^\w.\-]+/g, '_').slice(0, 120);
const sleep = ms => new Promise(s => setTimeout(s, ms));

async function save(fileId, name, msg) {
  const f = await api('getFile', { file_id: fileId });
  if (!f.ok) throw new Error(JSON.stringify(f));
  const ts = new Date(msg.date * 1000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dest = path.join(INBOX, `${ts}_${safe(name) || path.basename(f.result.file_path)}`);
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`);
  await pipeline(res.body, fs.createWriteStream(dest));
  if (msg.caption) fs.writeFileSync(dest + '.caption.txt', msg.caption + '\n');
  console.log(new Date().toISOString(), 'saved', dest);
  await api('sendMessage', { chat_id: msg.chat.id, text: `📥 saved ${path.basename(dest)}` });
}

async function handle(msg) {
  if (String(msg.chat?.id) !== String(chatId)) return; // owner only
  try {
    if (msg.document) await save(msg.document.file_id, msg.document.file_name, msg);
    else if (msg.photo?.length) await save(msg.photo.at(-1).file_id, `photo_${msg.message_id}.jpg`, msg);
    else if (msg.video) await save(msg.video.file_id, msg.video.file_name || `video_${msg.message_id}.mp4`, msg);
    else if (msg.audio) await save(msg.audio.file_id, msg.audio.file_name || `audio_${msg.message_id}.mp3`, msg);
    else if (msg.voice) await save(msg.voice.file_id, `voice_${msg.message_id}.ogg`, msg);
    else if (msg.text) {
      fs.appendFileSync(path.join(INBOX, 'notes.txt'), `${new Date(msg.date * 1000).toISOString()} ${msg.text}\n`);
      console.log(new Date().toISOString(), 'note', msg.text.slice(0, 80));
    }
  } catch (e) { console.error('handle failed', e.message); }
}

// A tap on a ship-request button: sr:<request id>:approve or sr:<request id>:hold, owner only.
async function tap(q) {
  const answer = (text) => api('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) });
  if (String(q.from?.id) !== String(chatId)) { await answer('Only the owner can answer this.'); return; }
  const m = /^sr:(\d+):(approve|hold)$/.exec(q.data || '');
  if (!m) { await answer(); return; }
  const rec = { ts: new Date().toISOString(), request: Number(m[1]), answer: m[2], from: q.from.id, message_id: q.message?.message_id };
  fs.appendFileSync(TAPS, JSON.stringify(rec) + '\n');
  console.log(rec.ts, 'tap', m[2], 'request', m[1]);
  await answer(m[2] === 'approve' ? 'Approved: it ships after the soak.' : 'Held.');
  if (!q.message) return;
  const when = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const note = `\n\n${m[2] === 'approve' ? '✅ Approved after the soak' : '⏸ Held'} · ${when} ET`;
  const target = { chat_id: q.message.chat.id, message_id: q.message.message_id };
  const r = q.message.text ? await api('editMessageText', { ...target, text: q.message.text + note }) : { ok: false };
  if (!r.ok) await api('editMessageReplyMarkup', { ...target, reply_markup: { inline_keyboard: [] } });
}

for (;;) {
  try {
    const r = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    if (!r.ok) { console.error('getUpdates', r.description); await sleep(5000); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      if (u.message) await handle(u.message);
      if (u.callback_query) { try { await tap(u.callback_query); } catch (e) { console.error('tap failed', e.message); } }
      fs.writeFileSync(OFFSET_FILE, String(offset));
    }
  } catch (e) { console.error('poll error', e.message); await sleep(5000); }
}
