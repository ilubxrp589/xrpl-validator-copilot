// /mail from Telegram against the real ~/bin/handoff, on a scratch mailbox (XRPL_OPS_MAIL). Run: npm run test:mail
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mailReply, PATTERN } from './mailcmd.mjs';

process.env.XRPL_OPS_MAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcmd-'));
const parse = (t) => { const m = PATTERN.exec(t); return m && [m[1] || null, m[2] || null]; };
assert.deepEqual(parse('/mail'), [null, null]);
assert.deepEqual(parse('/mail cycle'), ['cycle', null]);
assert.deepEqual(parse('/mail cycle please check soak #37'), ['cycle', 'please check soak #37']);
assert.equal(parse('/mailbox x'), null);

assert.match(await mailReply(null, null), /^Mailbox: nothing unread\./);
assert.match(await mailReply('please', 'check the soak'), /^No role "please"\. Roles: cycle, james, ops, team, all/);
assert.match(await mailReply('cycle', 'is soak #37 still clean?'), /^posted #1 to cycle$/);
assert.match(await mailReply('Cycle', null), /#1 .* james -> cycle:\n  is soak #37 still clean\?/);
assert.equal(await mailReply('james', 'hi'), 'That is you: mail to james comes to this chat.');
assert.match(await mailReply(null, null), /^Mailbox: 1 for cycle\.\nLatest:\n#1 james → cycle: is soak #37 still clean\?/);
const log = fs.readFileSync(path.join(process.env.XRPL_OPS_MAIL, 'mail.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.deepEqual(log.map((m) => [m.from, m.to]), [['james', 'cycle']]);   // nothing else was posted
fs.rmSync(process.env.XRPL_OPS_MAIL, { recursive: true, force: true });
console.log('mailcmd: all checks passed');
