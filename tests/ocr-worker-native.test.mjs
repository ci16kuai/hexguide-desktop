import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createOcrWorker} from '../server/ocr-worker.mjs';

const applicationDirectory = fileURLToPath(new URL('../', import.meta.url));

test('native worker lazily initializes once, resets each check frame, and closes its owned process without reading the screen',
  {skip:process.platform !== 'win32', timeout:25000}, async t => {
    const children = [];
    const worker = createOcrWorker({applicationDirectory, checkOnly:true, timeoutMs:15000,
      spawnProcess:(command,args,options) => {
        assert.equal(command, 'powershell.exe');
        assert.ok(args.includes('-Worker'));
        assert.ok(args.includes('-CheckOnly'));
        assert.equal(options.windowsHide, true);
        const child = spawn(command,args,options);
        children.push(child);
        return child;
      }});
    t.after(() => worker.close());
    assert.equal(children.length, 0, 'construction must not spawn native PowerShell');
    const results = [];
    for (let index = 0; index < 4; index++) {
      results.push(await worker.scan(() => assert.fail('check-only must never request OCR stages')));
    }
    assert.equal(children.length, 1, 'sequential checks must reuse one owned process');
    assert.equal(new Set(results.map(result => result.frameId)).size, results.length, 'frame state must reset for every request');
    for (const [index,result] of results.entries()) {
      assert.equal(result.status, 'recognized');
      assert.equal(result.code, 'ok');
      assert.match(result.frameId, /^[A-Za-z0-9_-]{1,80}$/);
      assert.deepEqual(result.lines, []);
      assert.equal(result.text, '');
      assert.equal(result.selectionCapture, undefined);
      assert.equal(result.identityAnchors, undefined);
      assert.equal(result.diagnostics.runtimeReused, index > 0);
      assert.equal(result.diagnostics.captureMs, 0);
      assert.equal(result.diagnostics.recognitionMs, 0);
      assert.ok(Number.isFinite(result.diagnostics.totalMs));
      if (index > 0) assert.equal(result.diagnostics.initializationMs, 0);
    }
    const child = children[0];
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child,'exit');
    await worker.close();
    await exited;
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'close must reap the owned native process');
    await worker.close();
    assert.equal(children.length, 1, 'idempotent close must not spawn another process');
  });
