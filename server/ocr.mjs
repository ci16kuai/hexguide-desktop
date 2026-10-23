import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const result = (status, message, proposals = []) => ({status, message, proposals});

export function matchOcrProposals(raw, augments) {
  if (raw?.status !== 'recognized') return result(raw?.status === 'waiting' ? 'waiting' : 'unavailable', typeof raw?.message === 'string' ? raw.message.slice(0, 200) : '本次没有读到清楚的海克斯名称，可手动选择。');
  const eligible = augments.filter(augment => augment.availability === 'current' && augment.recommendable !== false && !augment.retiredPatch && !augment.isInternalTemplate);
  const dictionary = new Map();
  for (const augment of eligible) {
    for (const alias of [augment.name, augment.enName, ...(augment.aliases || [])]) {
      const name = normalize(alias);
      if (name.length < 3) continue;
      const entries = dictionary.get(name) || [];
      if (!entries.some(entry => entry.id === augment.id)) entries.push(augment);
      dictionary.set(name, entries);
    }
  }
  const source = Array.isArray(raw.lines) && raw.lines.length ? raw.lines : String(raw.text || '').split(/\r?\n/).map((text, index) => ({text, x:index, y:0}));
  const matches = new Map();
  for (const [position, line] of source.slice(0, 200).entries()) {
    const text = normalize(String(line.text || '').slice(0, 500));
    if (!text) continue;
    const candidates = new Map();
    for (const [alias, entries] of dictionary) {
      if (text.includes(alias)) for (const augment of entries) candidates.set(augment.id, augment);
    }
    if (candidates.size !== 1) continue;
    const augment = [...candidates.values()][0];
    if (!matches.has(augment.id)) matches.set(augment.id, {id:augment.id, name:augment.name, confidence:'exact', x:Number.isFinite(line.x) ? line.x : position});
  }
  if (!matches.size) return result('unavailable', '没有与 4.0 资料库唯一匹配的名称，可手动选择。');
  if (matches.size > 3) return result('unavailable', '读到了超过三个名称，无法确认本轮选项，请手动选择。');
  const proposals = [...matches.values()].sort((a,b) => a.x - b.x).map(({x,...proposal}) => proposal);
  return result('recognized', '识别到候选名称，请确认与游戏中的三个选项一致。', proposals);
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
