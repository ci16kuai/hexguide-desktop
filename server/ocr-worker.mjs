import {spawn} from 'node:child_process';
import path from 'node:path';
import {TextDecoder} from 'node:util';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const failure = code => Object.assign(new Error('OCR worker unavailable.'), {code});

function parseEnvelope(text) {
  const envelope = JSON.parse(text);
  if (!record(envelope)) throw failure('scan-output-invalid');
  // JSON.parse discards earlier duplicate members. Check the wire keys as
  // well, including escaped names, before trusting version or request IDs.
  const keys = new Set();
  let depth = 0, expectsKey = false;
  for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]/g)) {
    const token = match[0];
    if (token[0] === '"') {
      if (depth === 1 && expectsKey) {
        const key = JSON.parse(token);
        if (keys.has(key)) throw failure('scan-output-invalid');
        keys.add(key);
        expectsKey = false;
      }
    } else if (token === '{' || token === '[') {
      depth++;
      if (depth === 1) expectsKey = true;
    } else if (token === '}' || token === ']') depth--;
    else if (token === ',' && depth === 1) expectsKey = true;
  }
  return envelope;
}

// Only this transport owns the hidden PowerShell process. Raw OCR observations
// remain in memory; callers receive a result only after the native final check.
export function createOcrWorker({applicationDirectory, dataDirectory, checkOnly = false, spawnProcess = spawn, timeoutMs = 15000} = {}) {
  let worker = null, active = null, closed = false, nextId = 1;
  let retirement = Promise.resolve();
  let closing = null;

  function settle(error, payload) {
    const job = active;
    if (!job) return;
    active = null;
    clearTimeout(job.timer);
    if (error) job.reject(error); else job.resolve(payload);
  }

  function retire(instance, code = 'scan-execution-failed') {
    if (!instance || instance.retired) return;
    instance.retired = true;
    if (worker === instance) worker = null;
    retirement = instance.exited;
    settle(failure(code));
    try { instance.child.kill(); } catch { /* The close event remains the termination boundary. */ }
  }

  function write(instance, value) {
    if (instance.retired) return;
    try { instance.child.stdin.write(JSON.stringify(value) + '\n'); }
    catch { retire(instance); }
  }

  function receive(instance, envelope) {
    const job = active;
    if (!job || job.instance !== instance || job.finished || !record(envelope)
      || envelope.version !== 1 || !Number.isSafeInteger(envelope.id) || envelope.id < 1 || envelope.id !== job.id
      || !record(envelope.payload)) { retire(instance, 'scan-output-invalid'); return; }
    if (envelope.type === 'stage') {
      const order = envelope.stage === 'color' ? 1 : envelope.stage === 'contrast' ? 2 : envelope.stage === 'large' ? 3 : 0;
      if (!exactKeys(envelope, ['version','type','id','stage','payload']) || !order || order <= job.stage || job.accepted) {
        retire(instance, 'scan-output-invalid'); return;
      }
      job.stage = order;
      let accepted;
      try { accepted = job.evaluateStage(envelope.payload); } catch { retire(instance, 'scan-output-invalid'); return; }
      if (typeof accepted !== 'boolean') { retire(instance, 'scan-output-invalid'); return; }
      job.accepted = accepted;
      write(instance, {version:1,type:accepted ? 'accept' : 'continue',id:job.id});
    } else if (envelope.type === 'result' && exactKeys(envelope, ['version','type','id','payload'])) {
      job.finished = true;
      // Validate all frames in this stdout chunk before publishing a result.
      queueMicrotask(() => {
        if (active === job && !instance.retired) settle(null, envelope.payload);
      });
    } else retire(instance, 'scan-output-invalid');
  }

  function start() {
    const args = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(applicationDirectory, 'native/scan-augments.ps1'),'-Worker'];
    if (dataDirectory) args.push('-DataDir', dataDirectory);
    if (checkOnly) args.push('-CheckOnly');
    const child = spawnProcess('powershell.exe', args, {windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
    let exit;
    const instance = {child,retired:false,buffer:Buffer.alloc(0),stderrBytes:0,exited:new Promise(resolve => { exit = resolve; })};
    worker = instance;
    child.on('error', () => retire(instance));
    child.on('close', () => {
      if (worker === instance) worker = null;
      if (active?.instance === instance) settle(failure('scan-execution-failed'));
      instance.retired = true;
      instance.buffer = Buffer.alloc(0);
      exit();
    });
    child.stdin.on('error', () => retire(instance));
    child.stdout.on('error', () => retire(instance));
    child.stdout.on('end', () => retire(instance));
    child.stderr.on('error', () => retire(instance));
    // Drain without retaining exception text, paths, window titles or OCR text.
    child.stderr.on('data', chunk => {
      if (instance.retired) return;
      instance.stderrBytes = Math.min(MAX_OUTPUT_BYTES + 1, instance.stderrBytes + Buffer.byteLength(chunk));
      if (instance.stderrBytes > MAX_OUTPUT_BYTES) retire(instance, 'scan-output-too-large');
    });
    child.stdout.on('data', chunk => {
      if (instance.retired) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const job = active;
      if (!job || job.instance !== instance) { retire(instance, 'scan-output-invalid'); return; }
      job.outputBytes += bytes.length;
      if (job.outputBytes > MAX_OUTPUT_BYTES || instance.buffer.length + bytes.length > MAX_OUTPUT_BYTES) {
        retire(instance, 'scan-output-too-large'); return;
      }
      instance.buffer = Buffer.concat([instance.buffer, bytes]);
      let newline;
      while (!instance.retired && (newline = instance.buffer.indexOf(10)) !== -1) {
        const line = instance.buffer.subarray(0, newline);
        const remaining = instance.buffer.subarray(newline + 1);
        instance.buffer = remaining.length ? remaining : Buffer.alloc(0);
        try {
          const text = new TextDecoder('utf-8', {fatal:true}).decode(line).replace(/^\uFEFF/, '');
          receive(instance, parseEnvelope(text));
        } catch { retire(instance, 'scan-output-invalid'); }
      }
      if (job.finished && instance.buffer.length) retire(instance, 'scan-output-invalid');
    });
    return instance;
  }

  function scan(evaluateStage = () => false) {
    if (closed) return Promise.reject(failure('scan-execution-failed'));
    if (active) return Promise.reject(failure('scan-busy'));
    return new Promise((resolve, reject) => {
      const job = {id:nextId++,evaluateStage,resolve,reject,instance:null,stage:0,accepted:false,finished:false,outputBytes:0,timer:null};
      active = job;
      job.timer = setTimeout(() => {
        if (active !== job) return;
        if (job.instance) retire(job.instance);
        else settle(failure('scan-execution-failed'));
      }, timeoutMs);
      void retirement.then(() => {
        if (closed || active !== job) return;
        try {
          const instance = worker || start();
          job.instance = instance;
          instance.stderrBytes = 0;
          write(instance, {version:1,type:'scan',id:job.id});
        } catch { settle(failure('scan-execution-failed')); }
      });
    });
  }

  function close() {
    if (closing) return closing;
    closed = true;
    if (worker) retire(worker);
    else settle(failure('scan-execution-failed'));
    closing = retirement;
    return closing;
  }
  return {scan,close};
}
