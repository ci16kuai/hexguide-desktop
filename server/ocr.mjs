import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {sanitizeSelectionCapture} from './selection.mjs';

const execute = promisify(execFile);
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const result = (status, message, proposals = [], details = {}) => ({status, message, proposals, ...details});
const nativeStages = new Set(['initializing','native-window','foreground-check','winrt-runtime','ocr-language','ocr-engine','window-bounds','capture','resize','encode','stream-write','decode','software-bitmap','recognize','result']);
const nativeCodes = new Set(['ok','game-not-foreground','foreground-changed','ocr-language-missing','ocr-engine-unavailable','window-bounds-unavailable','window-size-unsupported','ocr-passes-incomplete',...[...nativeStages].map(stage => `ocr-${stage}-failed`)]);
function nativeDetails(raw) {
  if (!raw?.code && !raw?.stage) return {};
  const diagnostics = {};
  const limits = {width:8192,height:8192,dpi:960,dpiAwareness:2,ocrMaxDimension:8192,passesCompleted:20,passesFailed:20,elapsedMs:60000,lineCount:10000};
  for (const [key, max] of Object.entries(limits)) if (Number.isFinite(raw.diagnostics?.[key]) && raw.diagnostics[key] >= 0 && raw.diagnostics[key] <= max) diagnostics[key] = raw.diagnostics[key];
  if (typeof raw.diagnostics?.budgetReached === 'boolean') diagnostics.budgetReached = raw.diagnostics.budgetReached;
  return {code:nativeCodes.has(raw.code) ? raw.code : 'ocr-unavailable',stage:nativeStages.has(raw.stage) ? raw.stage : 'native',diagnostics};
}

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

const inside = (box, bounds) => validBox(box) && box.x >= bounds.x - 2 && box.y >= bounds.y - 2 && box.x + box.width <= bounds.x + bounds.width + 2 && box.y + box.height <= bounds.y + bounds.height + 2;
function titleRegion(line, width, height) {
  const crop = line?.crop;
  if (line?.region !== 'card-title' || !Number.isInteger(line.column) || line.column < 0 || line.column > 2 || !validBox(crop)) return null;
  if (!inside(crop, {x:0,y:0,width,height}) || crop.width > width * .34 || crop.height > height * .2 || crop.y < height * .2 || crop.y + crop.height > height * .6 || !inside(line, crop)) return null;
  const center = (crop.x + crop.width / 2) / width;
  if (center < [.08,.3,.54][line.column] || center > [.46,.7,.92][line.column]) return null;
  return crop;
}

// Only explicitly cropped title regions may reconstruct OCR lines. Full-window
// text still uses readLine's exact full coverage rule; it never extracts names
// embedded in chat, player names or descriptions.
function readTitleRegion(lines, lookup) {
  const pieces = [];
  for (const line of lines) {
    const words = Array.isArray(line.words) ? line.words.slice(0, 60) : [];
    const completeWords = words.length && words.every(word => inside(word, line.crop)) && normalize(words.map(word => word.text).join(' ')) === normalize(line.text);
    for (const piece of completeWords ? words : [line]) {
      if (!normalize(piece.text) || !validBox(piece)) continue;
      if (!pieces.some(other => signature(other.text) === signature(piece.text) && Math.abs(other.x - piece.x) < 2 && Math.abs(other.y - piece.y) < 2)) pieces.push({...piece,text:String(piece.text).slice(0, 500)});
    }
  }
  if (pieces.length > 120) return [];
  const rows = [];
  for (const piece of pieces.sort((a,b) => a.y + a.height / 2 - b.y - b.height / 2)) {
    const center = piece.y + piece.height / 2;
    const row = rows.find(item => Math.abs(center - item.center) <= Math.max(3, Math.min(item.height, piece.height) * .55));
    if (row) {
      row.pieces.push(piece);
      row.center = row.pieces.reduce((sum, item) => sum + item.y + item.height / 2, 0) / row.pieces.length;
      row.height = Math.min(row.height, piece.height);
    } else rows.push({pieces:[piece],center,height:piece.height});
  }
  const completeRows = rows.map(row => {
    const ordered = row.pieces.sort((a,b) => a.x - b.x);
    // A visual row must be covered in full, with plausible inter-word spacing.
    // A dictionary word in a longer description cannot be selected by itself.
    if (ordered.some((piece, index) => index && (piece.x - ordered[index - 1].x - ordered[index - 1].width > Math.max(piece.height, ordered[index - 1].height) * 2 || ordered[index - 1].x + ordered[index - 1].width - piece.x > Math.min(piece.width, ordered[index - 1].width) * .3))) return {...boundingBox(ordered),invalid:true};
    return {text:ordered.map(piece => piece.text).join(' '),...boundingBox(ordered)};
  }).sort((a,b) => a.y - b.y);
  const matches = [];
  for (let index = 0; index < completeRows.length; index++) {
    const row = completeRows[index];
    if (row.invalid) continue;
    const augment = lookup(row.text);
    if (augment) matches.push({augment,...row,rows:[index]});
    const next = completeRows[index + 1];
    if (!next || next.invalid) continue;
    const gap = next.y - row.y - row.height;
    const widthRatio = Math.max(row.width, next.width) / Math.min(row.width, next.width);
    const horizontallyAligned = Math.abs(row.x + row.width / 2 - next.x - next.width / 2) <= Math.max(row.width, next.width) * .55;
    if (gap < -2 || gap > Math.max(row.height, next.height) * .65 || widthRatio > 8 || !horizontallyAligned || Math.max(row.height, next.height) / Math.min(row.height, next.height) > 1.5) continue;
    const wrapped = lookup(row.text + next.text);
    if (wrapped) matches.push({augment:wrapped,...boundingBox([row,next]),lineHeight:Math.max(row.height,next.height),titleY:row.y + row.height / 2,rows:[index,index+1]});
  }
  // Prefer an exact complete two-line title over a catalog word that is only
  // the second half of that same title (e.g. 灵魂 / 虹吸). Ambiguous complete
  // reconstructions remain separate and fail the final unique-layout check.
  return matches.filter(match => !matches.some(other => other !== match && other.rows.length > match.rows.length && match.rows.every(row => other.rows.includes(row))));
}

function cardLayout(candidates, width, height) {
  const ordered = [...candidates].sort((a,b) => (a.x + a.width / 2) - (b.x + b.width / 2));
  if (new Set(ordered.map(item => item.augment.id)).size !== 3) return false;
  if (ordered.some(item => Number.isInteger(item.column)) && !ordered.every((item, index) => item.column === index)) return false;
  const centers = ordered.map(item => ({x:item.x + item.width / 2, y:item.titleY ?? item.y + item.height / 2}));
  if (ordered.some(item => (item.lineHeight ?? item.height) < Math.max(12, height * .012) || item.height > height * .08 || item.width > width * .32 || item.x < 0 || item.x + item.width > width || item.y < height * .12 || item.y + item.height > height * .72)) return false;
  const gaps = [centers[1].x - centers[0].x, centers[2].x - centers[1].x];
  if (gaps.some(gap => gap < width * .12 || gap > width * .4) || Math.max(...gaps) / Math.min(...gaps) > 1.8) return false;
  if (centers[0].x < width * .08 || centers[0].x > width * .46 || centers[1].x < width * .3 || centers[1].x > width * .7 || centers[2].x < width * .54 || centers[2].x > width * .92) return false;
  const heights = ordered.map(item => item.lineHeight ?? item.height);
  if (Math.max(...heights) / Math.min(...heights) > 1.8) return false;
  return Math.max(...centers.map(item => item.y)) - Math.min(...centers.map(item => item.y)) <= Math.max(12, height * .018, Math.max(...heights) * .7);
}

export function matchOcrProposals(raw, augments) {
  if (raw?.status !== 'recognized') return result(raw?.status === 'waiting' ? 'waiting' : 'unavailable', typeof raw?.message === 'string' ? raw.message.slice(0, 200) : '本次没有读到清楚的海克斯名称，可手动选择。', [], nativeDetails(raw));
  const eligible = augments.filter(augment => augment.availability === 'current' && augment.recommendable !== false && !augment.retiredPatch && !augment.isInternalTemplate);
  const width = raw.capture?.width ?? raw.diagnostics?.width, height = raw.capture?.height ?? raw.diagnostics?.height;
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 300);
  const diagnostics = {lineCount:lines.length,passCount:0,titleRegionCount:0,exactTitleCount:0,layoutCount:0};
  const native = nativeDetails(raw);
  if (native.code) {
    diagnostics.nativeCode = native.code;
    diagnostics.nativeStage = native.stage;
    for (const key of ['passesCompleted','passesFailed','elapsedMs','budgetReached']) if (key in native.diagnostics) diagnostics[key] = native.diagnostics[key];
  }
  if (Number.isFinite(width) && width >= 0 && width <= 8192) diagnostics.width = width;
  if (Number.isFinite(height) && height >= 0 && height <= 8192) diagnostics.height = height;
  const details = code => ({code,stage:'matching',diagnostics});
  const incomplete = code => result('unavailable', '未确认到同一排的三个海克斯卡片标题。请在三选一界面重试，或手动填入；战斗画面中的名称不会作为本轮选项。', [], details(code));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 640 || height < 360 || width > 8192 || height > 8192) return incomplete('capture-size-invalid');
  const lookup = createDictionary(eligible);
  const groups = new Map();
  const regions = new Map();
  const add = (group, matches) => {
    const entries = groups.get(group) || [];
    for (const match of matches) if (!entries.some(item => item.augment.id === match.augment.id && Math.abs(item.x - match.x) < 3 && Math.abs(item.y - match.y) < 3)) entries.push(match);
    groups.set(group, entries);
  };
  for (const line of lines) {
    // Never combine observations from separate frames or recognition passes.
    const group = JSON.stringify([line.frameId ?? raw.frameId ?? '', line.pass ?? raw.pass ?? 'full-window']);
    if (line.region === 'card-title') {
      if (!titleRegion(line, width, height)) continue;
      const key = JSON.stringify([group,line.column,line.crop]);
      const region = regions.get(key) || {group,column:line.column,lines:[]};
      region.lines.push(line);
      regions.set(key,region);
      continue;
    }
    add(group, readLine(line, lookup));
  }
  for (const {group,column,lines:regionLines} of regions.values()) add(group, readTitleRegion(regionLines,lookup).map(match => ({...match,column})));
  diagnostics.passCount = groups.size;
  diagnostics.titleRegionCount = regions.size;
  diagnostics.exactTitleCount = [...groups.values()].reduce((sum, entries) => sum + entries.length, 0);
  diagnostics.titleGeometry = [...groups.values()].flat().slice(0, 12).map(({x,y,width,height,column}) => ({x,y,width,height,...(Number.isInteger(column) ? {column} : {})}));
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
  diagnostics.layoutCount = layouts.size;
  if (layouts.size !== 1) return incomplete(layouts.size > 1 ? 'title-layout-ambiguous' : !lines.length ? 'ocr-no-text' : !diagnostics.exactTitleCount ? 'title-name-unmatched' : 'title-layout-incomplete');
  const matched = [...layouts.values()][0];
  const proposals = matched.map(({augment}) => ({id:augment.id, name:augment.name, confidence:'exact'}));
  const selectionCapture = sanitizeSelectionCapture(raw.selectionCapture, {width, height});
  // A recognized name must belong to the same physical card the click watcher
  // samples. Different layouts still display candidates but require confirmation.
  const captureAligned = selectionCapture && matched.every((title, column) => {
    const region = selectionCapture.regions[column];
    const centerX = title.x + title.width / 2, centerY = title.y + title.height / 2;
    return centerX >= region.x && centerX < region.x + region.width
      && centerY >= region.y && centerY < region.y + region.height;
  });
  return result('recognized', '识别到同排的三个候选标题，请逐一核对后再带入推荐；这不会自动记录为已选海克斯。', proposals,
    {...details('title-layout-confirmed'), ...(captureAligned ? {selectionCapture} : {})});
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
