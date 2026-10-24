// Opt-in, read-only game-title probe. No installed user data or backend is used.
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createOcrScanner} from '../server/ocr.mjs';
import {createOfferToken, sanitizeSelectionCapture, SELECTION_MAX_AGE} from '../server/selection.mjs';

const execute = promisify(execFile);
const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 16 * 1024;
const probeStopReasons = new Set(['completed', 'dpi-unavailable', 'game-unverified', 'game-not-foreground',
  'game-not-visible', 'client-unavailable', 'client-changed', 'region-too-large',
  'occlusion-enumeration-incomplete', 'occlusion-bounds-unavailable', 'occlusion-state-unavailable',
  'card-occluded', 'capture-exception', 'invalid-input']);
const reply = (status, code, summary = {}) => ({status, code, ...summary});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseProbeArguments(argv) {
  let allowGameCapture = false, executable = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--allow-game-capture' && !allowGameCapture) allowGameCapture = true;
    else if (argv[index] === '--executable' && executable === null && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--')) executable = argv[++index];
    else return null;
  }
  return {allowGameCapture, executable};
}

export async function checkProbeExecutable(executable, {executeVersion = execute, platform = process.platform} = {}) {
  if (platform !== 'win32' || typeof executable !== 'string' || !executable || path.extname(executable).toLowerCase() !== '.exe') return false;
  // No shell interpolation: execFile passes one PowerShell command argument;
  // single quotes inside the literal path are doubled per PowerShell syntax.
  const literal = path.resolve(executable).replaceAll("'", "''");
  const command = "$ErrorActionPreference='Stop'; $v=[Diagnostics.FileVersionInfo]::GetVersionInfo('" + literal +
    "'); [Console]::Out.Write(('{0}.{1}.{2}.{3}' -f $v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart))";
  try {
    const {stdout} = await executeVersion('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      {windowsHide:true, timeout:5000, maxBuffer:1024, encoding:'utf8'});
    if (typeof stdout !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(stdout.trim())) return false;
    const version = stdout.trim().split('.').map(Number);
    if (version.some(part => part > 65535)) return false;
    const minimum = [1,10,3,0];
    for (let index = 0; index < 4; index++) if (version[index] !== minimum[index]) return version[index] > minimum[index];
    return true;
  } catch { return false; }
}

export function runBoundedProbeChild(executable, args, input = '', {spawnChild = spawn, timeoutMs = 30000} = {}) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_BYTES) return Promise.resolve({ok:false, code:'probe-input-too-large'});
  return new Promise(resolve => {
    let child, timer, settled = false, failure = null, stdoutBytes = 0, stderrBytes = 0;
    const chunks = [];
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(value);
    };
    const stop = code => {
      failure ||= code;
      try { child?.kill(); } catch {}
    };
    try {
      child = spawnChild(executable, args, {windowsHide:true, stdio:['pipe','pipe','pipe'], shell:false});
      child.stdout.on('data', chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > MAX_BYTES) stop('probe-output-too-large');
        else chunks.push(bytes);
      });
      // Never retain or echo native error text, which could contain a file path.
      child.stderr.on('data', chunk => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_BYTES) stop('probe-error-output-too-large');
      });
      child.once('error', () => finish({ok:false, code:'probe-process-unavailable'}));
      child.once('close', exitCode => {
        if (failure) return finish({ok:false, code:failure});
        if (exitCode !== 0) return finish({ok:false, code:'probe-process-failed'});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim());
          finish(object(parsed) ? {ok:true, data:parsed} : {ok:false, code:'probe-output-invalid'});
        } catch { finish({ok:false, code:'probe-output-invalid'}); }
      });
      child.stdin.on('error', () => stop('probe-input-unavailable'));
      timer = setTimeout(() => { stop('probe-timeout'); finish({ok:false, code:'probe-timeout'}); }, Math.min(30000, Math.max(1, timeoutMs)));
      child.stdin.end(input);
    } catch { stop('probe-process-unavailable'); finish({ok:false, code:'probe-process-unavailable'}); }
  });
}

export function buildTitleProbeInput(scan, {now = Date.now, token = createOfferToken} = {}) {
  if (scan?.status !== 'recognized' || scan.selectionMetadataStatus !== 'accepted' || !Array.isArray(scan.proposals) || scan.proposals.length !== 3) return null;
  const ids = scan.proposals.map(proposal => proposal?.id);
  if (ids.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(ids).size !== 3) return null;
  const capture = sanitizeSelectionCapture(scan.selectionCapture);
  if (!capture?.identityAnchors || capture.capturedAt > now() + 1000 || now() - capture.capturedAt > SELECTION_MAX_AGE) return null;
  const offerToken = token();
  if (typeof offerToken !== 'string' || !/^[a-f0-9]{32}$/.test(offerToken)) return null;
  const {capturedAt, ...geometry} = capture;
  const payload = {status:'armed', provider:'screen', experimental:true, offerToken,
    gameId:null, gameEpoch:0, revision:0, ids, capturedAt, capture:geometry};
  return Buffer.byteLength(JSON.stringify(payload)) <= MAX_BYTES ? payload : null;
}

export function summarizeTitleProbe(raw) {
  if (!object(raw) || raw.mode !== 'read-only-game-title-probe' || raw.actualSelectionConfirmed !== false) return null;
  const limits = {captures:100, allTitlesMatched:100, legacyRgbWouldReject:100, readyFrames:100, elapsedMs:30000};
  const summary = {stopReason:probeStopReasons.has(raw.status) ? raw.status : 'probe-stopped'};
  for (const [key, max] of Object.entries(limits)) {
    // The native invalid-input path returns before its stopwatch is created.
    const value = key === 'elapsedMs' && raw[key] === undefined && summary.stopReason === 'invalid-input' ? 0 : raw[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > max) return null;
    summary[key] = value;
  }
  if (!Array.isArray(raw.titleMaskCounts) || raw.titleMaskCounts.length > 8 ||
      raw.titleMaskCounts.some(value => !Number.isSafeInteger(value) || value < 0 || value > 131072)) return null;
  summary.titleMaskCounts = [...raw.titleMaskCounts];
  // Output fixed codes, an exact allowlisted stop reason and numeric counters;
  // an unknown native status is never interpolated or forwarded. No raw strings,
  // proposals, names, pixels, window handles, paths or geometry are forwarded.
  return summary;
}

export async function runTitleIdentityProbe({argv = [], applicationDirectory = repoDirectory, dependencies = {}} = {}) {
  const options = parseProbeArguments(argv);
  if (!options) return reply('rejected', 'invalid-arguments');
  if (!options.allowGameCapture) return reply('disabled', 'explicit-game-capture-required');
  if (!options.executable) return reply('rejected', 'executable-required');
  const executable = path.resolve(options.executable);
  const validateExecutable = dependencies.validateExecutable || checkProbeExecutable;
  const runChild = dependencies.runChild || runBoundedProbeChild;
  try {
    if (!await validateExecutable(executable)) return reply('rejected', 'executable-version-unsupported');
    // An older draft may share 1.10.3's file version but lack the observe flag.
    // The known no-UI self-test proves capability before either capture or probe.
    const capability = await runChild(executable, ['--selection-self-test']);
    if (!capability?.ok || capability.data?.mode !== 'offline-no-ui' || capability.data?.titleProbeVersion !== 1)
      return reply('rejected', 'title-probe-capability-missing');
    const catalog = await (dependencies.readCatalog || (async () => JSON.parse(await readFile(path.join(applicationDirectory, 'dist/data.json'), 'utf8'))))();
    if (!Array.isArray(catalog?.augments)) return reply('rejected', 'catalog-unavailable');
    const scanner = (dependencies.scannerFactory || createOcrScanner)({applicationDirectory, augments:catalog.augments});
    const scan = await scanner();
    const payload = buildTitleProbeInput(scan, {now:dependencies.now || Date.now, token:dependencies.token || createOfferToken});
    if (!payload) return reply('not-run', 'title-metadata-incomplete');
    const result = await runChild(executable, ['--selection-title-observe'], JSON.stringify(payload));
    if (!result?.ok) return reply('rejected', ['probe-timeout','probe-output-too-large','probe-input-too-large','probe-error-output-too-large'].includes(result?.code) ? result.code : 'title-probe-failed');
    const summary = summarizeTitleProbe(result.data);
    if (!summary) return reply('rejected', 'title-probe-output-invalid');
    return summary.stopReason === 'completed' ? reply('completed', 'title-probe-complete', summary)
      : reply('stopped', 'title-probe-stopped', summary);
  } catch { return reply('rejected', 'title-probe-unavailable'); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await runTitleIdentityProbe({argv:process.argv.slice(2)});
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.status === 'rejected' ? 1 : 0;
}
