import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {createOcrWorker} from '../server/ocr-worker.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = (type, id, payload = {status:'waiting'}, extra = {}) => ({version:1,type,id,payload,...extra});
function harness({timeoutMs = 1000, holdClose = false, onCommand} = {}) {
  const children = [], calls = [];
  const worker = createOcrWorker({applicationDirectory:'H:/fixture-application',dataDirectory:'H:/fixture-data',checkOnly:true,timeoutMs,
    spawnProcess:(...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.commands = []; child.kills = 0;
      child.stdin = new Writable({write(chunk, _encoding, done) {
        const value = JSON.parse(chunk.toString()); child.commands.push(value); done(); onCommand?.(child, value);
      }});
      child.send = value => child.stdout.write(JSON.stringify(value) + '\n');
      child.finish = () => child.emit('close', 0);
      child.kill = () => { child.kills++; if (!holdClose) queueMicrotask(child.finish); return true; };
      children.push(child); return child;
    }});
  return {worker,children,calls};
}

test('worker starts lazily once, serializes requests and closes only its own hidden child', async () => {
  const h = harness(); assert.equal(h.children.length, 0);
  const first = h.worker.scan();
  await assert.rejects(h.worker.scan(), {code:'scan-busy'});
  await tick();
  const child = h.children[0], [executable, args, options] = h.calls[0];
  assert.equal(executable, 'powershell.exe');
  assert.ok(args.includes('-Worker') && args.includes('-CheckOnly'));
  assert.ok(args.includes('H:/fixture-data'));
  assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['pipe','pipe','pipe']);
  assert.deepEqual(child.commands, [{version:1,type:'scan',id:1}]);
  child.send(frame('result', 1)); assert.deepEqual(await first, {status:'waiting'});
  const second = h.worker.scan(); await tick(); child.send(frame('result', 2, {status:'unavailable'}));
  assert.equal((await second).status, 'unavailable'); assert.equal(h.children.length, 1);
  const closing = h.worker.close(); assert.equal(h.worker.close(), closing); await closing;
  assert.equal(child.kills, 1);
  await assert.rejects(h.worker.scan(), {code:'scan-execution-failed'});
  assert.equal(h.children.length, 1);
});

test('stage decisions preserve order and remain private until a final result arrives', async () => {
  const h = harness(), seen = []; let completed = false;
  const pending = h.worker.scan(raw => { seen.push(raw.marker); return raw.marker === 'contrast'; }).then(raw => { completed = true; return raw; });
  await tick(); const child = h.children[0];
  child.send(frame('stage', 1, {marker:'color'}, {stage:'color'}));
  child.send(frame('stage', 1, {marker:'contrast'}, {stage:'contrast'}));
  await tick(); assert.equal(completed, false);
  assert.deepEqual(seen, ['color','contrast']);
  assert.deepEqual(child.commands.map(value => value.type), ['scan','continue','accept']);
  child.send(frame('result', 1, {status:'waiting',code:'foreground-changed'}));
  assert.equal((await pending).code, 'foreground-changed'); await h.worker.close();
});

test('contrast stage may follow a failed color group without fabricating a color observation', async () => {
  const h = harness(), pending = h.worker.scan(() => false); await tick(); const child = h.children[0];
  child.send(frame('stage', 1, {}, {stage:'contrast'})); child.send(frame('result', 1));
  await pending; assert.deepEqual(child.commands.map(value => value.type), ['scan','continue']); await h.worker.close();
});

test('large title stage follows the original two passes and remains private until final foreground validation',async()=>{
  const h=harness(),seen=[];
  let completed=false;
  const pending=h.worker.scan(raw=>{seen.push(raw.marker);return raw.marker==='large';}).then(raw=>{completed=true;return raw;});
  await tick();const child=h.children[0];
  for(const stage of ['color','contrast','large'])child.send(frame('stage',1,{marker:stage},{stage}));
  await tick();
  assert.equal(completed,false);
  assert.deepEqual(seen,['color','contrast','large']);
  assert.deepEqual(child.commands.map(value=>value.type),['scan','continue','continue','accept']);
  child.send(frame('result',1,{status:'waiting',code:'foreground-changed'}));
  assert.equal((await pending).code,'foreground-changed');
  await h.worker.close();
});

test('NDJSON decoding tolerates split UTF-8 and CRLF but rejects neither private stderr nor chunk boundaries', async () => {
  const h = harness(), pending = h.worker.scan(); await tick(); const child = h.children[0];
  child.stderr.write('Private exception path C:/private is drained, never returned');
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(frame('result', 1, {status:'waiting',message:'中文'})) + '\r\n');
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await pending, {status:'waiting',message:'中文'}); await h.worker.close();
});

test('malformed, reordered, duplicate and unsolicited protocol frames fail closed', async () => {
  const cases = [
    child => child.stdout.write('Private bad JSON\n'),
    child => child.send(frame('result', 1, [])),
    child => child.send({...frame('result', 1),version:2}),
    child => child.send(frame('result', 2)),
    child => child.send({...frame('result', 1),unknown:'Private'}),
    child => child.send(frame('stage', 1, {}, {stage:'other'})),
    child => { child.send(frame('stage', 1, {}, {stage:'contrast'})); child.send(frame('stage', 1, {}, {stage:'color'})); },
    child => { child.send(frame('stage', 1, {}, {stage:'color'})); child.send(frame('stage', 1, {}, {stage:'color'})); },
    child => { child.send(frame('stage', 1, {}, {stage:'large'})); child.send(frame('stage', 1, {}, {stage:'contrast'})); },
    child => { child.send(frame('stage', 1, {}, {stage:'large'})); child.send(frame('stage', 1, {}, {stage:'large'})); },
    child => child.stdout.write(JSON.stringify(frame('result', 1)) + '\n' + JSON.stringify(frame('result', 1)) + '\n'),
    child => child.stdout.write(JSON.stringify(frame('result', 1)) + '\nPrivate trailing partial frame'),
    child => child.stdout.write(Buffer.from([0xff,0x0a])),
  ];
  for (const send of cases) {
    const h = harness(), pending = h.worker.scan(); const rejected = assert.rejects(pending, error => error.code === 'scan-output-invalid' && !error.message.includes('Private'));
    await tick(); send(h.children[0]); await rejected; await h.worker.close();
    assert.equal(h.children.length, 1); assert.equal(h.children[0].kills, 1);
  }
  for (const evaluator of [() => true, () => 'accept', () => { throw Error('Private'); }]) {
    const h = harness(), pending = h.worker.scan(evaluator), rejected = assert.rejects(pending, {code:'scan-output-invalid'});
    await tick(); const child = h.children[0]; child.send(frame('stage', 1, {}, {stage:'color'}));
    if (!child.kills) child.send(frame('stage', 1, {}, {stage:'contrast'}));
    await rejected; await h.worker.close();
  }
});

test('stdout and stderr bounds kill the worker without forwarding their contents', async () => {
  for (const stream of ['stdout','stderr']) {
    const h = harness(), pending = h.worker.scan(), rejected = assert.rejects(pending, {code:'scan-output-too-large'});
    await tick(); h.children[0][stream].write('x'.repeat(1024 * 1024 + 1)); await rejected; await h.worker.close();
  }
  const h = harness(), pending = h.worker.scan(), rejected = assert.rejects(pending, {code:'scan-output-too-large'});
  await tick(); const child = h.children[0];
  child.send(frame('stage', 1, {padding:'x'.repeat(600000)}, {stage:'color'}));
  child.send(frame('stage', 1, {padding:'x'.repeat(600000)}, {stage:'contrast'}));
  await rejected; await h.worker.close();
});

test('duplicate envelope keys are rejected before JSON parsing can hide contradictory IDs or versions', async () => {
  const invalid = [
    '{"version":2,"version":1,"type":"result","id":1,"payload":{}}',
    '{"version":1,"type":"stage","type":"result","id":1,"payload":{}}',
    '{"version":1,"type":"result","id":999,"id":1,"payload":{}}',
    String.raw`{"version":1,"type":"result","id":999,"\u0069d":1,"payload":{}}`,
    '{"version":1,"type":"result","id":1,"payload":{},"payload":{"status":"waiting"}}',
  ];
  for (const line of invalid) {
    const h = harness(), pending = h.worker.scan(), rejected = assert.rejects(pending, {code:'scan-output-invalid'});
    await tick(); h.children[0].stdout.write(line + '\n');
    await rejected; await h.worker.close(); assert.equal(h.children[0].kills, 1);
  }
  const h = harness(), pending = h.worker.scan(); await tick();
  // Nested names, punctuation and escaped quotes inside values are not keys of
  // the envelope. A valid stage still reaches the normal semantic checks.
  const payload = {status:'waiting',nested:{version:99,id:99},message:'"id":1, { [ ] }',list:[{id:2}]};
  h.children[0].send(frame('result', 1, payload));
  assert.deepEqual(await pending, payload); await h.worker.close();
});

test('EOF, process errors and timeouts settle the current job and never automatically rescan it', async () => {
  for (const trigger of [child => child.stdout.end(),child => child.emit('error', Error('Private')),child => child.finish()]) {
    const h = harness(), pending = h.worker.scan(), rejected = assert.rejects(pending, {code:'scan-execution-failed'});
    await tick(); trigger(h.children[0]); await rejected; await h.worker.close(); assert.equal(h.children.length, 1);
  }
  const h = harness({timeoutMs:30}), pending = h.worker.scan(), rejected = assert.rejects(pending, {code:'scan-execution-failed'});
  await tick(); h.children[0].send(frame('stage', 1, {}, {stage:'color'}));
  await rejected; await h.worker.close(); assert.equal(h.children.length, 1); assert.equal(h.children[0].kills, 1);
});

test('recovery waits until the old child has exited before starting the next job', async () => {
  const h = harness({holdClose:true}), first = h.worker.scan(), rejected = assert.rejects(first, {code:'scan-output-invalid'});
  await tick(); h.children[0].stdout.write('bad\n'); await rejected;
  const second = h.worker.scan(); await tick(); assert.equal(h.children.length, 1);
  h.children[0].finish(); await tick(); assert.equal(h.children.length, 2);
  const child = h.children[1]; assert.equal(child.commands[0].id, 2); child.send(frame('result', 2)); await second;
  const closing = h.worker.close(); child.finish(); await closing;
});

test('close cancels active and retirement-waiting requests and prevents late process starts', async () => {
  const h = harness({holdClose:true}), pending = h.worker.scan(), rejected = assert.rejects(pending, {code:'scan-execution-failed'});
  await tick(); const child = h.children[0], closing = h.worker.close(); await rejected;
  let closed = false; closing.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  child.finish(); await closing; assert.equal(child.kills, 1);

  const waiting = harness({holdClose:true}), first = waiting.worker.scan(), failed = assert.rejects(first);
  await tick(); waiting.children[0].stdout.write('bad\n'); await failed;
  const next = waiting.worker.scan(), cancelled = assert.rejects(next, {code:'scan-execution-failed'});
  const stopped = waiting.worker.close(); await cancelled; waiting.children[0].finish(); await stopped; await tick();
  assert.equal(waiting.children.length, 1);
});

test('a synchronous spawn failure does not poison the next explicit request', async () => {
  let calls = 0;
  const worker = createOcrWorker({applicationDirectory:'H:/fixture',spawnProcess:() => { calls++; throw Error('Private'); }});
  await assert.rejects(worker.scan(), {code:'scan-execution-failed'});
  await assert.rejects(worker.scan(), {code:'scan-execution-failed'});
  assert.equal(calls, 2); await worker.close();
});
