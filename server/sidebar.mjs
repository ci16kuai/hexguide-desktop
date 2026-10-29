import {readFile, mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {enrichData, recommend} from '../dist/engine.js';
import {buildLivePlan} from '../dist/adaptive.js';
import {selectBuildEvidence} from '../dist/build-evidence.js';
import {rankAugmentCandidates} from '../dist/recommendation-policy.js';
import {SelectionObserver, SelectionValidationError, SelectionConflictError, createOfferToken, sanitizeSelectionCapture} from './selection.mjs';
import {OCR_SCAN_CODES, sanitizeScanCode} from './scan-diagnostics.mjs';
import {OcrScanSchedule} from './ocr-schedule.mjs';
import {OcrScheduleDiagnostics} from './ocr-schedule-diagnostics.mjs';
import {ScreenLifeSource, ScreenLifeValidationError, ScreenLifeConflictError} from './screen-life.mjs';
import {validatePanelEvidence} from './panel-selection.mjs';
import {PendingOffers} from './pending-offers.mjs';
import {observedOfferRound, sameOfferRound, validOfferRound} from './offer-round.mjs';
import {buildNextItemRecommendation, isPurchaseTarget} from './next-item.mjs';
import {ManualRecognition, MANUAL_MESSAGES} from './manual-recognition.mjs';

const ROUTES = new Set(['auto', 'attack', 'spell', 'tank', 'support', 'crit']);
const END_PHASES = new Set(['ChampSelect', 'Lobby', 'Matchmaking', 'ReadyCheck', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame']);
const eligible = augment => augment.availability === 'current' && augment.recommendable !== false && !augment.retiredPatch && !augment.isInternalTemplate;
const text = (value, limit = 220) => typeof value === 'string' ? value.slice(0, limit) : '';
const gameId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
// Persist only the confirmed IDs evaluated for a purchase target. An absent or
// corrupt legacy context is unknown, never an empty set authorizing a replan.
const purchaseAugmentIds = (value, known) => Array.isArray(value) && value.length <= 12
  && value.every(id => typeof id === 'string' && known.has(id)) && new Set(value).size === value.length
  ? [...value].sort() : null;
const METADATA_STATUSES = new Set(['accepted','missing','shape-invalid','title-outside-region','title-incomplete']);
const FOREGROUND_SCAN_FAILURES = new Set(['game-not-foreground','foreground-changed']);
const diagnosticAge = (time, now) => Number.isSafeInteger(time) && time >= 0 ? Math.min(60000, Math.max(0, Math.floor(now - time))) : null;
const sameRectangle = (left, right) => ['x','y','width','height'].every(key => left[key] === right[key]);
// Panel leases keep one validated reference across repeated OCR frames. Only
// geometry changes replace it: new pixels, frame IDs or capture times must not
// continually reset the native observer's independent-frame stability window.
const samePanelCaptureGeometry = (left, right) => ['windowHandle','originX','originY','width','height'].every(key => left[key] === right[key])
  && left.regions.every((region,index) => sameRectangle(region,right.regions[index]))
  && left.identityAnchors.cards.every((card,index) => card.anchors.length === right.identityAnchors.cards[index].anchors.length
    && card.anchors.every((anchor,position) => sameRectangle(anchor.box,right.identityAnchors.cards[index].anchors[position].box)));

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
  for (const key of ['elapsedMs', 'initializationMs', 'captureMs', 'recognitionMs', 'totalMs']) {
    if (Number.isFinite(raw?.diagnostics?.[key]) && raw.diagnostics[key] >= 0 && raw.diagnostics[key] <= 60_000) diagnostics[key] = raw.diagnostics[key];
  }
  if (typeof raw?.diagnostics?.runtimeReused === 'boolean') diagnostics.runtimeReused = raw.diagnostics.runtimeReused;
  if (typeof raw?.diagnostics?.budgetReached === 'boolean') diagnostics.budgetReached = raw.diagnostics.budgetReached;
  if (Object.keys(diagnostics).length) details.diagnostics = diagnostics;
  return details;
}

/** Confirmed choices and public game observations, shared by both app windows. */
export class BackgroundSidebar {
  constructor({collector, scanner, data = {}, itemsCatalog = {}, dataDirectory, appearance, recommendationRepository, recommendationPolicy = {}, scanPolicy = {}, panelPolicy = {}, timers = {}, now = () => Date.now()} = {}) {
    if (!collector?.getSnapshot) throw new TypeError('A collector is required.');
    Object.assign(this, {collector, scanner, itemsCatalog, dataDirectory, appearance, recommendationRepository, recommendationPolicy, panelPolicy, now});
    this.scanSchedule = new OcrScanSchedule({now, policy:scanPolicy});
    this.lifeSource = new ScreenLifeSource({now});
    this.scanDiagnostics = new OcrScheduleDiagnostics({dataDirectory, now});
    this.timers = {setTimeout:typeof timers?.setTimeout === 'function' ? timers.setTimeout : setTimeout,
      clearTimeout:typeof timers?.clearTimeout === 'function' ? timers.clearTimeout : clearTimeout};
    this.scanCount = 0;
    this.scanFailureCount = 0;
    this.lastScanDuration = null;
    this.champions = new Map((data.champions || []).map(champion => [champion.id, champion]));
    this.augments = new Map(enrichData({augments:(data.augments || []).filter(eligible)}).augments.map(augment => [augment.id, augment]));
    this.session = {owned:[], route:'auto', gameId:null, revision:0};
    this.purchaseTarget = null;
    this.snapshotBlocked = false;
    this.choiceSources = Object.create(null);
    this.panelLease = null;
    this.panelPendingId = null;
    this.observedScanLifecycle = null;
    this.captureEligible = null;
    this.captureEligibleSince = 0;
    this.candidateInvalidatedAt = -Infinity;
    this.panelStatus = {status:'waiting', reason:'waiting-offer'};
    this.ocr = {enabled:true, status:'waiting', message:'自动识别已开启；等待开局、死亡或复活后的识别窗口。', observedAt:null};
    this.manualRecognition = new ManualRecognition({now,timers:this.timers,onEnd:() => {
      if (!this.ocr.enabled) this.panelLease = null;
    }});
    this.pendingOffers = new PendingOffers();
    this.consumedOfferKey = null;
    this.selectionObserver = new SelectionObserver({now});
    this.selectionAttempt = {metadataStatus:'not-scanned', scanCode:'not-scanned', capturedAt:null, completedAt:null};
    this.generation = 0;
    this.gameEpoch = 0;
    this.persistTail = Promise.resolve();
    this.preferencesTail = Promise.resolve();
    this.stopped = true;
  }

  get offers() { return (this.pendingOffers.latest?.ids || []).map(id => ({id,name:this.augments.get(id).name,confidence:'exact'})); }
  get offerToken() { return this.pendingOffers.latest?.offerToken || null; }

  async load() {
    if (!this.dataDirectory) return this;
    try {
      const file = path.join(this.dataDirectory, 'session.json');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      const selected = this.validateSession({owned:saved.owned, route:saved.route});
      this.session = {...selected, gameId:gameId(saved.gameId), revision:Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0};
      const target = saved.purchaseTarget;
      if (this.session.gameId && target && isPurchaseTarget(target.itemId,this.champions.get(target.championId),this.itemsCatalog)) {
        const ownedAugmentIds = purchaseAugmentIds(target.ownedAugmentIds,this.augments);
        this.purchaseTarget = {championId:target.championId,itemId:target.itemId,
          ...(ownedAugmentIds ? {ownedAugmentIds} : {})};
      }
      this.snapshotBlocked = saved.selectionSources?.manualBarrier === true;
      if (this.session.gameId) this.pendingOffers.restore(saved.pendingOffers, id => this.augments.has(id), this.session.owned);
      const inferred = saved.selectionSources?.inferredChoices;
      if (Array.isArray(inferred) && inferred.length <= 12 && inferred.every(id => typeof id === 'string' && this.session.owned.includes(id))) {
        for (const id of inferred) this.choiceSources[id] = 'panel-statistical';
      }
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
    const inferredChoices = this.session.owned.filter(id => this.choiceSources[id] === 'panel-statistical');
    const payload = JSON.stringify({...this.session, ...(this.purchaseTarget ? {purchaseTarget:this.purchaseTarget} : {}), pendingOffers:this.pendingOffers.save(), selectionSources:{manualBarrier:this.snapshotBlocked,
      ...(inferredChoices.length ? {inferredChoices} : {})}}, null, 2) + '\n';
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
    this.manualRecognition.reset();
    this.lifeSource.reset();
    this.purchaseTarget = null;
    this.snapshotBlocked = false;
    this.choiceSources = Object.create(null);
    this.panelLease = null;
    this.panelPendingId = null;
    this.panelStatus = {status:'waiting', reason:'waiting-offer'};
    this.session = {owned:[], route:'auto', gameId:null, revision:this.session.revision + 1};
    this.pendingOffers.clear();
    this.consumedOfferKey = null;
    this.selectionObserver.invalidate();
    this.invalidateCandidateCapture();
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
    // A restarted collector can briefly expose the same game's loading roster
    // before its live endpoint recovers. Keep the saved purchase intent through
    // that fallback while retaining the existing recognition reset boundary.
    const recoveringTarget = loadingStarted && !changedGame && !leftGame && !timeReset && currentId && currentId === this.session.gameId
      ? this.purchaseTarget : null;
    if (boundary) { this.clearGame(); this.purchaseTarget = recoveringTarget; changed = true; }
    if (inGame && currentId && this.session.gameId !== currentId) {
      this.session.gameId = currentId;
      this.session.revision++;
      changed = true;
    }
    // Observe a new game/respawn before selected-ID confirmation from this
    // snapshot. A confirmed choice must end, rather than reopen, that window.
    const schedulingLive = this.schedulingSnapshot(live);
    this.scanSchedule.observe({live:schedulingLive, gameEpoch:this.gameEpoch});
    this.syncScanLifecycle();
    this.syncCaptureEligibility(schedulingLive);
    // Only explicit, completely mapped selected IDs from the collector qualify.
    // OCR proposals never enter this path. Empty/unreadable snapshots do not
    // erase choices, and a manual correction blocks future snapshot additions.
    const observedTime = Date.parse(live.observedAt || '');
    const selectedIds = live.augments?.ids;
    if (!this.snapshotBlocked && currentId && currentId === this.session.gameId && live.phase === 'InProgress'
      && live.stage === 'live' && live.connection?.status === 'connected' && live.mode?.known === true && live.mode.isMayhem === true
      && this.champions.has(live.championId) && live.augments?.status === 'detected'
      && Number.isFinite(observedTime) && this.now() - observedTime <= 10000 && observedTime - this.now() <= 1000
      && Array.isArray(selectedIds) && selectedIds.length > 0 && selectedIds.length <= 12
      && new Set(selectedIds).size === selectedIds.length && selectedIds.every(id => typeof id === 'string' && this.augments.has(id))
      && this.session.owned.every((id, index) => selectedIds[index] === id)) {
      for (const id of selectedIds) if (!this.session.owned.includes(id) && this.session.owned.length < 12) {
        this.recordChoice(id, 'live-client'); changed = true;
      }
    }
    // A transient API disconnection must not look like a new game or erase clock history.
    if (inGame || END_PHASES.has(live.phase)) this.previous = {inGame, stage:live.stage, time:finite(live.gameTime) && (live.gameTime > 0 || !finite(last?.time) || boundary) ? live.gameTime : inGame && !boundary ? last?.time ?? null : null};
    if (changed) void this.persist();
    if (this.recommendationRepository && inGame && currentId && live.connection?.status === 'connected'
      && live.mode?.known === true && live.mode.isMayhem === true && this.champions.has(live.championId)) {
      void this.recommendationRepository.ensure(live.championId).catch(() => {});
    }
    if (live.phase !== 'InProgress' || live.stage === 'loading' || live.mode?.known && !live.mode.isMayhem) this.selectionObserver.invalidate();
    this.manualRecognition.sync(this.manualContext(live));
    return live;
  }

  getSession() { this.observe(); return {...structuredClone(this.session), gameEpoch:this.gameEpoch}; }

  selectionContext() { return {gameId:this.session.gameId, gameEpoch:this.gameEpoch, revision:this.session.revision}; }
  syncScanLifecycle() {
    const lifecycle = this.scanSchedule.lifecycle, previous = this.observedScanLifecycle;
    this.observedScanLifecycle = lifecycle;
    if (previous === null || previous === lifecycle) return;
    // An offer/result proof belongs to one opening/respawn lifecycle. Reusing
    // the same card IDs after death still requires a new capture and token.
    this.revokeCaptureEvidence('识别周期已更新；等待当前三选一卡片。');
  }
  captureContextEligible(live) {
    if (live.phase !== 'InProgress' || live.connection?.status !== 'connected'
      || live.mode?.known && !live.mode.isMayhem
      || live.stage !== undefined && !['live','playing'].includes(live.stage)) return false;
    // Preserve legacy manual-only snapshots that predate the live-stage
    // contract. Current collector snapshots must be fresh and in order.
    if (live.stage !== 'live') return true;
    const observed = this.scanSchedule.snapshotTime(live,this.scanSchedule.time());
    return observed !== null && this.scanSchedule.lastObservedAt === observed;
  }
  syncCaptureEligibility(live) {
    const eligible = this.captureContextEligible(live), previous = this.captureEligible;
    this.captureEligible = eligible;
    if (eligible === previous) return;
    if (eligible) {
      this.captureEligibleSince = this.scanSchedule.time();
      if (this.ocr.enabled && this.offers.length) {
        this.ocr.status = 'recognized';
        this.ocr.message = '候选仍待确认；继续核对海克斯强化符文面板。';
      }
      return;
    }
    if (previous !== true) return;
    this.scanSchedule.revokeCapture();
    this.revokeCaptureEvidence('暂时无法确认游戏状态；恢复后将重新识别。');
  }
  revokeCaptureEvidence(message) {
    this.manualRecognition.cancel();
    this.invalidateCandidateCapture();
    if (this.offers.length || this.panelLease || this.selectionObserver.observation || this.selectionObserver.resultLease
      || this.selectionObserver.fxContinuation) {
      this.selectionObserver.invalidate();
    }
    this.panelLease = null;
    this.pendingOffers.revokeClickScopes();
    this.panelStatus = {status:'waiting', reason:'waiting-offer'};
    this.ocr.status = this.ocr.enabled ? this.offers.length ? 'recognized' : 'waiting' : 'disabled';
    this.ocr.message = this.ocr.enabled ? message : '自动识别已暂停；已确认海克斯仍保留。';
    delete this.ocr.code;
    delete this.ocr.diagnostics;
  }
  invalidateCandidateCapture() {
    this.candidateInvalidatedAt = Math.max(this.candidateInvalidatedAt, this.scanSchedule.time());
  }
  schedulingSnapshot(live) {
    const life = this.lifeSource.resolve(live, this.selectionContext());
    // A screen proof can arrive between collector ticks. Its own timestamp
    // advances only the scheduler, never the raw game snapshot or team data.
    const observedAt = life.source === 'screen' && life.observedAt > Date.parse(live.observedAt || '')
      ? new Date(life.observedAt).toISOString() : live.observedAt;
    return {...live, life, observedAt};
  }

  observeScreenLife(value) {
    const live = this.observe();
    let life;
    try { life = this.lifeSource.accept(value, this.selectionContext(), live); }
    catch (error) {
      if (error instanceof ScreenLifeValidationError) throw new SessionValidationError(error.message);
      if (error instanceof ScreenLifeConflictError) throw new SessionConflictError(error.message);
      throw error;
    }
    // Explicit loss of screen scope must break the old dead -> alive chain.
    // An authoritative API observation remains valid despite a screen reset.
    if (value.state === 'unknown' && life.source === 'unavailable') this.scanSchedule.forgetLife();
    return this.getModel();
  }
  selectionEligible(live) {
    return this.ocr.enabled && this.captureEligible !== false
      && !this.scanSchedule.awaitingAliveAfterDeath && this.scanSchedule.lastLife?.isDead !== true
      && live.phase === 'InProgress' && live.stage !== 'loading' && !(live.mode?.known && !live.mode.isMayhem);
  }
  panelContextEligible(live) {
    // A visible owned-result panel proves a result independently of a click
    // or life state. Keep its current game/surface fence, without inheriting
    // the pointer observer's dead/unknown-after-death restrictions. A newer
    // screen-life timestamp must not conceal a stale collector snapshot.
    return (this.ocr.enabled || this.manualRecognition.panelActive(this.manualContext(live))) && this.manualGameEligible(live);
  }
  manualGameEligible(live) {
    return this.captureEligible === true
      && live.phase === 'InProgress' && live.stage === 'live' && live.connection?.status === 'connected'
      && live.mode?.known === true && live.mode.isMayhem === true && this.champions.has(live.championId)
      && gameId(live.gameId) !== null && gameId(live.gameId) === this.session.gameId
      && this.scanSchedule.snapshotTime(live,this.scanSchedule.time()) !== null;
  }
  manualContext(live) {
    return this.manualGameEligible(live) ? {...this.selectionContext(),lifecycle:this.scanSchedule.lifecycle,
      captureRevision:this.scanSchedule.captureRevision} : null;
  }
  getSelectionObservation() { const live = this.observe(); return this.selectionObserver.get(this.selectionContext(), this.selectionEligible(live)); }

  // Recognition delivery is independent of recommendation rendering. This
  // snapshot can be polled quickly without rebuilding equipment/statistics.
  recognitionSnapshot(live) {
    const eligible = this.selectionEligible(live);
    const selection = this.selectionObserver.get(this.selectionContext(), eligible);
    const selectionResult = this.selectionObserver.getResultLease(this.selectionContext(), eligible);
    return {version:'1.17.14', recognitionAt:this.now(), updatedAt:live.observedAt || new Date(this.now()).toISOString(), connection:live.connection,
      phase:live.phase, stage:live.stage || 'waiting', gameId:this.session.gameId,
      gameEpoch:this.gameEpoch, sessionRevision:this.session.revision,
      mode:live.mode || {queueId:null,isMayhem:false,known:false},
      life:this.lifeSource.resolve(live, this.selectionContext()),
      ocr:{enabled:this.ocr.enabled}, manualRecognition:this.manualRecognition.snapshot(), selection, selectionResult,
      panelSelection:this.getPanelSelection(live), selectionDiagnostics:this.selectionDiagnostics(selection),
      screenObservationScope:{version:1,
        eligible:Boolean(eligible && this.captureEligible && live.stage === 'live'
          && live.connection?.status === 'connected' && live.mode?.known === true && live.mode.isMayhem === true
          && this.champions.has(live.championId) && this.scanSchedule.lastLife?.isDead !== true
          && (this.scanSchedule.awaitingConfirmation || this.pending || selection.status === 'armed')),
        ...this.selectionContext(), lifecycle:this.scanSchedule.lifecycle,
        captureRevision:this.scanSchedule.captureRevision,
        notBefore:Math.max(0,this.scanSchedule.lifecycleStartedAt,this.captureEligibleSince,
          Number.isFinite(this.selectionObserver.hardInvalidatedAt) ? this.selectionObserver.hardInvalidatedAt+1 : 0)}};
  }

  getRecognitionModel() { return this.recognitionSnapshot(this.observe()); }

  // Logical unanswered rounds survive death and focus loss. Each return to a
  // live capture scope creates a fresh panel token and independent-frame fence;
  // the original descriptor is an anchor, never newly captured click proof.
  getPanelSelection(live) {
    const current = this.selectionContext();
    const active = this.panelContextEligible(live);
    const candidates = this.pendingOffers.entries.filter(entry => entry.capture && entry.ids.some(id => !this.session.owned.includes(id)));
    let pending = candidates.find(entry => entry.pendingId === this.panelPendingId) || candidates[0];
    if (!active || !pending) {
      this.panelLease = null;
      return {status:'waiting', reason:!this.ocr.enabled && !this.manualRecognition.snapshot().active ? 'panel-disabled' : !active ? 'panel-context-unavailable'
        : this.pendingOffers.entries.length && !pending ? 'panel-anchor-unavailable' : 'waiting-offer'};
    }
    let lease = this.panelLease;
    // A panel with no matching candidate does not produce a native submission.
    // Give each descriptor a full capture dwell, then check another unanswered
    // round even when no proof arrived. Polls within the dwell keep one token.
    if (lease && candidates.length > 1 && this.now()-lease.evidenceNotBefore >= 4000) {
      const index = candidates.findIndex(entry => entry.pendingId === lease.pendingId);
      pending = candidates[(index+1)%candidates.length];
      lease = null;
    }
    if (!lease || lease.pendingId !== pending.pendingId || lease.lifecycle !== this.scanSchedule.lifecycle
      || lease.captureRevision !== this.scanSchedule.captureRevision
      || !samePanelCaptureGeometry(lease.capture,pending.capture)
      || !['gameId','gameEpoch','revision'].every(key => lease[key] === current[key])) {
      lease = this.panelLease = {...current,pendingId:pending.pendingId,lifecycle:this.scanSchedule.lifecycle,
        captureRevision:this.scanSchedule.captureRevision,offerToken:createOfferToken(),ids:[...pending.ids],
        offeredAt:pending.capture.capturedAt,capture:pending.capture,evidenceNotBefore:this.now()};
      this.panelStatus = {status:'watching',reason:'waiting-panel'};
      this.panelPendingId = pending.pendingId;
    }
    const icon = id => { const a = this.augments.get(id); return {id, icon:text(a?.icon, 400), rarity:text(a?.rarity, 40)}; };
    return {...current, status:'watching', reason:this.panelStatus.reason, offerToken:lease.offerToken,
      pendingId:lease.pendingId,pendingUntilConfirmed:true,evidenceNotBefore:lease.evidenceNotBefore,
      ids:[...lease.ids], offeredAt:lease.offeredAt, capture:structuredClone(lease.capture),
      offers:lease.ids.map(icon), owned:this.session.owned.map(icon)};
  }

  advancePendingPanel(lease) {
    // Rotate only after a valid independent-frame result, with enough dwell
    // for native 400ms captures. Polling alone can never reset frame stability.
    if (this.now()-lease.evidenceNotBefore < 1200) return;
    const candidates = this.pendingOffers.entries.filter(entry => entry.capture && entry.ids.some(id => !this.session.owned.includes(id)));
    if (candidates.length < 2) return;
    const index = candidates.findIndex(entry => entry.pendingId === lease.pendingId);
    this.panelPendingId = candidates[(index+1)%candidates.length].pendingId;
    this.panelLease = null;
  }

  async observePanelEvidence(value) {
    const live = this.observe(), scope = this.getPanelSelection(live), lease = this.panelLease;
    if (scope.status !== 'watching' || !lease) throw new SessionConflictError('The current panel scope has changed.');
    const champion = this.champions.get(live.championId);
    const owned = this.session.owned.map(id => this.augments.get(id)).filter(Boolean);
    const {ranked, patch} = this.rankOffers(lease.ids, champion, owned);
    const ranks = new Map(ranked.map(row => [row.offer.id,row.rank]));
    const identity = id => ({id, iconKey:this.augments.get(id)?.icon || '', kind:'augment'});
    const offers = lease.ids.map(id => ({...identity(id), recommendationRank:ranks.get(id) ?? null}));
    const result = validatePanelEvidence(value, {...this.selectionContext(), eligible:true, now:this.now(),
      offerToken:lease.offerToken, ids:lease.ids, offeredAt:lease.offeredAt,
      pendingUntilConfirmed:true,evidenceNotBefore:lease.evidenceNotBefore,championId:champion.id, patch,
      offers, owned:this.session.owned.map(identity)}, this.panelPolicy);
    this.panelStatus = {status:result.status, reason:result.reason};
    if (['panel-context-mismatch', 'panel-offer-expired', 'panel-ineligible'].includes(result.reason)) throw new SessionConflictError('The current panel scope has changed.');
    if (result.status === 'rejected') {
      if (value?.offerToken === lease.offerToken) this.manualRecognition.finish(this.manualRecognition.job,'unavailable',MANUAL_MESSAGES.rejected);
      throw new SessionValidationError('Invalid panel evidence.');
    }
    if (!result.id) { this.advancePendingPanel(lease); return this.getModel(); }
    if (this.pendingOffers.entries.filter(entry => entry.ids.includes(result.id)).length > 1) {
      this.panelStatus = {status:'pending',reason:'panel-round-ambiguous'};
      this.advancePendingPanel(lease);
      return this.getModel();
    }
    if (this.session.owned.includes(result.id) || this.session.owned.length >= 12) throw new SessionConflictError('The choice has already been recorded.');
    if (!this.panelContextEligible(live)) throw new SessionConflictError('The current panel scope has expired.');
    return this.commitChoice(result.id, result.inferred ? 'panel-statistical' : 'panel-icon',lease.pendingId);
  }

  suspendSelectionForScan(raw, live, hard = false) {
    if (FOREGROUND_SCAN_FAILURES.has(raw?.code)) this.invalidateCandidateCapture();
    if (hard || !live || !this.selectionEligible(live) || FOREGROUND_SCAN_FAILURES.has(raw?.code)) this.selectionObserver.invalidate();
    else this.selectionObserver.suspendForResultCheck(this.selectionContext(), true);
  }

  recordSelectionAttempt(raw, complete, live, contextCurrent = true, rejectionCode) {
    const capture = sanitizeSelectionCapture(raw?.selectionCapture);
    let scanCode = sanitizeScanCode(rejectionCode ?? raw?.code, complete ? 'title-layout-confirmed' : 'ocr-unavailable');
    let metadataStatus = METADATA_STATUSES.has(raw?.selectionMetadataStatus) ? raw.selectionMetadataStatus
      : !complete ? 'title-incomplete' : raw?.selectionCapture == null ? 'missing'
        : !capture ? 'shape-invalid' : capture.identityAnchors ? 'accepted' : 'missing';
    if (!contextCurrent) { metadataStatus = 'context-ineligible'; scanCode = sanitizeScanCode(rejectionCode, 'scan-context-ineligible'); }
    else if (metadataStatus === 'accepted') {
      if (!complete || !this.captureEligible) { metadataStatus = 'context-ineligible'; if (!rejectionCode) scanCode = 'scan-context-ineligible'; }
      else if (!capture) metadataStatus = 'shape-invalid';
      else if (!capture.identityAnchors) metadataStatus = 'missing';
      else if (capture.capturedAt < Math.max(this.scanSchedule.lifecycleStartedAt,this.captureEligibleSince)
        || capture.capturedAt <= this.candidateInvalidatedAt || capture.capturedAt > this.now() + 1000
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

  getOfferAttention(live) {
    const inactive = {active:false,pendingId:null,capturedAt:null,expiresAt:null};
    const capturedAt = this.selectionAttempt.capturedAt, now = this.now();
    // Display attention is independent of the alive-only click observer. A
    // validated death-screen triplet can open the sidebar, while saved pending
    // rounds and retained result-panel anchors cannot keep it open indefinitely.
    if (!this.manualGameEligible(live) || this.selectionAttempt.metadataStatus !== 'accepted'
      || !Number.isSafeInteger(capturedAt) || capturedAt < 0 || !Number.isSafeInteger(now)
      || capturedAt <= this.candidateInvalidatedAt || capturedAt > now + 1000 || now - capturedAt >= 8000) return inactive;
    const pending = this.pendingOffers.entries.find(entry => entry.capture?.capturedAt === capturedAt
      && entry.runtimeLifecycle === this.scanSchedule.lifecycle
      && entry.runtimeCaptureRevision === this.scanSchedule.captureRevision
      && entry.lastSeenOfferCycle === this.scanSchedule.offerCycle);
    if (!pending) return inactive;
    return {active:true,pendingId:pending.pendingId,capturedAt:new Date(capturedAt).toISOString(),
      expiresAt:new Date(capturedAt + 8000).toISOString()};
  }

  async setSession(value, {reset = false} = {}) {
    const selected = this.validateSession(value);
    const live = this.observe();
    if ('expectedRevision' in value && value.expectedRevision !== this.session.revision
      || 'expectedGameEpoch' in value && value.expectedGameEpoch !== this.gameEpoch
      || 'expectedGameId' in value && value.expectedGameId !== this.session.gameId) throw new SessionConflictError('The assistant state has changed.');
    // A late main-window write must not carry a previous game's choices into
    // the opening preset. Return authoritative state so clients can reconcile.
    if (live.stage === 'loading') return this.getSession();
    this.manualRecognition.cancel();
    if (reset || JSON.stringify(selected.owned) !== JSON.stringify(this.session.owned) || selected.route !== this.session.route) {
      const ownedChanged = JSON.stringify(selected.owned) !== JSON.stringify(this.session.owned);
      if (selected.owned.some(id => !this.session.owned.includes(id))) this.scanSchedule.confirmed();
      if (reset || this.session.owned.some(id => !selected.owned.includes(id))
        || selected.owned.length === this.session.owned.length && JSON.stringify(selected.owned) !== JSON.stringify(this.session.owned)) this.snapshotBlocked = true;
      if ((reset || ownedChanged) && this.offers.length === 3) this.consumedOfferKey = JSON.stringify(this.offers.map(offer => offer.id));
      this.generation++;
      this.selectionObserver.invalidate();
      this.invalidateCandidateCapture();
      this.panelLease = null;
      this.choiceSources = Object.fromEntries(Object.entries(this.choiceSources).filter(([id]) => selected.owned.includes(id)));
      this.session = {...this.session, ...selected, revision:this.session.revision + 1};
      // A full manual session edit is authoritative, including corrections to
      // order/removals that cannot be assigned to an unanswered round safely.
      if (reset || ownedChanged) {
        this.pendingOffers.clear();
        this.ocr.status = this.ocr.enabled ? 'waiting' : 'disabled';
        this.ocr.message = '已确认选择；等待下一轮三选一卡片。';
        delete this.ocr.code;
        delete this.ocr.diagnostics;
      }
      await this.persist();
    }
    return this.getSession();
  }

  async resetSession(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !Object.hasOwn(value,'gameId') || !Object.hasOwn(value,'revision')
      || !(value.gameId === null || gameId(value.gameId) === value.gameId)
      || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new SessionValidationError('Invalid reset.');
    await this.setSession({owned:[],route:'auto',expectedGameId:value.gameId,expectedRevision:value.revision},{reset:true});
    return this.getModel();
  }

  async confirmOffer(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![3,4,5].includes(Object.keys(value).length) || Object.keys(value).some(key => !['id', 'gameId', 'revision', 'offerToken', 'pendingId'].includes(key)) || typeof value.id !== 'string' || !this.augments.has(value.id) || !(value.gameId === null || gameId(value.gameId) === value.gameId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || ['offerToken','pendingId'].some(key => key in value && (typeof value[key] !== 'string' || !/^[a-f0-9]{32}$/.test(value[key])))) throw new SessionValidationError('Invalid confirmation.');
    const live = this.observe();
    const pending = 'pendingId' in value ? this.pendingOffers.find(value.pendingId) : this.pendingOffers.latest;
    // Check and mutate synchronously: a roll, another confirmation or a game
    // boundary cannot slip between a UI GET and this authoritative update.
    if (live.phase !== 'InProgress' || live.stage === 'loading' || value.gameId !== this.session.gameId || value.revision !== this.session.revision || !pending || 'offerToken' in value && value.offerToken !== pending.offerToken || !pending.ids.includes(value.id) || this.session.owned.includes(value.id) || this.session.owned.length >= 12) throw new SessionConflictError('The current offered choices have changed.');
    return this.commitChoice(value.id, 'manual',pending.pendingId);
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
    const pending = this.pendingOffers.entries.find(entry => entry.offerToken === value.offerToken);
    if (!pending?.ids.includes(observation.id) || this.session.owned.includes(observation.id) || this.session.owned.length >= 12) throw new SessionConflictError('The current offered choices have changed.');
    return this.commitChoice(observation.id, observation.provider,pending.pendingId);
  }

  async commitChoice(id, provider, pendingId) {
    const epoch = this.gameEpoch;
    const manualJob = ['panel-icon','panel-statistical'].includes(provider) ? this.manualRecognition.job : null;
    this.recordChoice(id, provider, pendingId, manualJob);
    try { await this.persist(); }
    catch (error) { this.manualRecognition.finish(manualJob,'unavailable',MANUAL_MESSAGES.saveFailed); throw error; }
    const model = this.getModel();
    if (epoch !== this.gameEpoch || model.phase !== 'InProgress' || !model.owned.some(augment => augment.id === id)) throw new SessionConflictError('The game changed while saving the choice.');
    if (manualJob && this.manualRecognition.owns(manualJob)) this.manualRecognition.finish(manualJob,'confirmed',
      provider === 'panel-statistical' ? MANUAL_MESSAGES.inferred : MANUAL_MESSAGES.confirmed);
    return {...model,manualRecognition:this.manualRecognition.snapshot()};
  }

  recordChoice(id, provider, pendingId, manualJob = null) {
    if (!manualJob) this.manualRecognition.cancel();
    const pending = pendingId ? this.pendingOffers.find(pendingId)
      : this.pendingOffers.entries.find(entry => entry.ids.includes(id));
    // A delayed answer completes only its logical choice opportunity. A death
    // and its respawn share that opportunity, while capture scopes stay separate.
    // An older round or restored catalog cannot stop a newer scan opportunity;
    // the revision below still revokes old proof without renewing its deadline.
    const newestUnanswered = pending && pending === this.pendingOffers.latest
      && pending.sequence === this.pendingOffers.nextSequence-1;
    const currentRound = observedOfferRound(this.collector.getSnapshot(),{gameId:this.session.gameId,now:this.now()});
    // The next milestone may already be available before its first OCR result.
    // Answering the old cards must not close that still-needed scan window.
    const newerMilestone = currentRound && validOfferRound(pending?.roundContext)
      && currentRound.rule === pending.roundContext.rule && currentRound.milestone > pending.roundContext.milestone;
    const currentOpportunity = newestUnanswered && !newerMilestone && (Number.isSafeInteger(pending.lastSeenOfferCycle)
      ? pending.lastSeenOfferCycle === this.scanSchedule.offerCycle
      : pending.lastSeenLifecycle === this.scanSchedule.lifecycle);
    if (!pending || currentOpportunity) this.scanSchedule.confirmed();
    this.generation++;
    this.selectionObserver.invalidate();
    this.invalidateCandidateCapture();
    this.panelLease = null;
    this.choiceSources[id] = provider;
    this.consumedOfferKey = pending ? JSON.stringify(pending.ids) : null;
    const owned = this.pendingOffers.resolve(id,pending?.pendingId,this.session.owned);
    this.session = {...this.session, owned, revision:this.session.revision + 1};
    if (manualJob) this.manualRecognition.rebindAcceptedPanel(manualJob,{...this.selectionContext(),
      lifecycle:this.scanSchedule.lifecycle,captureRevision:this.scanSchedule.captureRevision});
    this.ocr.status = this.ocr.enabled ? this.offers.length ? 'recognized' : 'waiting' : 'disabled';
    this.ocr.message = provider === 'panel-statistical' ? '同图标按本轮推荐顺序推定已选；请核对，可在完整助手移除并改选。'
      : provider === 'panel-icon' ? '六格面板图标已匹配，推荐已更新；可手动纠正。'
      : provider === 'screen' ? '实验性屏幕确认已记录；可手动纠正，等待下一轮三选一卡片。' : provider === 'live-client'
      ? '游戏接口的明确已选结果已记录；推荐已更新，可手动纠正。' : '已确认选择；等待下一轮三选一卡片。';
    if (this.offers.length) this.ocr.message += ' 其余候选仍待确认，将继续核对。';
    delete this.ocr.code;
    delete this.ocr.diagnostics;
  }

  setOcr(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') throw new SessionValidationError('An enabled boolean is required.');
    this.manualRecognition.cancel();
    this.ocr.enabled = value.enabled;
    delete this.ocr.code;
    delete this.ocr.diagnostics;
    if (!value.enabled) { this.generation++; this.selectionObserver.invalidate(); this.invalidateCandidateCapture(); this.pendingOffers.revokeClickScopes(); this.panelLease = null; this.ocr.status = 'disabled'; this.ocr.message = '自动识别已暂停；已确认海克斯仍保留。'; }
    else {
      this.ocr.status = this.offers.length ? 'recognized' : 'waiting';
      this.ocr.message = this.offers.length ? '候选仍待确认；继续核对海克斯强化符文面板。' : '后台识别已开启；等待开局、死亡或复活后的识别窗口。';
    }
    void this.persistRecognition();
    return this.getModel();
  }

  recognizeOnce() {
    const live = this.observe(), context = this.manualContext(live);
    if (this.manualRecognition.job) return this.manualRecognition.job.promise;
    if (this.manualRecognition.closed || !context) return this.manualRecognition.unavailable(MANUAL_MESSAGES.ineligible);
    const job = this.manualRecognition.begin(context);
    // Each explicit request needs independent new panel frames, never a late
    // submission captured under the preceding automatic/manual lease.
    this.panelLease = null;
    void this.runManualRecognition(job);
    return job.promise;
  }

  async runManualRecognition(job) {
    try {
      const result = await this.scan({manualRequest:job});
      if (!this.manualRecognition.owns(job)) return;
      // Once accepted panel proof has changed owned state, persistence owns
      // completion. The concurrent OCR result must not shorten its deadline or
      // mistake the now-resolved pending round for a failed recognition.
      if (job.committing) return;
      const live = this.observe();
      if (!this.manualRecognition.owns(job)) return;
      if (result.status === 'recognized' && result.proposals?.length === 3) {
        this.manualRecognition.finish(job,'recognized',MANUAL_MESSAGES.recognized,result.proposals);
      } else if (FOREGROUND_SCAN_FAILURES.has(this.selectionAttempt.scanCode)) {
        this.manualRecognition.finish(job,'unavailable',MANUAL_MESSAGES.unavailable);
      } else if (!this.pendingOffers.entries.length) {
        this.manualRecognition.finish(job,'unavailable',MANUAL_MESSAGES.noPending);
      } else if (this.getPanelSelection(live).status !== 'watching') {
        this.manualRecognition.finish(job,'unavailable',MANUAL_MESSAGES.noCapture);
      } else this.manualRecognition.checking(job);
    } catch { this.manualRecognition.finish(job,'unavailable',MANUAL_MESSAGES.unavailable); }
  }

  async scan({automatic = false, manualRequest = null} = {}) {
    // Both manual requests and the background timer await the same capture.
    const live = this.observe();
    if (this.pending) return this.pending;
    const startingWindow = this.scanScheduleState(live);
    if (automatic && !startingWindow.due) return {status:'waiting', message:'等待开局、死亡或复活后的识别窗口。', proposals:[]};
    if (!this.captureEligible) {
      this.recordSelectionAttempt(null, false, live, false);
      return {status:'waiting', message:'等待进入海克斯大乱斗对局后识别。', proposals:[]};
    }
    const generation = this.generation;
    const lifecycle = this.scanSchedule.lifecycle;
    const captureRevision = this.scanSchedule.captureRevision;
    const startedAt = this.now();
    const startingRound = observedOfferRound(live,{gameId:this.session.gameId,now:startedAt});
    this.scanSchedule.started();
    this.scanCount++;
    let completion = {status:'unavailable', code:'scan-execution-failed'};
    this.pending = (async () => {
      let raw;
      try { raw = this.scanner ? await this.scanner() : null; }
      catch { raw = {code:'scan-execution-failed'}; }
      const current = this.observe();
      this.scanScheduleState(current);
      if (generation !== this.generation || lifecycle !== this.scanSchedule.lifecycle
        || captureRevision !== this.scanSchedule.captureRevision || !this.captureEligible
        || manualRequest && !this.manualRecognition.owns(manualRequest)) {
        completion = {status:'waiting', code:'scan-context-changed'};
        this.recordSelectionAttempt(raw, false, current, false, 'scan-context-changed');
        return {status:'waiting', code:'scan-context-changed', message:'识别周期已变化，请等待当前三选一卡片。', proposals:[]};
      }
      // Manual requests may start outside an automatic window. Once started,
      // every caller shares this same lifecycle/eligibility fence; its first
      // caller cannot change whether a late capture is accepted.
      const status = ['recognized', 'waiting', 'unavailable'].includes(raw?.status) ? raw.status : 'unavailable';
      const proposals = (Array.isArray(raw?.proposals) ? raw.proposals : []).filter(proposal => this.augments.has(proposal?.id)).map(proposal => ({id:proposal.id, name:this.augments.get(proposal.id).name, confidence:'exact'}));
      const triplet = status === 'recognized' && proposals.length === 3 && new Set(proposals.map(proposal => proposal.id)).size === 3;
      const alreadyOwned = proposals.some(proposal => this.session.owned.includes(proposal.id));
      const consumed = JSON.stringify(proposals.map(proposal => proposal.id)) === this.consumedOfferKey;
      const complete = triplet && !alreadyOwned && !consumed;
      const rejectionCode = status !== 'recognized' ? undefined : !triplet ? 'scan-proposals-incomplete' : alreadyOwned ? 'scan-offer-owned' : consumed ? 'scan-offer-consumed' : undefined;
      const scannedAt = new Date(this.now()).toISOString();
      this.recordSelectionAttempt(raw, complete, current, true, rejectionCode);
      completion = {status:complete ? 'recognized' : status, code:this.selectionAttempt.scanCode};
      if (complete) {
        const changedOffers = JSON.stringify(this.offers.map(offer => offer.id)) !== JSON.stringify(proposals.map(offer => offer.id));
        const capture = sanitizeSelectionCapture(raw?.selectionCapture);
        const acceptedCapture = capture?.identityAnchors && this.selectionAttempt.metadataStatus === 'accepted'
          && this.captureEligible ? capture : null;
        const pendingRevision = this.pendingOffers.revision;
        const completedRound = observedOfferRound(current,{gameId:this.session.gameId,now:this.now()});
        // A capture spanning a level update cannot borrow the completed
        // snapshot's progress for cards that may have been read before it.
        const roundContext = sameOfferRound(startingRound,completedRound) ? completedRound : null;
        const pending = this.pendingOffers.accept(proposals.map(offer => offer.id),{lifecycle,offerCycle:this.scanSchedule.offerCycle,
          roundContext,owned:this.session.owned,captureRevision,now:this.now(),capture:acceptedCapture});
        if (!pending) {
          this.selectionObserver.invalidate();
          completion = {status:'waiting',code:'scan-proposals-incomplete'};
          this.ocr.message = '仍有六轮候选等待确认；请先确认之前的选择。';
          return {status:'waiting',message:this.ocr.message,proposals:[],observedAt:scannedAt};
        }
        if (acceptedCapture && this.selectionEligible(current)) this.selectionObserver.arm({...this.selectionContext(), offerToken:pending.offerToken, ids:proposals.map(offer => offer.id), capture});
        else this.suspendSelectionForScan(raw, current, changedOffers);
        if (pendingRevision !== this.pendingOffers.revision) void this.persist();
        delete this.ocr.code;
        delete this.ocr.diagnostics;
        Object.assign(this.ocr, {status:'recognized', message:'已识别三个候选；请核对后自行选择，确认已选海克斯后推荐会更新。', observedAt:scannedAt}, publicOcrDetails(raw));
      } else {
        this.suspendSelectionForScan(raw, current, alreadyOwned || consumed);
        if (!this.offers.length) {
        delete this.ocr.code;
        delete this.ocr.diagnostics;
        Object.assign(this.ocr, {status, message:text(raw?.message) || '尚未确认到三个海克斯标题，可在主窗口手动选择。', observedAt:scannedAt}, publicOcrDetails(raw));
        }
      }
      // Empty battle frames do not replace the most recent valid three-card frame.
      return {status:complete ? 'recognized' : status === 'recognized' ? 'unavailable' : status, message:text(raw?.message) || this.ocr.message, proposals:complete ? proposals : [], observedAt:scannedAt};
    })().finally(() => {
      this.pending = null;
      this.lastScanDuration = Math.max(0, Math.min(100000, this.now() - startedAt));
      if (completion.status === 'unavailable') this.scanFailureCount++;
      // The scheduler discards an old epoch's cooldown, while releasing its task.
      this.scanSchedule.completed(completion);
      void this.publishScanDiagnostics();
    });
    void this.publishScanDiagnostics(live);
    return this.pending;
  }

  rankOffers(ids, champion, owned, recommendationData = champion ? this.recommendationRepository?.get(champion.id) : null) {
    const scoped = recommendationData?.championId === champion?.id ? recommendationData : null;
    const patch = scoped?.patch || '16.21';
    const evidence = selectBuildEvidence(scoped, {champion, owned, augments:[...this.augments.values()], patch});
    const ranked = rankAugmentCandidates(ids.map(id => {
      const offer = {id};
      const augment = this.augments.get(offer.id), result = recommend(augment, champion, owned, this.session.route);
      return {offer, augment, result, mechanismScore:result.score, conflicts:result.conflicts};
    }), {champion, owned, statistics:evidence.augmentStatistics, policy:{...this.recommendationPolicy, statisticsPatch:patch}});
    return {ranked, patch};
  }

  getModel() {
    const live = this.observe();
    const champion = this.champions.get(live.championId) || null;
    const owned = this.session.owned.map(id => this.augments.get(id)).filter(Boolean);
    const recommendationData = champion ? this.recommendationRepository?.get(champion.id) : null;
    const {ranked} = this.rankOffers(this.offers.map(offer => offer.id), champion, owned, recommendationData);
    const rank = new Map(ranked.map((entry, index) => [entry.offer.id, index + 1]));
    const offers = this.offers.map(offer => {
      const ranking = ranked.find(entry => entry.offer.id === offer.id);
      const result = ranking?.result || recommend(this.augments.get(offer.id), champion, owned, this.session.route);
      const definition = this.augments.get(offer.id);
      const statistic = ranking?.rankingEvidence;
      const reason = result.reasons[0] || '结合英雄机制与已确认海克斯比较；以游戏内实际效果为准。';
      return {id:offer.id, name:offer.name, icon:text(definition.icon, 400), rarity:text(definition.rarity, 40), rank:rank.get(offer.id) || null,
        reason:statistic?.trusted ? `该英雄持有胜率 ${(statistic.winRate*100).toFixed(1)}%；${reason}` : reason,
        rankingEvidence:statistic || null, cautions:result.cautions.slice(0, 2)};
    });
    const plan = {...buildLivePlan({champion, owned, route:this.session.route, live, augments:[...this.augments.values()], champions:[...this.champions.values()], itemsCatalog:this.itemsCatalog,
      recommendationData, policy:this.recommendationPolicy, now:this.now()}),
      gameId:this.session.gameId, gameEpoch:this.gameEpoch, sessionRevision:this.session.revision, championId:champion?.id || null,
      ownedIds:[...this.session.owned], route:this.session.route, generatedAt:new Date(this.now()).toISOString()};
    const recognition = this.recognitionSnapshot(live);
    // The compact sidebar has a separate purchase decision. Keep the full
    // application's plan and its comparison lists unchanged.
    const currentTarget = this.purchaseTarget?.championId === champion?.id ? this.purchaseTarget : null;
    const {purchaseProgress, purchasePlan, ...purchaseDecision} = buildNextItemRecommendation({champion, owned, route:this.session.route, live,
      augments:[...this.augments.values()], champions:[...this.champions.values()], itemsCatalog:this.itemsCatalog,
      recommendationData, plan, targetItemId:currentTarget?.itemId ?? null,
      targetAugmentIds:currentTarget?.ownedAugmentIds ?? null, now:this.now()});
    const nextItem = {...purchaseDecision,
      gameId:this.session.gameId, gameEpoch:this.gameEpoch, sessionRevision:this.session.revision,
      championId:champion?.id || null, ownedIds:[...this.session.owned], route:this.session.route,
      generatedAt:new Date(this.now()).toISOString()};
    // Keep only a bounded purchase intent in the shared session, not stale
    // rendered recommendations. The pure policy revalidates fresh inventory,
    // mechanisms and evidence on every refresh. Loading previews do not commit.
    const evaluatedAugmentIds = purchaseAugmentIds(purchasePlan?.evaluatedAugmentIds,this.augments);
    const purchaseTarget = nextItem.status === 'ready' && nextItem.stage === 'live'
      ? {championId:champion.id,itemId:nextItem.item.id,...(evaluatedAugmentIds ? {ownedAugmentIds:evaluatedAugmentIds} : {})}
      : purchaseProgress?.status === 'completed' ? null : this.purchaseTarget;
    if (purchaseTarget?.championId !== this.purchaseTarget?.championId || purchaseTarget?.itemId !== this.purchaseTarget?.itemId
      || JSON.stringify(purchaseTarget?.ownedAugmentIds) !== JSON.stringify(this.purchaseTarget?.ownedAugmentIds)) {
      this.purchaseTarget = purchaseTarget;
      void this.persist();
    }
    return {
      ...recognition, championSource:live.championSource || null,
      life:this.lifeSource.resolve(live, this.selectionContext()),
      mode:live.mode || {queueId:null, isMayhem:false, known:false},
      champion:champion ? {id:champion.id, name:champion.name, title:champion.title} : null,
      level:live.level ?? null, gameTime:live.gameTime ?? null, currentGold:live.currentGold ?? null, items:live.items || [],
      teams:live.teams || {status:'unavailable', ownTeam:null, allies:[], enemies:[], observedAt:live.observedAt || null},
      owned:owned.map(augment => ({id:augment.id, name:augment.name, icon:text(augment.icon, 400), rarity:text(augment.rarity, 40),
        ...(this.choiceSources[augment.id] === 'panel-statistical' ? {inferred:true, confirmationLabel:'推定已选（同图标）'} : {}),
        summary:text(String(augment.summary || augment.description || '').replace(/<[^>]*>/g, ''), 300)})), offers,
      pendingRevision:this.pendingOffers.revision,
      offerAttention:this.getOfferAttention(live),
      pendingOffers:this.pendingOffers.entries.map(entry => ({pendingId:entry.pendingId,sequence:entry.sequence,
        active:entry === this.pendingOffers.latest,previousRound:entry.sequence < this.pendingOffers.nextSequence - 1,createdAt:entry.createdAt,
        offers:entry.ids.map(id => { const augment = this.augments.get(id); return {id,name:augment.name,icon:text(augment.icon,400),rarity:text(augment.rarity,40)}; })})),
      ocr:{...this.ocr, schedule:this.scanScheduleState(live), proposals:this.offers.map(offer => ({...offer}))}, route:this.session.route, updatedAt:live.observedAt || new Date(this.now()).toISOString(),
      plan, nextItem,
      ...(this.appearance ? {appearance:this.appearance.get()} : {}),
    };
  }

  async pollOnce() {
    const live = this.observe();
    const schedule = this.scanScheduleState(live);
    // Diagnostics are observational; filesystem latency must not gate capture.
    void this.publishScanDiagnostics(live);
    if (schedule.due) await this.scan({automatic:true});
  }

  scanScheduleState(live) {
    const current = this.schedulingSnapshot(live || this.collector.getSnapshot());
    const schedule = this.scanSchedule.decision({live:current, gameEpoch:this.gameEpoch, enabled:this.ocr.enabled,
      inFlight:Boolean(this.pending)});
    this.syncScanLifecycle();
    this.syncCaptureEligibility(current);
    return schedule;
  }

  publishScanDiagnostics(live) {
    try {
      return this.scanDiagnostics.publish({...this.scanScheduleState(live), scanCount:this.scanCount,
        failureCount:this.scanFailureCount, lastDurationMs:this.lastScanDuration});
    } catch { return Promise.resolve(); }
  }

  nextAutomaticPollDelay() {
    try {
      const schedule = this.scanScheduleState();
      if (schedule.intervalMs > 0) return Math.max(100, Math.min(1000, schedule.nextInMs));
    } catch { /* A transient collector failure still gets a bounded retry. */ }
    return 1000;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      try { await this.pollOnce(); }
      catch {
        let current;
        try { current = this.observe(); } catch { /* An unavailable game context revokes continuation. */ }
        this.suspendSelectionForScan({code:'scan-loop-failed'}, current);
        this.recordSelectionAttempt({code:'scan-loop-failed'}, false, null);
        if (!this.offers.length) Object.assign(this.ocr, {status:'unavailable', code:'scan-loop-failed', message:'本次自动识别暂未完成，稍后会自动重试。', observedAt:new Date(this.now()).toISOString()});
      } finally {
        if (!this.stopped) { this.timer = this.timers.setTimeout(tick, this.nextAutomaticPollDelay()); this.timer.unref?.(); }
      }
    };
    void tick();
  }

  async stop() {
    this.manualRecognition.close();
    this.stopped = true; this.timers.clearTimeout(this.timer);
    // Stop our own OCR child before draining an in-flight scan.
    await this.scanner?.close?.();
    // Drain our own scan and latest bounded diagnostics without touching the game.
    await this.pending?.catch(() => {});
    await Promise.all([this.persistTail.catch(() => {}), this.preferencesTail.catch(() => {}), this.recommendationRepository?.close(), this.scanDiagnostics.close()]);
  }
}
