import {readFile, mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {enrichData, recommend} from '../dist/engine.js';
import {buildLivePlan} from '../dist/adaptive.js';
import {SelectionObserver, SelectionValidationError, SelectionConflictError, createOfferToken, sanitizeSelectionCapture} from './selection.mjs';
import {OCR_SCAN_CODES, sanitizeScanCode} from './scan-diagnostics.mjs';

const ROUTES = new Set(['auto', 'attack', 'spell', 'tank', 'support', 'crit']);
const END_PHASES = new Set(['ChampSelect', 'Lobby', 'Matchmaking', 'ReadyCheck', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame']);
const eligible = augment => augment.availability === 'current' && augment.recommendable !== false && !augment.retiredPatch && !augment.isInternalTemplate;
const text = (value, limit = 220) => typeof value === 'string' ? value.slice(0, limit) : '';
const gameId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const METADATA_STATUSES = new Set(['accepted','missing','shape-invalid','title-outside-region','title-incomplete']);
const diagnosticAge = (time, now) => Number.isSafeInteger(time) && time >= 0 ? Math.min(60000, Math.max(0, Math.floor(now - time))) : null;

export class SessionValidationError extends Error {}
export class SessionConflictError extends Error {}

// Only machine-readable diagnostics may leave the OCR wrapper. Never retain
// raw screen text, player names, paths or frame IDs in the sidebar model.
const OCR_CODES = new Set([...OCR_SCAN_CODES, 'scan-loop-failed']);
function publicOcrDetails(raw) {
  const details = {};
  if (OCR_CODES.has(raw?.code)) details.code = raw.code;
  const diagnostics = {};
  for (const key of ['width', 'height', 'lineCount', 'passCount', 'titleRegionCount', 'exactTitleCount', 'layoutCount', 'passesCompleted', 'passesFailed']) {
    if (Number.isSafeInteger(raw?.diagnostics?.[key]) && raw.diagnostics[key] >= 0 && raw.diagnostics[key] <= 100_000) diagnostics[key] = raw.diagnostics[key];
  }
  if (Number.isFinite(raw?.diagnostics?.elapsedMs) && raw.diagnostics.elapsedMs >= 0 && raw.diagnostics.elapsedMs <= 100_000) diagnostics.elapsedMs = raw.diagnostics.elapsedMs;
  if (typeof raw?.diagnostics?.budgetReached === 'boolean') diagnostics.budgetReached = raw.diagnostics.budgetReached;
  if (Object.keys(diagnostics).length) details.diagnostics = diagnostics;
  return details;
}

/** Confirmed choices and public game observations, shared by both app windows. */
export class BackgroundSidebar {
  constructor({collector, scanner, data = {}, itemsCatalog = {}, dataDirectory, appearance, now = () => Date.now(), scanInterval = 2500, offerLifetime = 60000} = {}) {
    if (!collector?.getSnapshot) throw new TypeError('A collector is required.');
    Object.assign(this, {collector, scanner, itemsCatalog, dataDirectory, appearance, now, scanInterval, offerLifetime});
    this.champions = new Map((data.champions || []).map(champion => [champion.id, champion]));
    this.augments = new Map(enrichData({augments:(data.augments || []).filter(eligible)}).augments.map(augment => [augment.id, augment]));
    this.session = {owned:[], route:'auto', gameId:null, revision:0};
    this.ocr = {enabled:true, status:'waiting', message:'自动识别已开启；游戏在前台并出现三选一卡片时检查。', observedAt:null};
    this.offers = [];
    this.offerToken = null;
    this.consumedOfferKey = null;
    this.selectionObserver = new SelectionObserver({now});
    this.selectionAttempt = {metadataStatus:'not-scanned', scanCode:'not-scanned', capturedAt:null, completedAt:null};
    this.offerTime = 0;
    this.lastScan = -Infinity;
    this.generation = 0;
    this.gameEpoch = 0;
    this.persistTail = Promise.resolve();
    this.preferencesTail = Promise.resolve();
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
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDirectory, 'recognition.json'), 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved) && Object.keys(saved).length === 1 && typeof saved.enabled === 'boolean') {
        this.ocr.enabled = saved.enabled;
        this.ocr.status = saved.enabled ? 'waiting' : 'disabled';
        this.ocr.message = saved.enabled ? '自动识别已开启；等待本局海克斯三选一卡片。' : '自动识别已暂停；可从托盘或我的这一局恢复。';
      }
    } catch { /* Recognition defaults apply when preferences are missing or corrupt. */ }
    return this;
  }

  validateSession(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['owned', 'route', 'expectedRevision', 'expectedGameEpoch', 'expectedGameId'].includes(key)) || !Array.isArray(value.owned) || value.owned.length > 12 || !ROUTES.has(value.route)) throw new SessionValidationError('Invalid session.');
    if (value.owned.some(id => typeof id !== 'string' || !this.augments.has(id)) || new Set(value.owned).size !== value.owned.length) throw new SessionValidationError('Unknown or duplicate augment.');
    for (const key of ['expectedRevision', 'expectedGameEpoch']) if (key in value && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new SessionValidationError('Invalid session guard.');
    if ('expectedGameId' in value && value.expectedGameId !== null && gameId(value.expectedGameId) !== value.expectedGameId) throw new SessionValidationError('Invalid game guard.');
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

  persistRecognition() {
    if (!this.dataDirectory) return Promise.resolve();
    const payload = JSON.stringify({enabled:this.ocr.enabled}, null, 2) + '\n';
    this.preferencesTail = this.preferencesTail.catch(() => {}).then(async () => {
      await mkdir(this.dataDirectory, {recursive:true});
      const file = path.join(this.dataDirectory, 'recognition.json');
      const temporary = file + '.tmp';
      await writeFile(temporary, payload, {encoding:'utf8', mode:0o600});
      await rename(temporary, file);
    });
    this.preferencesTail.catch(() => {});
    return this.preferencesTail;
  }

  clearGame() {
    this.session = {owned:[], route:'auto', gameId:null, revision:this.session.revision + 1};
    this.offers = [];
    this.offerToken = null;
    this.consumedOfferKey = null;
    this.selectionObserver.invalidate();
    this.offerTime = 0;
    this.generation++;
    this.gameEpoch++;
    this.ocr.status = this.ocr.enabled ? 'waiting' : 'disabled';
    this.ocr.message = this.ocr.enabled ? '等待本局海克斯三选一卡片。' : '后台识别已关闭。';
    this.ocr.observedAt = null;
    delete this.ocr.code;
    delete this.ocr.diagnostics;
  }

  observe() {
    const live = this.collector.getSnapshot();
    const currentId = gameId(live.gameId);
    const inGame = ['GameStart', 'InProgress', 'Reconnect'].includes(live.phase);
    const last = this.previous;
    const changedGame = currentId && this.session.gameId && currentId !== this.session.gameId;
    const leftGame = (last?.inGame || this.session.gameId) && END_PHASES.has(live.phase);
    const timeReset = live.phase === 'InProgress' && last?.inGame && finite(live.gameTime) && live.gameTime > 0 && finite(last.time) && live.gameTime + 30 < last.time;
    // Even an empty previous session may have an OCR capture still in flight.
    const loadingStarted = live.stage === 'loading' && last?.stage !== 'loading';
    let changed = false;
    const boundary = Boolean(changedGame || leftGame || timeReset || loadingStarted);
    if (boundary) { this.clearGame(); changed = true; }
    if (inGame && currentId && this.session.gameId !== currentId) {
      this.session.gameId = currentId;
      this.session.revision++;
      changed = true;
    }
    // A transient API disconnection must not look like a new game or erase clock history.
    if (inGame || END_PHASES.has(live.phase)) this.previous = {inGame, stage:live.stage, time:finite(live.gameTime) && (live.gameTime > 0 || !finite(last?.time) || boundary) ? live.gameTime : inGame && !boundary ? last?.time ?? null : null};
    if (changed) void this.persist();
    if (live.phase !== 'InProgress' || live.stage === 'loading' || live.mode?.known && !live.mode.isMayhem) this.selectionObserver.invalidate();
    if (this.offers.length && this.now() - this.offerTime >= this.offerLifetime) {
      this.offers = [];
      this.offerToken = null;
      this.selectionObserver.invalidate();
      this.ocr.status = this.ocr.enabled ? 'waiting' : 'disabled';
      this.ocr.message = '上一轮识别已过期，等待当前三选一卡片；已确认海克斯仍保留。';
    }
    return live;
  }

  getSession() { this.observe(); return {...structuredClone(this.session), gameEpoch:this.gameEpoch}; }

  selectionContext() { return {gameId:this.session.gameId, gameEpoch:this.gameEpoch, revision:this.session.revision}; }
  selectionEligible(live) { return this.ocr.enabled && live.phase === 'InProgress' && live.stage !== 'loading' && !(live.mode?.known && !live.mode.isMayhem); }
  getSelectionObservation() { const live = this.observe(); return this.selectionObserver.get(this.selectionContext(), this.selectionEligible(live)); }

  recordSelectionAttempt(raw, complete, live, contextCurrent = true, rejectionCode) {
    const capture = sanitizeSelectionCapture(raw?.selectionCapture);
    let scanCode = sanitizeScanCode(rejectionCode ?? raw?.code, complete ? 'title-layout-confirmed' : 'ocr-unavailable');
    let metadataStatus = METADATA_STATUSES.has(raw?.selectionMetadataStatus) ? raw.selectionMetadataStatus
      : !complete ? 'title-incomplete' : raw?.selectionCapture == null ? 'missing' : capture ? 'accepted' : 'shape-invalid';
    if (!contextCurrent) { metadataStatus = 'context-ineligible'; scanCode = sanitizeScanCode(rejectionCode, 'scan-context-ineligible'); }
    else if (metadataStatus === 'accepted') {
      if (!complete || !this.selectionEligible(live)) { metadataStatus = 'context-ineligible'; if (!rejectionCode) scanCode = 'scan-context-ineligible'; }
      else if (!capture) metadataStatus = 'shape-invalid';
      else if (capture.capturedAt <= this.selectionObserver.invalidatedAt || capture.capturedAt > this.now() + 1000
        || this.now() - capture.capturedAt > this.selectionObserver.maxAge) { metadataStatus = 'stale'; scanCode = 'scan-capture-stale'; }
    }
    this.selectionAttempt = {metadataStatus, scanCode, capturedAt:capture?.capturedAt ?? null, completedAt:this.now()};
  }

  selectionDiagnostics(selection) {
    return {metadataStatus:this.selectionAttempt.metadataStatus,
      scanCode:this.selectionAttempt.scanCode,
      captureAgeMs:diagnosticAge(this.selectionAttempt.capturedAt, this.now()),
      backendArmed:selection.status === 'armed',
      lastScanAgeMs:diagnosticAge(this.selectionAttempt.completedAt, this.now())};
  }

  async setSession(value) {
    const selected = this.validateSession(value);
    const live = this.observe();
    if ('expectedRevision' in value && value.expectedRevision !== this.session.revision
      || 'expectedGameEpoch' in value && value.expectedGameEpoch !== this.gameEpoch
      || 'expectedGameId' in value && value.expectedGameId !== this.session.gameId) throw new SessionConflictError('The assistant state has changed.');
    // A late main-window write must not carry a previous game's choices into
    // the opening preset. Return authoritative state so clients can reconcile.
    if (live.stage === 'loading') return this.getSession();
    if (JSON.stringify(selected.owned) !== JSON.stringify(this.session.owned) || selected.route !== this.session.route) {
      if (JSON.stringify(selected.owned) !== JSON.stringify(this.session.owned) && this.offers.length === 3) this.consumedOfferKey = JSON.stringify(this.offers.map(offer => offer.id));
      this.generation++;
      this.selectionObserver.invalidate();
      this.session = {...this.session, ...selected, revision:this.session.revision + 1};
      // Once the player confirms a card, that previous round is no longer offered.
      if (this.offers.some(offer => selected.owned.includes(offer.id))) {
        this.offers = []; this.offerTime = 0;
        this.offerToken = null;
        this.ocr.status = this.ocr.enabled ? 'waiting' : 'disabled';
        this.ocr.message = '已确认选择；等待下一轮三选一卡片。';
        delete this.ocr.code;
        delete this.ocr.diagnostics;
      }
      await this.persist();
    }
    return this.getSession();
  }

  async confirmOffer(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![3,4].includes(Object.keys(value).length) || Object.keys(value).some(key => !['id', 'gameId', 'revision', 'offerToken'].includes(key)) || typeof value.id !== 'string' || !this.augments.has(value.id) || !(value.gameId === null || gameId(value.gameId) === value.gameId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || 'offerToken' in value && (typeof value.offerToken !== 'string' || !/^[a-f0-9]{32}$/.test(value.offerToken))) throw new SessionValidationError('Invalid confirmation.');
    const live = this.observe();
    // Check and mutate synchronously: a roll, another confirmation or a game
    // boundary cannot slip between a UI GET and this authoritative update.
    if (live.phase !== 'InProgress' || live.stage === 'loading' || value.gameId !== this.session.gameId || value.revision !== this.session.revision || 'offerToken' in value && value.offerToken !== this.offerToken || !this.offers.some(offer => offer.id === value.id) || this.session.owned.includes(value.id) || this.session.owned.length >= 12) throw new SessionConflictError('The current offered choices have changed.');
    return this.commitChoice(value.id, 'manual');
  }

  async observeSelectionEvidence(value) {
    const live = this.observe();
    let observation;
    try { observation = this.selectionObserver.consume(value, this.selectionContext(), this.selectionEligible(live)); }
    catch (error) {
      if (error instanceof SelectionValidationError) throw new SessionValidationError(error.message);
      if (error instanceof SelectionConflictError) throw new SessionConflictError(error.message);
      throw error;
    }
    if (!this.offers.some(offer => offer.id === observation.id) || this.session.owned.includes(observation.id) || this.session.owned.length >= 12) throw new SessionConflictError('The current offered choices have changed.');
    return this.commitChoice(observation.id, observation.provider);
  }

  async commitChoice(id, provider) {
    const epoch = this.gameEpoch;
    this.generation++;
    this.selectionObserver.invalidate();
    this.consumedOfferKey = JSON.stringify(this.offers.map(offer => offer.id));
    this.session = {...this.session, owned:[...this.session.owned, id], revision:this.session.revision + 1};
    this.offers = [];
    this.offerToken = null;
    this.offerTime = 0;
    this.ocr.status = this.ocr.enabled ? 'waiting' : 'disabled';
    this.ocr.message = provider === 'screen' ? '实验性屏幕确认已记录；可手动纠正，等待下一轮三选一卡片。' : '已确认选择；等待下一轮三选一卡片。';
    delete this.ocr.code;
    delete this.ocr.diagnostics;
    await this.persist();
    const model = this.getModel();
    if (epoch !== this.gameEpoch || model.phase !== 'InProgress' || !model.owned.some(augment => augment.id === id)) throw new SessionConflictError('The game changed while saving the choice.');
    return model;
  }

  setOcr(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') throw new SessionValidationError('An enabled boolean is required.');
    this.ocr.enabled = value.enabled;
    delete this.ocr.code;
    delete this.ocr.diagnostics;
    if (!value.enabled) { this.generation++; this.selectionObserver.invalidate(); this.ocr.status = 'disabled'; this.ocr.message = '自动识别已暂停；已确认海克斯仍保留。'; }
    else if (!this.offers.length) { this.ocr.status = 'waiting'; this.ocr.message = '后台识别已开启；游戏在前台并出现三选一卡片时检查。'; }
    void this.persistRecognition();
    return this.getModel();
  }

  async scan() {
    // Both manual requests and the background timer await the same capture.
    if (this.pending) return this.pending;
    const live = this.observe();
    if (live.phase !== 'InProgress' || live.stage === 'loading' || live.mode?.known && !live.mode.isMayhem) {
      this.recordSelectionAttempt(null, false, live, false);
      return {status:'waiting', message:'等待进入海克斯大乱斗对局后识别。', proposals:[]};
    }
    const generation = this.generation;
    this.lastScan = this.now();
    this.pending = (async () => {
      let raw;
      try { raw = this.scanner ? await this.scanner() : null; }
      catch { raw = {code:'scan-execution-failed'}; }
      const current = this.observe();
      if (generation !== this.generation || current.phase !== 'InProgress' || current.stage === 'loading') {
        this.recordSelectionAttempt(raw, false, current, false, 'scan-context-changed');
        this.selectionObserver.invalidate(); return {status:'waiting', message:'本局已变化，请等待新一轮三选一卡片。', proposals:[]};
      }
      const status = ['recognized', 'waiting', 'unavailable'].includes(raw?.status) ? raw.status : 'unavailable';
      const proposals = (Array.isArray(raw?.proposals) ? raw.proposals : []).filter(proposal => this.augments.has(proposal?.id)).map(proposal => ({id:proposal.id, name:this.augments.get(proposal.id).name, confidence:'exact'}));
      const triplet = status === 'recognized' && proposals.length === 3 && new Set(proposals.map(proposal => proposal.id)).size === 3;
      const alreadyOwned = proposals.some(proposal => this.session.owned.includes(proposal.id));
      const consumed = JSON.stringify(proposals.map(proposal => proposal.id)) === this.consumedOfferKey;
      const complete = triplet && !alreadyOwned && !consumed;
      const rejectionCode = status !== 'recognized' ? undefined : !triplet ? 'scan-proposals-incomplete' : alreadyOwned ? 'scan-offer-owned' : consumed ? 'scan-offer-consumed' : undefined;
      const scannedAt = new Date(this.now()).toISOString();
      this.recordSelectionAttempt(raw, complete, current, true, rejectionCode);
      if (complete) {
        const changedOffers = JSON.stringify(this.offers.map(offer => offer.id)) !== JSON.stringify(proposals.map(offer => offer.id));
        if (changedOffers || !this.offerToken) this.offerToken = createOfferToken();
        this.offers = proposals;
        if (this.selectionEligible(current)) this.selectionObserver.arm({...this.selectionContext(), offerToken:this.offerToken, ids:proposals.map(offer => offer.id), capture:raw.selectionCapture});
        else this.selectionObserver.invalidate();
        this.offerTime = this.now();
        delete this.ocr.code;
        delete this.ocr.diagnostics;
        Object.assign(this.ocr, {status:'recognized', message:'已识别三个候选；请核对后自行选择，确认已选海克斯后推荐会更新。', observedAt:scannedAt}, publicOcrDetails(raw));
      } else {
        this.selectionObserver.invalidate();
        if (!this.offers.length) {
        delete this.ocr.code;
        delete this.ocr.diagnostics;
        Object.assign(this.ocr, {status, message:text(raw?.message) || '尚未确认到三个海克斯标题，可在主窗口手动选择。', observedAt:scannedAt}, publicOcrDetails(raw));
        }
      }
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
      const definition = this.augments.get(offer.id);
      return {id:offer.id, name:offer.name, icon:text(definition.icon, 400), rarity:text(definition.rarity, 40), rank:rank.get(offer.id), reason:result.reasons[0] || '结合英雄机制与已确认海克斯比较；以游戏内实际效果为准。', cautions:result.cautions.slice(0, 2)};
    });
    const plan = buildLivePlan({champion, owned, route:this.session.route, live, augments:[...this.augments.values()], champions:[...this.champions.values()], itemsCatalog:this.itemsCatalog, now:this.now()});
    const selection = this.selectionObserver.get(this.selectionContext(), this.selectionEligible(live));
    return {
      version:'1.10.2', connection:live.connection, phase:live.phase, stage:live.stage || 'waiting', championSource:live.championSource || null, gameId:this.session.gameId, sessionRevision:this.session.revision,
      gameEpoch:this.gameEpoch, selection, selectionDiagnostics:this.selectionDiagnostics(selection),
      mode:live.mode || {queueId:null, isMayhem:false, known:false},
      champion:champion ? {id:champion.id, name:champion.name, title:champion.title} : null,
      level:live.level ?? null, gameTime:live.gameTime ?? null, currentGold:live.currentGold ?? null, items:live.items || [],
      teams:live.teams || {status:'unavailable', ownTeam:null, allies:[], enemies:[], observedAt:live.observedAt || null},
      owned:owned.map(augment => ({id:augment.id, name:augment.name, icon:text(augment.icon, 400), rarity:text(augment.rarity, 40), summary:text(String(augment.summary || augment.description || '').replace(/<[^>]*>/g, ''), 300)})), offers,
      ocr:{...this.ocr, proposals:this.offers.map(offer => ({...offer}))}, route:this.session.route, updatedAt:live.observedAt || new Date(this.now()).toISOString(),
      plan,
      ...(this.appearance ? {appearance:this.appearance.get()} : {}),
    };
  }

  async pollOnce() {
    const live = this.observe();
    if (this.ocr.enabled && live.phase === 'InProgress' && live.stage !== 'loading' && this.now() - this.lastScan >= this.scanInterval) await this.scan();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      try { await this.pollOnce(); }
      catch {
        this.selectionObserver.invalidate();
        this.recordSelectionAttempt({code:'scan-loop-failed'}, false, null);
        if (!this.offers.length) Object.assign(this.ocr, {status:'unavailable', code:'scan-loop-failed', message:'本次自动识别暂未完成，稍后会自动重试。', observedAt:new Date(this.now()).toISOString()});
      } finally {
        if (!this.stopped) { this.timer = setTimeout(tick, 1000); this.timer.unref?.(); }
      }
    };
    void tick();
  }

  async stop() { this.stopped = true; clearTimeout(this.timer); await Promise.all([this.persistTail.catch(() => {}), this.preferencesTail.catch(() => {})]); }
}
