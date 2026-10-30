import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

test('actual native copy lifecycle retires a stopped capture even if cancellation completes successfully',
  {skip:process.platform !== 'win32', timeout:20000}, async t => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const workRoot = process.env.HEXGUIDE_TEST_WORK || 'H:\\Chatgpt\\work\\2026-10-30\\hexguide-selected-fixes\\lifecycle';
    await mkdir(workRoot, {recursive:true});
    const work = await mkdtemp(path.join(workRoot, 'native-'));
    t.after(async () => {
      assert.ok(path.resolve(work).startsWith(path.resolve(workRoot) + path.sep));
      await rm(work, {recursive:true, force:true});
    });
    const {stdout} = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(root, 'tests', 'fixtures', 'window-copy-lifecycle.ps1'), '-Root', root, '-Work', work],
    {windowsHide:true, timeout:18000, encoding:'utf8', maxBuffer:64000});
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    assert.equal(result.mode, 'offline-fault-injection');
    assert.equal(result.liveVerified, false);
    assert.equal(result.checks, 18);
  });
