import {readFile, mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {enrichData, recommend} from '../dist/engine.js';
import {buildLivePlan} from '../dist/adaptive.js';

const ROUTES = new Set(['auto', 'attack', 'spell', 'tank', 'support', 'crit']);
const END_PHASES = new Set(['ChampSelect', 'Lobby', 'Matchmaking', 'ReadyCheck', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame']);
const eligible = augment => augment.availability === 'current' && augment.recommendable !== false && !augment.retiredPatch && !augment.isInternalTemplate;
const text = (value, limit = 220) => typeof value === 'string' ? value.slice(0, limit) : '';
const gameId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);

export class SessionValidationError extends Error {}

/** Own-player state and read-only recommendations, shared by both app windows. */
export class BackgroundSidebar {
  constructor({collector, scanner, data = {}, itemsCatalog = {}, dataDirectory, appearance, now = () => Date.now(), scanInterval = 7000, offerLifetime = 60000} = {}) {
    if (!collector?.getSnapshot) throw new TypeError('A collector is required.');
    Object.assign(this, {collector, scanner, itemsCatalog, dataDirectory, appearance, now, scanInterval, offerLifetime});
    this.champions = new Map((data.champions || []).map(champion => [champion.id, champion]));
    this.augments = new Map(enrichData({augments:(data.augments || []).filter(eligible)}).augments.map(augment => [augment.id, augment]));
    this.session = {owned:[], route:'auto', gameId:null, revision:0};
    this.ocr = {enabled:false, status:'disabled', message:'后台识别已关闭；可从托盘或实战助手开启。', observedAt:null};
    this.offers = [];
    this.offerTime = 0;
    this.lastScan = -Infinity;
    this.generation = 0;
    this.persistTail = Promise.resolve();
    this.stopped = true;
  }

  async load() {
    if (!this.dataDirectory) return this;
    try {
      const file = path.join(this.dataDirectory, 'session.json');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      const selected = this.validateSession({owned:saved.owned, route:saved.route});
      this.session = {...selected, gameId:gameId(saved.gameId), revision:Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0};
    } catch { /* Missing or corrupt assistant state is safe to start afresh. */ }
    return this;
  }

  validateSession(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['owned', 'route'].includes(key)) || !Array.isArray(value.owned) || value.owned.length > 12 || !ROUTES.has(value.route)) throw new SessionValidationError('Invalid session.');
    if (value.owned.some(id => typeof id !== 'string' || !this.augments.has(id)) || new Set(value.owned).size !== value.owned.length) throw new SessionValidationError('Unknown or duplicate augment.');
    return {owned:[...value.owned], route:value.route};
  }

  persist() {
    if (!this.dataDirectory) return Promise.resolve();
    // Serialize writes so a slower previous write cannot restore old selections.
    const payload = JSON.stringify(this.session, null, 2) + '\n';
    this.persistTail = this.persistTail.catch(() => {}).then(async () => {
      await mkdir(this.dataDirectory, {recursive:true});
      const file = path.join(this.dataDirectory, 'session.json');
      const temporary = file + '.tmp';
      await writeFile(temporary, payload, {encoding:'utf8', mode:0o600});
      await rename(temporary, file);
    });
    // Automatic game boundary updates remain usable if the folder becomes read-only.
    this.persistTail.catch(() => {});
    return this.persistTail;
  }

  clearGame() {
    this.session = {owned:[], route:'auto', gameId:null, revision:this.session.revision + 1};
    this.offers = [];
    this.offerTime = 0;
    this.generation++;
    this.ocr.status = this.ocr.enabled ? 'waiting' : 'disabled';
    this.ocr.message = this.ocr.enabled ? '等待本局海克斯三选一卡片。' : '后台识别已关闭。';
    this.ocr.observedAt = null;
  }

  observe() {
    const live = this.collector.getSnapshot();
    const currentId = gameId(live.gameId);
    const inGame = ['InProgress', 'Reconnect'].includes(live.phase);
    const last = this.previous;
    const changedGame = currentId && this.session.gameId && currentId !== this.session.gameId;
    const leftGame = (last?.inGame || this.session.gameId) && END_PHASES.has(live.phase);
    const timeReset = live.phase === 'InProgress' && last?.inGame && finite(live.gameTime) && finite(last.time) && live.gameTime + 30 < last.time;
    let changed = false;
    const boundary = Boolean(changedGame || leftGame || timeReset);
    if (boundary) { this.clearGame(); changed = true; }
    if (inGame && currentId && this.session.gameId !== currentId) {
      this.session.gameId = currentId;
      this.session.revision++;
      changed = true;
    }
    // A transient API disconnection must not look like a new game or erase clock history.
    if (inGame || END_PHASES.has(live.phase)) this.previous = {inGame, time:finite(live.gameTime) ? live.gameTime : inGame && !boundary ? last?.time ?? null : null};
    if (changed) void this.persist();
    if (this.offers.length && this.now() - this.offerTime >= this.offerLifetime) {
      this.offers = [];
      this.ocr.status = this.ocr.enabled ? 'waiting' : 'disabled';
      this.ocr.message = '上一轮识别已过期，等待当前三选一卡片；已确认海克斯仍保留。';
    }
    return live;
  }

  getSession() { this.observe(); return structuredClone(this.session); }

  async setSession(value) {
    const selected = this.validateSession(value);
    this.observe();
    if (JSON.stringify(selected.owned) !== JSON.stringify(this.session.owned) || selected.route !== this.session.route) {
      if (JSON.stringify(selected.owned) !== JSON.stringify(this.session.owned)) this.generation++;
      this.session = {...this.session, ...selected, revision:this.session.revision + 1};
      // Once the player confirms a card, that previous round is no longer offered.
      if (this.offers.some(offer => selected.owned.includes(offer.id))) { this.offers = []; this.offerTime = 0; }
      await this.persist();
    }
    return this.getSession();
  }

  setOcr(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') throw new SessionValidationError('An enabled boolean is required.');
    this.ocr.enabled = value.enabled;
    if (!value.enabled) { this.ocr.status = 'disabled'; this.ocr.message = '后台识别已关闭；已确认海克斯仍保留。'; }
    else if (!this.offers.length) { this.ocr.status = 'waiting'; this.ocr.message = '后台识别已开启；游戏在前台并出现三选一卡片时检查。'; }
    return this.getModel();
  }

  async scan() {
    // Both manual requests and the background timer await the same capture.
    if (this.pending) return this.pending;
    const live = this.observe();
    if (live.phase !== 'InProgress' || live.mode?.known && !live.mode.isMayhem) return {status:'waiting', message:'等待进入海克斯大乱斗对局后识别。', proposals:[]};
    const generation = this.generation;
    this.lastScan = this.now();
    this.pending = (async () => {
      let raw;
      try { raw = this.scanner ? await this.scanner() : null; }
      catch { /* Local capture failure contains no public diagnostic details. */ }
      this.observe();
      if (generation !== this.generation) return {status:'waiting', message:'本局已变化，请等待新一轮三选一卡片。', proposals:[]};
      const status = ['recognized', 'waiting', 'unavailable'].includes(raw?.status) ? raw.status : 'unavailable';
      const proposals = (Array.isArray(raw?.proposals) ? raw.proposals : []).filter(proposal => this.augments.has(proposal?.id)).map(proposal => ({id:proposal.id, name:this.augments.get(proposal.id).name, confidence:'exact'}));
      const complete = status === 'recognized' && proposals.length === 3 && new Set(proposals.map(proposal => proposal.id)).size === 3 && proposals.every(proposal => !this.session.owned.includes(proposal.id));
      const scannedAt = new Date(this.now()).toISOString();
      if (complete) {
        this.offers = proposals;
        this.offerTime = this.now();
        Object.assign(this.ocr, {status:'recognized', message:'已识别三个候选；请核对后自行选择，确认已选海克斯后推荐会更新。', observedAt:scannedAt});
      } else if (!this.offers.length) Object.assign(this.ocr, {status, message:text(raw?.message) || '尚未确认到三个海克斯标题，可在主窗口手动选择。', observedAt:scannedAt});
      // Empty battle frames do not replace the most recent valid three-card frame.
      return {status:complete ? 'recognized' : status === 'recognized' ? 'unavailable' : status, message:text(raw?.message) || this.ocr.message, proposals:complete ? proposals : [], observedAt:scannedAt};
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  getModel() {
    const live = this.observe();
    const champion = this.champions.get(live.championId) || null;
    const owned = this.session.owned.map(id => this.augments.get(id)).filter(Boolean);
    const ranked = this.offers.map(offer => ({offer, result:recommend(this.augments.get(offer.id), champion, owned, this.session.route)})).sort((a, b) => b.result.score - a.result.score);
    const rank = new Map(ranked.map((entry, index) => [entry.offer.id, index + 1]));
    const offers = this.offers.map(offer => {
      const result = ranked.find(entry => entry.offer.id === offer.id).result;
      return {id:offer.id, name:offer.name, rank:rank.get(offer.id), reason:result.reasons[0] || '结合英雄机制与已确认海克斯比较；以游戏内实际效果为准。', cautions:result.cautions.slice(0, 2)};
    });
    const plan = buildLivePlan({champion, owned, route:this.session.route, live, augments:[...this.augments.values()], itemsCatalog:this.itemsCatalog});
    return {
      version:'1.3.0', connection:live.connection, phase:live.phase,
      champion:champion ? {id:champion.id, name:champion.name, title:champion.title} : null,
      level:live.level ?? null, gameTime:live.gameTime ?? null, items:live.items || [],
      owned:owned.map(augment => ({id:augment.id, name:augment.name})), offers,
      ocr:{...this.ocr, proposals:this.offers.map(offer => ({...offer}))}, route:this.session.route, updatedAt:live.observedAt || new Date(this.now()).toISOString(),
      plan:{title:plan.title, summary:plan.summary, choices:plan.choices},
      ...(this.appearance ? {appearance:this.appearance.get()} : {}),
    };
  }

  async pollOnce() {
    const live = this.observe();
    if (this.ocr.enabled && live.phase === 'InProgress' && this.now() - this.lastScan >= this.scanInterval) await this.scan();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      await this.pollOnce();
      if (!this.stopped) { this.timer = setTimeout(tick, 1000); this.timer.unref?.(); }
    };
    void tick();
  }

  async stop() { this.stopped = true; clearTimeout(this.timer); await this.persistTail.catch(() => {}); }
}
