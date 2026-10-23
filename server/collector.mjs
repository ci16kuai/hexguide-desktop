import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requestLocalJson} from './transport.mjs';

const execute = promisify(execFile);
const PHASES = new Set(['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'InProgress', 'Reconnect', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame']);
const MAYHEM_QUEUES = new Set([2400]);
const STATS = ['abilityPower', 'attackDamage', 'attackSpeed', 'attackRange', 'armor', 'magicResist', 'critChance', 'critDamage', 'abilityHaste', 'cooldownReduction', 'maxHealth', 'currentHealth', 'healthRegenRate', 'resourceMax', 'resourceValue', 'resourceRegenRate', 'lifeSteal', 'spellVamp', 'moveSpeed', 'armorPenetrationFlat', 'armorPenetrationPercent', 'magicPenetrationFlat', 'magicPenetrationPercent'];
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const cleanText = value => typeof value === 'string' ? value.slice(0, 160) : '';
const normalized = value => cleanText(value).normalize('NFKC').toLowerCase().replace(/[\s'’._-]/g, '');

export function buildChampionIndex(champions = [], officialChampions = []) {
  const names = new Map();
  const numbers = new Map();
  for (const champion of [...officialChampions, ...champions]) {
    if (!champion.id) continue;
    for (const name of [champion.id, champion.name, champion.title, champion.enName, ...(champion.aliases || [])]) {
      if (name) names.set(normalized(name), champion.id);
    }
    if (numeric(champion.key) || /^\d+$/.test(String(champion.key || ''))) numbers.set(Number(champion.key), champion.id);
  }
  return {names, numbers};
}

function riotId(player) {
  if (typeof player?.riotId === 'string') return player.riotId.trim().toLowerCase();
  const gameName = player?.riotIdGameName || player?.riotId?.gameName;
  const tagLine = player?.riotIdTagLine || player?.riotId?.tagLine;
  return gameName && tagLine ? `${gameName}#${tagLine}`.trim().toLowerCase() : '';
}

export function findOwnPlayer(data) {
  const active = data?.activePlayer;
  const players = Array.isArray(data?.allPlayers) ? data.allPlayers : [];
  if (!active) return null;
  const id = riotId(active);
  if (id) {
    const matches = players.filter(player => riotId(player) === id);
    if (matches.length === 1) return matches[0];
  }
  const name = cleanText(active.summonerName).trim();
  if (!name) return null;
  const matches = players.filter(player => cleanText(player.summonerName).trim() === name);
  return matches.length === 1 ? matches[0] : null;
}

function championFromPlayer(player, index) {
  const raw = cleanText(player?.rawChampionName).replace(/^game_character_displayname_/i, '');
  return index.names.get(normalized(raw)) || index.names.get(normalized(player?.championName)) || null;
}

export function emptySnapshot(now = new Date()) {
  return {
    connection: {status: 'waiting', message: '等待英雄联盟客户端或对局；本机尚未读取到游戏数据。'},
    phase: 'None', gameId: null, championId: null, championSource: null,
    level: null, gameTime: null, stats: {}, items: [],
    augments: {status: 'unavailable', ids: []},
    observedAt: now.toISOString(), mode: {queueId: null, isMayhem: false, known: false},
  };
}

function knownAugments(active, own, augmentIndex) {
  // Runes are intentionally not a fallback. A missing augment field is unknown,
  // not evidence that the player has selected zero augments.
  const source = Array.isArray(own?.augments) ? own.augments : Array.isArray(active?.augments) ? active.augments : null;
  if (!source?.length) return {status: 'unavailable', ids: []};
  const ids = source.map(value => {
    const key = typeof value === 'object' && value ? value.id ?? value.augmentId ?? value.name : value;
    return augmentIndex.get(String(key));
  });
  if (ids.some(id => !id)) return {status: 'unavailable', ids: []};
  return {status: 'detected', ids: [...new Set(ids)]};
}

export function snapshotFromLive(data, {index, augmentIndex = new Map(), lcu = null, now = new Date()} = {}) {
  const result = emptySnapshot(now);
  if (lcu) Object.assign(result, lcu);
  const own = findOwnPlayer(data);
  if (!own) {
    result.connection = {status: 'error', message: '游戏接口已响应，但暂时无法确认当前玩家；未使用其他玩家的数据。'};
    return result;
  }
  const championId = championFromPlayer(own, index);
  result.connection = {status: 'connected', message: championId ? '已读取本局英雄、等级、装备和属性。海克斯可由你手动确认。' : '已连接游戏；当前英雄尚未匹配到资料库。'};
  result.phase = 'InProgress';
  result.championId = championId;
  result.championSource = championId ? 'live-client' : null;
  result.level = numeric(data.activePlayer.level) ? data.activePlayer.level : numeric(own.level) ? own.level : null;
  result.gameTime = numeric(data.gameData?.gameTime) ? data.gameData.gameTime : null;
  result.stats = Object.fromEntries(STATS.filter(key => numeric(data.activePlayer.championStats?.[key])).map(key => [key, data.activePlayer.championStats[key]]));
  if (typeof data.activePlayer.championStats?.resourceType === 'string') result.stats.resourceType = data.activePlayer.championStats.resourceType.slice(0, 40);
  result.items = (Array.isArray(own.items) ? own.items : []).filter(item => numeric(item.itemID) && item.itemID > 0).map(item => ({id: item.itemID, name: cleanText(item.displayName || item.rawDisplayName), count: numeric(item.count) ? Math.max(1, Math.min(99, item.count)) : 1}));
  result.augments = knownAugments(data.activePlayer, own, augmentIndex);
  return result;
}

export function parseLockfile(contents) {
  const fields = String(contents).trim().split(':');
  if (fields.length !== 5 || !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[2]) || !fields[3] || fields[4] !== 'https') return null;
  const port = Number(fields[2]);
  if (port < 1 || port > 65535) return null;
  return {port, authorization: `Basic ${Buffer.from(`riot:${fields[3]}`).toString('base64')}`};
}

export async function discoverLcu({read = readFile, platform = process.platform, leagueDirectory = process.env.HEXGUIDE_LEAGUE_DIR, processDirectory} = {}) {
  const directories = [leagueDirectory, 'E:\\Riot Games\\LOL\\League of Legends', 'C:\\Riot Games\\League of Legends', 'D:\\Riot Games\\League of Legends', 'E:\\Riot Games\\League of Legends'].filter(Boolean);
  if (platform === 'win32') {
    try {
      let discovered;
      if (processDirectory) discovered = await processDirectory();
      else {
        const {stdout} = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-Process -Name LeagueClientUx,LeagueClient -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique"], {windowsHide: true, timeout: 2000, maxBuffer: 8192});
        discovered = stdout.split(/\r?\n/).filter(Boolean).map(file => path.win32.dirname(file));
      }
      directories.unshift(...(Array.isArray(discovered) ? discovered : []).slice(0, 6));
    } catch { /* Client is closed, which is a normal waiting state. */ }
  }
  for (const directory of [...new Set(directories)]) {
    try {
      const parsed = parseLockfile(await read(path.join(directory, 'lockfile'), 'utf8'));
      if (parsed) return parsed;
    } catch { /* Never log lockfile paths, contents, or authentication material. */ }
  }
  return null;
}

export class LiveCollector {
  constructor({champions = [], officialChampions = [], augments = [], ca, request = requestLocalJson, discover = discoverLcu, now = () => new Date(), interval = 2000, idleInterval = 5000, maxBackoff = 15000} = {}) {
    this.index = buildChampionIndex(champions, officialChampions);
    this.augmentIndex = new Map();
    for (const augment of augments.filter(a => a.availability === 'current' && a.recommendable !== false && !a.isInternalTemplate)) {
      for (const key of [augment.id, augment.sourceGameId, augment.gameDataId]) if (key != null) this.augmentIndex.set(String(key), augment.id);
    }
    Object.assign(this, {ca, request, discover, now, interval, idleInterval, maxBackoff});
    this.snapshot = emptySnapshot(now());
    this.stopped = true;
    this.failures = 0;
    this.lastDiscovery = 0;
    this.lcu = null;
  }

  getSnapshot() { return structuredClone(this.snapshot); }

  async readLcu() {
    if (!this.lcu || this.now().getTime() - this.lastDiscovery > 15000) {
      this.lastDiscovery = this.now().getTime();
      this.lcu = await this.discover();
    }
    if (!this.lcu) return null;
    const options = {authorization: this.lcu.authorization, insecureLcu: true};
    const read = endpoint => this.request(`https://127.0.0.1:${this.lcu.port}${endpoint}`, options);
    try {
      const rawPhase = await read('/lol-gameflow/v1/gameflow-phase');
      const phase = PHASES.has(rawPhase) ? rawPhase : 'None';
      const base = {phase, gameId: null, mode: {queueId: null, isMayhem: false, known: false}};
      try {
        const session = await read('/lol-gameflow/v1/session');
        const queueId = session?.gameData?.queue?.id ?? session?.gameData?.queueId;
        if (numeric(queueId)) base.mode = {queueId, isMayhem: MAYHEM_QUEUES.has(queueId), known: true};
        if ((phase === 'InProgress' || phase === 'Reconnect') && (numeric(session?.gameData?.gameId) || typeof session?.gameData?.gameId === 'string')) base.gameId = String(session.gameData.gameId).slice(0, 40);
      } catch { /* Queue metadata can be unavailable between gameflow phases. */ }
      if (phase === 'ChampSelect') {
        const select = await read('/lol-champ-select/v1/session');
        const own = (Array.isArray(select?.myTeam) ? select.myTeam : []).find(player => player.cellId === select.localPlayerCellId);
        const championId = this.index.numbers.get(own?.championId);
        if (championId) Object.assign(base, {championId, championSource: 'champ-select'});
      }
      return base;
    } catch {
      this.lcu = null;
      return null;
    }
  }

  async pollOnce() {
    const lcu = await this.readLcu();
    const shouldReadGame = !lcu || ['InProgress', 'Reconnect'].includes(lcu.phase);
    if (shouldReadGame) {
      try {
        const data = await this.request('https://127.0.0.1:2999/liveclientdata/allgamedata', {ca: this.ca});
        this.snapshot = snapshotFromLive(data, {index: this.index, augmentIndex: this.augmentIndex, lcu, now: this.now()});
        this.failures = this.snapshot.connection.status === 'connected' ? 0 : this.failures + 1;
        return this.getSnapshot();
      } catch { /* A game may be starting or ending; do not expose TLS/secret details. */ }
    }
    this.snapshot = {...emptySnapshot(this.now()), ...(lcu || {})};
    if (lcu) this.snapshot.connection = {status: 'connected', message: lcu.phase === 'ChampSelect' ? '已连接选人界面；选择英雄后会自动更新。' : lcu.phase === 'InProgress' ? '客户端显示正在游戏，等待本局数据接口响应。' : '已连接英雄联盟客户端，等待进入选人或对局。'};
    this.failures++;
    return this.getSnapshot();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      try { await this.pollOnce(); }
      catch { this.snapshot = emptySnapshot(this.now()); this.failures++; }
      if (this.stopped) return;
      const live = this.snapshot.connection.status === 'connected' && this.snapshot.phase === 'InProgress';
      const delay = live ? this.interval : Math.min(this.maxBackoff, this.idleInterval * Math.max(1, Math.min(3, this.failures)));
      this.timer = setTimeout(tick, delay);
      this.timer.unref?.();
    };
    void tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
