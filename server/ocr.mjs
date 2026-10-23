import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const result = (status, message, proposals = []) => ({status, message, proposals});

const signature = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s/gu, '');
const validBox = box => ['x','y','width','height'].every(key => Number.isFinite(box?.[key])) && box.width > 0 && box.height > 0;
function boundingBox(boxes) {
  if (!boxes.length || boxes.some(box => !validBox(box))) return null;
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return {x, y, width:Math.max(...boxes.map(box => box.x + box.width)) - x, height:Math.max(...boxes.map(box => box.y + box.height)) - y};
}

function createDictionary(eligible) {
  const dictionary = new Map();
  for (const augment of eligible) for (const alias of [augment.name, augment.enName, ...(augment.aliases || [])]) {
    const name = normalize(alias);
    if (!name) continue;
    const entries = dictionary.get(name) || [];
    if (!entries.some(entry => entry.augment.id === augment.id && entry.signature === signature(alias))) entries.push({augment, signature:signature(alias)});
    dictionary.set(name, entries);
  }
  return text => {
    const entries = dictionary.get(normalize(text)) || [];
    let candidates = new Map(entries.map(entry => [entry.augment.id, entry.augment]));
    // Punctuation can distinguish real names such as 罪恶快感 / 罪恶快感！.
    // Missing punctuation remains ambiguous; OCR must not silently choose one.
    if (candidates.size > 1 && /[\p{P}\p{S}]/u.test(signature(text))) candidates = new Map(entries.filter(entry => entry.signature === signature(text)).map(entry => [entry.augment.id, entry.augment]));
    return candidates.size === 1 ? [...candidates.values()][0] : null;
  };
}

function readLine(line, lookup) {
  const text = String(line?.text || '').slice(0, 500);
  const exact = lookup(text);
  if (exact) return validBox(line) ? [{augment:exact, ...boundingBox([line])}] : [];
  const words = Array.isArray(line?.words) ? line.words.slice(0, 60) : [];
  // OCR sometimes places all three card headings in one line. Split only when
  // EVERY word belongs to a complete, unique dictionary name and has a box.
  // A name embedded in chat, a player name, or a description never qualifies.
  if (words.length < 2 || words.some(word => !validBox(word)) || normalize(words.map(word => word.text).join(' ')) !== normalize(text)) return [];
  const paths = [];
  function partition(start, matches) {
    if (paths.length > 1) return;
    if (start === words.length) { if (matches.length > 1) paths.push(matches); return; }
    if (matches.length >= 3) return;
    for (let end = start + 1; end <= words.length; end++) {
      const slice = words.slice(start, end);
      const augment = lookup(slice.map(word => word.text).join(' '));
      if (augment) partition(end, [...matches, {augment, ...boundingBox(slice)}]);
    }
  }
  partition(0, []);
  return paths.length === 1 ? paths[0] : [];
}

function cardLayout(candidates, width, height) {
  const ordered = [...candidates].sort((a,b) => (a.x + a.width / 2) - (b.x + b.width / 2));
  if (new Set(ordered.map(item => item.augment.id)).size !== 3) return false;
  const centers = ordered.map(item => ({x:item.x + item.width / 2, y:item.y + item.height / 2}));
  if (ordered.some(item => item.height < Math.max(12, height * .012) || item.height > height * .08 || item.width > width * .32 || item.x < 0 || item.x + item.width > width || item.y < height * .12 || item.y + item.height > height * .72)) return false;
  const gaps = [centers[1].x - centers[0].x, centers[2].x - centers[1].x];
  if (gaps.some(gap => gap < width * .12 || gap > width * .4) || Math.max(...gaps) / Math.min(...gaps) > 1.8) return false;
  if (centers[0].x < width * .08 || centers[0].x > width * .46 || centers[1].x < width * .3 || centers[1].x > width * .7 || centers[2].x < width * .54 || centers[2].x > width * .92) return false;
  const heights = ordered.map(item => item.height);
  if (Math.max(...heights) / Math.min(...heights) > 1.8) return false;
  return Math.max(...centers.map(item => item.y)) - Math.min(...centers.map(item => item.y)) <= Math.max(12, height * .018, Math.max(...heights) * .7);
}

export function matchOcrProposals(raw, augments) {
  if (raw?.status !== 'recognized') return result(raw?.status === 'waiting' ? 'waiting' : 'unavailable', typeof raw?.message === 'string' ? raw.message.slice(0, 200) : '本次没有读到清楚的海克斯名称，可手动选择。');
  const eligible = augments.filter(augment => augment.availability === 'current' && augment.recommendable !== false && !augment.retiredPatch && !augment.isInternalTemplate);
  const width = raw.capture?.width ?? raw.diagnostics?.width, height = raw.capture?.height ?? raw.diagnostics?.height;
  const incomplete = () => result('unavailable', '未确认到同一排的三个海克斯卡片标题。请在三选一界面重试，或手动填入；战斗画面中的名称不会作为本轮选项。');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 640 || height < 360 || width > 8192 || height > 8192) return incomplete();
  const lookup = createDictionary(eligible);
  const groups = new Map();
  for (const line of (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 200)) {
    // Never combine observations from separate frames or recognition passes.
    const group = JSON.stringify([line.frameId ?? raw.frameId ?? '', line.pass ?? raw.pass ?? 'full-window']);
    const entries = groups.get(group) || [];
    for (const match of readLine(line, lookup)) if (!entries.some(item => item.augment.id === match.augment.id && Math.abs(item.x - match.x) < 3 && Math.abs(item.y - match.y) < 3)) entries.push(match);
    groups.set(group, entries);
  }
  const layouts = new Map();
  for (const entries of groups.values()) {
    if (entries.length > 30) continue;
    for (let i = 0; i < entries.length - 2; i++) for (let j = i + 1; j < entries.length - 1; j++) for (let k = j + 1; k < entries.length; k++) {
      const triple = [entries[i], entries[j], entries[k]];
      if (!cardLayout(triple, width, height)) continue;
      triple.sort((a,b) => a.x - b.x);
      layouts.set(JSON.stringify(triple.map(item => item.augment.id)), triple);
    }
  }
  if (layouts.size !== 1) return incomplete();
  const proposals = [...layouts.values()][0].map(({augment}) => ({id:augment.id, name:augment.name, confidence:'exact'}));
  return result('recognized', '识别到同排的三个候选标题，请逐一核对后再带入推荐；这不会自动记录为已选海克斯。', proposals);
}

export function createOcrScanner({applicationDirectory, dataDirectory, augments = [], executeScript = execute, platform = process.platform} = {}) {
  let busy = false;
  return async function scan() {
    if (busy) return result('waiting', '上一次识别尚未完成，请稍候。');
    if (platform !== 'win32') return result('unavailable', '屏幕识别目前仅支持 Windows，可手动选择海克斯。');
    busy = true;
    try {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(applicationDirectory, 'native/scan-augments.ps1')];
      if (dataDirectory) args.push('-DataDir', dataDirectory);
      const {stdout} = await executeScript('powershell.exe', args, {windowsHide:true, timeout:15000, maxBuffer:1024 * 1024, encoding:'utf8'});
      const text = stdout.replace(/^\uFEFF/, '').trim();
      if (Buffer.byteLength(text) > 1024 * 1024) return result('unavailable', '识别结果过长，请手动选择。');
      return matchOcrProposals(JSON.parse(text), augments);
    } catch {
      return result('unavailable', '本次屏幕识别未完成，可检查游戏窗口或手动选择。');
    } finally { busy = false; }
  };
}
