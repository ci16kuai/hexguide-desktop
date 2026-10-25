import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createOcrWorker} from '../server/ocr-worker.mjs';

const execute = promisify(execFile);
const applicationDirectory = fileURLToPath(new URL('../', import.meta.url));
const day = new Date().toISOString().slice(0, 10);
const workDirectory = `H:/Chatgpt/work/${day}/hexguide-ocr-optimization`;
const options = {
  iterations:10,
  output:`${workDirectory}/ocr-worker-initialization-benchmark.json`,
  baselineScript:`${workDirectory}/baseline/scan-augments.ps1`
};
const names = new Map([['--iterations','iterations'], ['--output','output'], ['--baseline-script','baselineScript']]);

for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--help') {
    console.log('Usage: node scripts/benchmark-ocr-worker.mjs [--iterations 10] [--baseline-script H:\\path\\scan-augments.ps1] [--output H:\\path\\report.json]');
    console.log('INITIALIZATION ONLY. Runs -CheckOnly: no foreground lookup, screen capture, image files, or recognition on real frames. Does not measure overall app latency or OCR accuracy.');
    process.exit(0);
  }
  const name = names.get(argument);
  if (!name || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${argument}`);
  options[name] = process.argv[++index];
}

options.iterations = Number(options.iterations);
if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 30) throw new RangeError('--iterations must be an integer from 1 to 30.');
if (process.platform !== 'win32') throw new Error('This benchmark requires Windows PowerShell 5.1.');
options.baselineScript = path.resolve(options.baselineScript);
options.output = path.resolve(options.output);
if (path.parse(options.output).root.toUpperCase() !== 'H:\\') throw new Error('Save the benchmark report on H: using --output.');

// Inspect the supplied script before executing it. The benchmark has no option
// to remove -CheckOnly or add a screenshot path to either implementation.
const baselineSource = await readFile(options.baselineScript, 'utf8');
if (!/\[switch\]\$CheckOnly/.test(baselineSource) || !/if\s*\(\s*\$CheckOnly\s*\)/.test(baselineSource)) throw new Error('The baseline must provide its explicit -CheckOnly path.');
const baselineSha256 = createHash('sha256').update(await readFile(options.baselineScript)).digest('hex');
const samples = {baselineCold:[], workerCold:[], workerWarm:[]};

function checkOnlySample(result, elapsedMs, iteration) {
  const diagnostics = {};
  for (const key of ['initializationMs','captureMs','recognitionMs','totalMs']) {
    if (Number.isFinite(result?.diagnostics?.[key])) diagnostics[key] = result.diagnostics[key];
  }
  if (typeof result?.diagnostics?.runtimeReused === 'boolean') diagnostics.runtimeReused = result.diagnostics.runtimeReused;
  const noObservation = Array.isArray(result?.lines) && result.lines.length === 0 && result.text === ''
    && result.selectionCapture == null && result.identityAnchors == null;
  const frameId = typeof result?.frameId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(result.frameId) ? result.frameId : null;
  return {iteration, elapsedMs, status:result?.status ?? null, code:result?.code ?? null, stage:result?.stage ?? null,
    frameId, noObservation, valid:result?.status === 'recognized' && result.code === 'ok' && noObservation && frameId !== null, diagnostics};
}

async function timeSample(collection, iteration, operation) {
  const started = performance.now();
  let sample;
  try {
    const payload = await operation();
    const elapsedMs = performance.now() - started;
    const result = typeof payload === 'string' ? JSON.parse(payload.replace(/^\uFEFF/, '').trim()) : payload;
    sample = checkOnlySample(result, elapsedMs, iteration);
  } catch (error) {
    // Exception text/stderr could contain local paths. Keep only a fixed code.
    sample = {iteration, elapsedMs:performance.now() - started, status:'failed', code:'benchmark-operation-failed', valid:false,
      errorType:error instanceof SyntaxError ? 'SyntaxError' : error?.killed ? 'Timeout' : 'ExecutionError'};
  }
  samples[collection].push(sample);
  console.log(`${collection} ${iteration}: ${sample.elapsedMs.toFixed(3)} ms (${sample.valid ? 'ok' : 'failed'})`);
  return sample;
}

// Each call is a separately launched and fully exited PowerShell process.
for (let iteration = 1; iteration <= options.iterations; iteration++) {
  await timeSample('baselineCold', iteration, async () => {
    const {stdout} = await execute('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',options.baselineScript,'-CheckOnly'],
      {windowsHide:true, timeout:15000, maxBuffer:1024 * 1024, encoding:'utf8'});
    return stdout;
  });
}

// Constructor and scan use only the worker's permanent check-only mode. The
// first scan includes its lazy process startup; subsequent scans reuse it.
const worker = createOcrWorker({applicationDirectory, checkOnly:true, timeoutMs:15000});
try {
  await timeSample('workerCold', 1, () => worker.scan());
  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    await timeSample('workerWarm', iteration, () => worker.scan());
  }
} finally {
  await worker.close();
}

function summary(values) {
  const valid = values.filter(sample => sample.valid);
  const times = valid.map(sample => sample.elapsedMs).sort((a,b) => a - b);
  const percentile = quantile => times.length ? times[Math.ceil(quantile * times.length) - 1] : null;
  return {attempted:values.length, successful:valid.length, failed:values.length - valid.length,
    p50Ms:percentile(.5), p95Ms:percentile(.95), minMs:times[0] ?? null, maxMs:times.at(-1) ?? null};
}

const workerSamples = [...samples.workerCold, ...samples.workerWarm];
const checks = {
  baselineAllSuccessful:samples.baselineCold.every(sample => sample.valid),
  workerAllSuccessful:workerSamples.every(sample => sample.valid),
  coldRuntimeInitialized:samples.workerCold[0]?.diagnostics?.runtimeReused === false,
  warmRuntimeReused:samples.workerWarm.every(sample => sample.diagnostics?.runtimeReused === true && sample.diagnostics.initializationMs === 0),
  noWorkerCaptureOrRecognition:workerSamples.every(sample => sample.noObservation && sample.diagnostics.captureMs === 0 && sample.diagnostics.recognitionMs === 0),
  uniqueWorkerFrameIds:workerSamples.every(sample => sample.frameId) && new Set(workerSamples.map(sample => sample.frameId)).size === workerSamples.length
};
const report = {
  schemaVersion:1, generatedAt:new Date().toISOString(),
  scope:'INITIALIZATION ONLY: -CheckOnly, no foreground lookup, screen capture, image files, or recognition on real frames. These timings do not measure overall application speed or OCR accuracy. Synthetic Chinese OCR accuracy remains a separate test.',
  measurement:{clock:'performance.now', units:'milliseconds', percentile:'nearest rank over successful checks',
    baselineCold:'Full elapsed time for each isolated PowerShell 5.1 process to exit, excluding JSON parsing.',
    workerCold:'First scan on the lazily spawned worker through receipt of its check result.',
    workerWarm:'Subsequent sequential checks on the same initialized worker through receipt of each result.'},
  baseline:{scriptPath:options.baselineScript, sha256:baselineSha256},
  iterations:options.iterations, summaries:Object.fromEntries(Object.entries(samples).map(([name,values]) => [name,summary(values)])), checks, samples
};
await mkdir(path.dirname(options.output), {recursive:true});
await writeFile(options.output, JSON.stringify(report,null,2) + '\n');
console.log(JSON.stringify({output:options.output, summaries:report.summaries, checks}));
if (Object.values(checks).some(value => !value)) process.exitCode = 1;
