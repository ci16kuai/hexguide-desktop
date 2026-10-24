import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SELECTION_SCAN_CODES, sanitizeScanCode} from '../server/scan-diagnostics.mjs';

test('the native diagnostic boundary accepts exactly the shared backend scan-code vocabulary', async () => {
  const source = await readFile(new URL('../native/ScreenSelectionWatcher.cs', import.meta.url), 'utf8');
  const helper = source.match(/private static string BackendScanCode\(string code\)([\s\S]*?)private static object BackendAge/);
  assert.ok(helper, 'the native diagnostic sanitizer must remain explicit and reviewable');
  const nativeCodes = [...helper[1].matchAll(/case "([a-z-]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(nativeCodes)].sort(), [...new Set(SELECTION_SCAN_CODES)].sort(), 'adding a backend code must also preserve its native diagnostic meaning');
  assert.equal(new Set(SELECTION_SCAN_CODES).size, SELECTION_SCAN_CODES.length);
  for (const value of [null,undefined,{},true,0,'user supplied text','C:/private/path','ocr-private-failed']) {
    assert.equal(sanitizeScanCode(value),'ocr-unavailable');
  }
});
