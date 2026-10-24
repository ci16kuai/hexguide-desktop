import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requestLocalJson} from './transport.mjs';

const execute = promisify(execFile);
const PHASES = new Set(['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'GameStart', 'InProgress', 'Reconnect', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame']);
const GAME_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);
const MAYHEM_QUEUES = new Set([2400, 3270]);
const TEAMS = new Set(['ORDER', 'CHAOS']);
const STATS = ['abilityPower', 'attackDamage', 'attackSpeed', 'attackRange', 'armor', 'magicResist', 'critChance', 'critDamage', 'abilityHaste', 'cooldownReduction', 'maxHealth', 'currentHealth', 'healthRegenRate', 'resourceMax', 'resourceValue', 'resourceRegenRate', 'lifeSteal', 'spellVamp', 'moveSpeed', 'armorPenetrationFlat', 'armorPenetrationPercent', 'magicPenetrationFlat', 'magicPenetrationPercent'];
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const cleanText = value => typeof value === 'string' ? value.slice(0, 160) : '';
const normalized = value => cleanText(value).normalize('NFKC').toLowerCase().replace(/[\s'’._-]/g, '');

export function detectGameMode(gameData) {
  const rawQueueId = gameData?.queue?.id ?? gameData?.queueId;
  const queueId = numeric(rawQueueId) ? rawQueueId : null;
  // KIWI is Riot's explicit mode identifier for Mayhem, including custom
  // matches. Map 12, ordinary ARAM and localized display names are not proof.
  const explicitMayhem = gameData?.queue?.gameMode === 'KIWI' || gameData?.gameMode === 'KIWI';
  return {queueId, isMayhem:MAYHEM_QUEUES.has(queueId) || explicitMayhem, known:queueId !== null || explicitMayhem};
}

export function buildChampionIndex(champions = [], officialChampions = []) {
  const names = new Map();
  const numbers = new Map();
  const labels = new Map();
  for (const champion of [...officialChampions, ...champions]) {
    if (!champion.id) continue;
    labels.set(champion.id, cleanText(champion.name || champion.title || champion.id));
    for (const name of [champion.id, champion.name, champion.title, champion.enName, ...(champion.aliases || [])]) {
      if (name) names.set(normalized(name), champion.id);
    }
    if (numeric(champion.key) || /^\d+$/.test(String(champion.key || ''))) numbers.set(Number(champion.key), champion.id);
  }
  return {names, numbers, labels};
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

function publicItems(player) {
  return (Array.isArray(player?.items) ? player.items : [])
    .filter(item => Number.isSafeInteger(item?.itemID) && item.itemID > 0)
    .map(item => ({id:item.itemID, name:cleanText(item.displayName || item.rawDisplayName), count:numeric(item.count) ? Math.max(1, Math.min(99, Math.floor(item.count))) : 1}));
}

function unavailableTeams(now) {
  return {status:'unavailable', ownTeam:null, allies:[], enemies:[], observedAt:now.toISOString()};
}

function teamsFromPlayers(players, own, index, now) {
  const unavailable = unavailableTeams(now);
  // A missing team must never make another player an assumed opponent.
  if (!TEAMS.has(own?.team) || !Array.isArray(players) || !players.length || players.some(player => !TEAMS.has(player?.team))) return unavailable;
  const enemyTeam = own.team === 'ORDER' ? 'CHAOS' : 'ORDER';
  if (!players.some(player => player.team === enemyTeam)) return unavailable;
  const roster = team => players.filter(player => player.team === team).map(player => {
    const championId = championFromPlayer(player, index);
    return {championId, championName:championId ? index.labels?.get(championId) || championId : '未知英雄', level:numeric(player.level) && player.level >= 1 && player.level <= 30 ? player.level : null, items:publicItems(player)};
  });
  return {status:'detected', ownTeam:own.team, allies:roster(own.team), enemies:roster(enemyTeam), observedAt:now.toISOString()};
}

function publicGameId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) && !/^0+$/.test(value) ? value : null;
}

function summonerId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^\d{1,20}$/.test(value) && !/^0+$/.test(value) ? value.replace(/^0+/, '') : null;
}

function playerIdentity(player) {
  return {puuid:typeof player?.puuid === 'string' && player.puuid.length > 0 && player.puuid.length <= 160 ? player.puuid : null, summonerId:summonerId(player?.summonerId)};
}

function samePlayer(player, identity) {
  const candidate = playerIdentity(player);
  // Either stable identifier may be absent on a loading roster, but a known
  // conflict must never be overruled by the other field or a champion match.
  if (candidate.puuid && identity.puuid && candidate.puuid !== identity.puuid) return false;
  if (candidate.summonerId && identity.summonerId && candidate.summonerId !== identity.summonerId) return false;
  return Boolean(candidate.puuid && identity.puuid && candidate.puuid === identity.puuid || candidate.summonerId && identity.summonerId && candidate.summonerId === identity.summonerId);
}

function loadingRoster(gameData, currentSummoner, index, now) {
  const unavailable = unavailableTeams(now);
  const teamOne = gameData?.teamOne;
  const teamTwo = gameData?.teamTwo;
  if (!Array.isArray(teamOne) || !Array.isArray(teamTwo) || !teamOne.length || !teamTwo.length) return {teams:unavailable};
  const identity = playerIdentity(currentSummoner);
  const local = [...teamOne.map(player => ({player, team:'ORDER'})), ...teamTwo.map(player => ({player, team:'CHAOS'}))].filter(({player}) => samePlayer(player, identity));
  if (local.length !== 1) return {teams:unavailable};
  const selections = Array.isArray(gameData.playerChampionSelections) ? gameData.playerChampionSelections : [];
  const championFromRoster = player => {
    if (Number.isSafeInteger(player?.championId) && player.championId > 0) return index.numbers.get(player.championId) || null;
    const matches = selections.filter(selection => samePlayer(selection, playerIdentity(player)));
    return matches.length === 1 ? index.numbers.get(matches[0].championId) || null : null;
  };
  const roster = players => players.map(player => {
    const championId = championFromRoster(player);
    return {championId, championName:championId ? index.labels?.get(championId) || championId : '未知英雄', level:null, items:[]};
  });
  const ownTeam = local[0].team;
  return {
    championId:championFromRoster(local[0].player),
    teams:{status:'detected', source:'loading-roster', ownTeam, allies:roster(ownTeam === 'ORDER' ? teamOne : teamTwo), enemies:roster(ownTeam === 'ORDER' ? teamTwo : teamOne), observedAt:now.toISOString()},
  };
}

export function emptySnapshot(now = new Date()) {
  return {
    connection: {status: 'waiting', message: '等待英雄联盟客户端或对局；本机尚未读取到游戏数据。'},
    phase: 'None', stage:'waiting', gameId: null, championId: null, championSource: null,
    level: null, gameTime: null, currentGold:null, stats: {}, items: [],
    augments: {status: 'unavailable', ids: []},
    teams:unavailableTeams(now),
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
  // LCU queue metadata can disappear between phases. Only an explicit live
  // KIWI mode fills that gap; ordinary live ARAM leaves the mode unknown and
  // cannot override an already known LCU queue.
  if (!result.mode?.known) {
    const liveMode = detectGameMode(data?.gameData);
    if (liveMode.isMayhem) result.mode = liveMode;
  }
  const own = findOwnPlayer(data);
  if (!own) {
    result.connection = {status: 'error', message: '游戏接口已响应，但暂时无法确认当前玩家；未使用其他玩家的数据。'};
    return result;
  }
  const championId = championFromPlayer(own, index);
  result.connection = {status: 'connected', message: championId ? '已读取本局英雄、等级、装备和属性；等待游戏中的海克斯三选一卡片。' : '已连接游戏；当前英雄尚未匹配到资料库。'};
  result.phase = 'InProgress';
  result.stage = 'live';
  result.championId = championId;
  result.championSource = championId ? 'live-client' : null;
  result.level = numeric(data.activePlayer.level) ? data.activePlayer.level : numeric(own.level) ? own.level : null;
  result.gameTime = numeric(data.gameData?.gameTime) ? data.gameData.gameTime : null;
  result.currentGold = numeric(data.activePlayer.currentGold) && data.activePlayer.currentGold >= 0 ? data.activePlayer.currentGold : null;
  result.stats = Object.fromEntries(STATS.filter(key => numeric(data.activePlayer.championStats?.[key])).map(key => [key, data.activePlayer.championStats[key]]));
  if (typeof data.activePlayer.championStats?.resourceType === 'string') result.stats.resourceType = data.activePlayer.championStats.resourceType.slice(0, 40);
  result.items = publicItems(own);
  result.augments = knownAugments(data.activePlayer, own, augmentIndex);
  result.teams = teamsFromPlayers(data.allPlayers, own, index, now);
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
    this.lastLiveGameId = null;
    this.hasSeenLive = false;
    this.lastLcuPhase = null;
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
      const phaseKnown = PHASES.has(rawPhase);
      const phase = phaseKnown ? rawPhase : 'None';
      const enteredGameStart = phase === 'GameStart' && this.lastLcuPhase !== 'GameStart';
      if (phaseKnown) this.lastLcuPhase = phase;
      const base = {phase, stage:['GameStart','InProgress'].includes(phase) ? 'loading' : phase === 'ChampSelect' ? 'champ-select' : 'waiting', gameId: null, mode: {queueId: null, isMayhem: false, known: false}};
      let session;
      try {
        session = await read('/lol-gameflow/v1/session');
        base.mode = detectGameMode(session?.gameData);
        if (GAME_PHASES.has(phase)) base.gameId = publicGameId(session?.gameData?.gameId);
      } catch { /* Queue metadata can be unavailable between gameflow phases. */ }
      const changedGame = this.lastLiveGameId && base.gameId && base.gameId !== this.lastLiveGameId;
      if ((phaseKnown && !GAME_PHASES.has(phase)) || enteredGameStart || changedGame) {
        this.lastLiveGameId = null;
        this.hasSeenLive = false;
      }
      // Live data can become available before LCU supplies a game ID. Bind the
      // first later ID to that observed match instead of reopening its presets.
      if (this.hasSeenLive) {
        if (!this.lastLiveGameId && base.gameId) this.lastLiveGameId = base.gameId;
        base.stage = 'waiting';
      }
      if (phase === 'ChampSelect') {
        const select = await read('/lol-champ-select/v1/session');
        const own = (Array.isArray(select?.myTeam) ? select.myTeam : []).find(player => player.cellId === select.localPlayerCellId);
        const championId = this.index.numbers.get(own?.championId);
        if (championId) Object.assign(base, {championId, championSource: 'champ-select'});
      }
      // Enemy champions are public once loading begins. Never inspect or cache
      // these rosters during champion select, and never retain player identity.
      if (base.stage === 'loading' && base.gameId && Array.isArray(session?.gameData?.teamOne) && Array.isArray(session?.gameData?.teamTwo)) {
        try {
          const currentSummoner = await read('/lol-summoner/v1/current-summoner');
          const roster = loadingRoster(session.gameData, currentSummoner, this.index, this.now());
          base.teams = roster.teams;
          if (roster.championId) Object.assign(base, {championId:roster.championId, championSource:'loading-screen'});
        } catch { /* An unknown local side must stay unknown, never be guessed. */ }
      }
      return base;
    } catch {
      this.lcu = null;
      return null;
    }
  }

  async pollOnce() {
    const lcu = await this.readLcu();
    const shouldReadGame = !lcu || GAME_PHASES.has(lcu.phase);
    if (shouldReadGame) {
      try {
        const data = await this.request('https://127.0.0.1:2999/liveclientdata/allgamedata', {ca: this.ca});
        const snapshot = snapshotFromLive(data, {index: this.index, augmentIndex: this.augmentIndex, lcu, now: this.now()});
        // The live endpoint can return HTTP 200 before activePlayer is ready.
        // That partial response must not displace a verified loading roster.
        // It can also be ready while the game still shows its loading screen.
        // A strictly zero clock preserves only the verified roster, never the
        // pre-start inventory, levels or stats, until this match begins ticking.
        const loadingBeforeClockStart = !this.hasSeenLive && lcu?.stage === 'loading' && lcu.championSource === 'loading-screen' && lcu.championId && lcu.teams?.status === 'detected' && numeric(data?.gameData?.gameTime) && data.gameData.gameTime === 0;
        if (!loadingBeforeClockStart && (snapshot.connection.status === 'connected' || lcu?.stage !== 'loading' || lcu.teams?.status !== 'detected')) {
          this.snapshot = snapshot;
          if (snapshot.connection.status === 'connected' && numeric(snapshot.gameTime) && snapshot.gameTime > 0) {
            this.hasSeenLive = true;
            if (snapshot.gameId) this.lastLiveGameId = snapshot.gameId;
          }
          this.failures = snapshot.connection.status === 'connected' ? 0 : this.failures + 1;
          return this.getSnapshot();
        }
      } catch { /* A game may be starting or ending; do not expose TLS/secret details. */ }
    }
    this.snapshot = {...emptySnapshot(this.now()), ...(lcu || {})};
    if (lcu) this.snapshot.connection = {status: 'connected', message: lcu.phase === 'ChampSelect' ? '已连接选人界面；选择英雄后会自动更新。' : GAME_PHASES.has(lcu.phase) ? lcu.stage === 'waiting' ? '已连接本局，等待实时数据接口恢复。' : lcu.teams?.status === 'detected' ? '已读取加载页面的英雄与双方阵容，可提前查看本局推荐；实时装备将在进入游戏后更新。' : '已进入加载或对局阶段，等待确认本局英雄和双方阵容。' : '已连接英雄联盟客户端，等待进入选人或对局。'};
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
      const live = this.snapshot.connection.status === 'connected' && GAME_PHASES.has(this.snapshot.phase);
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
