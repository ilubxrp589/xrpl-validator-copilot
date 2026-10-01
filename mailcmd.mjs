// The validator team's mailbox from Telegram (2026-10-01; James: "Everyone should be allowed to talk"). The inbox
// calls this for the owner's /mail (owner only: inbox.mjs checks the chat first):
//   /mail             who has unread mail, and the latest messages
//   /mail ROLE        what waits for ROLE (nothing is marked read)
//   /mail ROLE TEXT   TEXT posted to ROLE, from james
// One mailbox for everyone: this runs ~/bin/handoff, the program the Claude sessions use (the validator team's
// cycle/teammail.py). TEXT goes to it as one argument, never through a shell. A role must be one the mailbox already
// knows, so "/mail please check X" cannot post to a role called "please". Run the tests: npm run test:mail
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const HANDOFF = path.join(os.homedir(), 'bin', 'handoff');
const exec = promisify(execFile);
export const MAIL = '\u{1F4EC} MAIL · ';
export const PATTERN = /^\/mail(?:@\w+)?(?:\s+([a-z][a-z0-9_-]{0,31}))?(?:\s+([\s\S]+))?$/i;

const handoff = (args) => exec(HANDOFF, args, { timeout: 30000 }).then((r) => r.stdout);

export async function mailReply(role, text, run = handoff) {
  role = role && role.toLowerCase();
  try {
    const p = JSON.parse(await run(['peek']));
    if (role && !(p.roles || []).includes(role)) {
      return `No role "${role}". Roles: ${(p.roles || []).join(', ')}. To post: /mail ROLE TEXT`;
    }
    if (role && text) {
      if (role === 'james') return 'That is you: mail to james comes to this chat.';
      return (await run(['post', role, text.trim(), '--from', 'james'])).trim();
    }
    if (role) return (await run(['peek', role])).trim();
    const who = Object.entries(p.unread || {}).map(([r, n]) => `${n} for ${r}`).join(', ') || 'nothing unread';
    const last = (p.latest || []).map((m) => `#${m.id} ${m.from} → ${m.to}: ${String(m.text).slice(0, 160)}`).join('\n');
    return `Mailbox: ${who}.` + (last ? `\nLatest:\n${last}` : '') +
      '\nTo post: /mail ROLE TEXT (cycle = deploys and the harness, ops = the team code and console, team = the automated team, all).';
  } catch (e) {
    return `the mailbox did not answer: ${String(e.stderr || e.message || '').slice(0, 200)}`;
  }
}
