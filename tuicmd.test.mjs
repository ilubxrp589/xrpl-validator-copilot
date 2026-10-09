// /tui from Telegram: the command pattern, and tuiPicture with a stand-in renderer. Run: npm run test:tui
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tuiPicture, PATTERN } from './tuicmd.mjs';

assert.ok(PATTERN.test('/tui'));
assert.ok(PATTERN.test('/TUI'));
assert.ok(PATTERN.test('/tui@halcyon_bot'));
assert.ok(!PATTERN.test('/tuis'));
assert.ok(!PATTERN.test('/tui now'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuicmd-'));
const ok = await tuiPicture(async (out) => fs.writeFileSync(out, 'png'), dir);
assert.ok(ok.file && fs.existsSync(ok.file), 'a picture comes back');
assert.match(ok.caption, /^HALCYON · \d{1,2}:\d{2}:\d{2} [AP]M ET$/);
const empty = await tuiPicture(async () => {}, dir);
assert.equal(empty.error, 'the dashboard gave no picture');
const failed = await tuiPicture(async () => { throw Object.assign(new Error('x'), { stderr: 'ssh: connect timed out' }); }, dir);
assert.equal(failed.error, 'the dashboard did not answer: ssh: connect timed out');
fs.rmSync(dir, { recursive: true, force: true });
console.log('tuicmd: all checks passed');
