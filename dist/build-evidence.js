// Pure adapters for aggregate observations. No filesystem, network or session writes.
const array = value => Array.isArray(value) ? value : [];
const count = value => Number.isSafeInteger(value) && value >= 0;
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const positiveId = value => /^(?:[1-9]\d{0,8})$/.test(String(value ?? ''));
const idOf = augment => String(augment?.gameDataId ?? augment?.sourceAugmentId ?? '');

export function getStaticAugmentStatistics(snapshot, championId) {
  const result = Object.create(null), meta = snapshot?.meta;
  if (meta?.mode !== 'aram-mayhem' || typeof meta.patch !== 'string' || !meta.cohortId) return result;
  const hero = array(snapshot.champions).find(row => row.championId === championId && row.cohortId === meta.cohortId);
  if (!hero) return result;
  const threshold = count(meta.lowSampleThreshold) ? meta.lowSampleThreshold : 3000;
  for (const row of array(hero.augments)) {
    if (typeof row.augmentId !== 'string' || !count(row.games) || row.games < 1 || !count(row.wins) || row.wins > row.games) continue;
    result[row.augmentId] = {winRate:row.wins / row.games, sampleCount:row.games,
      comparable:row.cohortId === meta.cohortId && row.provisional !== true && row.lowSample !== true && row.games >= threshold,
      patch:meta.patch, source:meta.source?.name || 'AramHex', sourceUrl:row.sourceUrl || meta.source?.url || '',
      cohortId:row.cohortId, pickRate:null};
  }
  return result;
}

function observation(row) {
  if (!row || !rate(row.winRate) || !count(row.sampleCount) || row.sampleCount < 1) return null;
  return {winRate:row.winRate, sampleCount:row.sampleCount, pickRate:rate(row.pickRate) ? row.pickRate : null};
}

function itemRows(rows) {
  const seen = new Set();
  return array(rows).flatMap(row => {
    const stats = observation(row), id = String(row?.id ?? '');
    if (!positiveId(id) || !stats || seen.has(id)) return [];
    seen.add(id); return [{id, ...stats, ...(['single-item','boots'].includes(row.scope) ? {scope:row.scope} : {})}];
  });
}

/** A supplied snapshot must already have passed the repository's source validator. */
export function selectBuildEvidence(entry, {champion, owned = [], augments = [], patch = '16.21'} = {}) {
  const snapshot = entry?.snapshot, meta = snapshot?.meta;
  const empty = {status:entry?.status || 'unavailable', items:[], builds:[], pairs:[],
    augmentStatistics:entry?.augmentStatistics || {}, patch, source:snapshot ? 'ARAMKit' : '', sourceUrl:meta?.sourceUrl || '',
    dataDate:meta?.dataDate || '', cacheStatus:entry?.mayhemStatus || entry?.status || '', scope:'none', conditionAugmentId:null};
  if (entry?.mayhemStatus != null && entry.mayhemStatus !== 'ready') return {...empty, status:entry.mayhemStatus};
  if (entry?.status === 'stale' && entry?.mayhemStatus == null) return {...empty, status:'stale'};
  if (!champion || !snapshot || meta?.patch !== patch || !positiveId(snapshot.championId)
    || snapshot.detail?.champion?.id !== snapshot.championId || entry?.championId && entry.championId !== champion.id
    || entry?.sourceChampionId != null && entry.sourceChampionId !== snapshot.championId) return empty;
  const byNumeric = new Map(array(augments).filter(a => positiveId(idOf(a))).map(a => [idOf(a), a]));
  const statistics = Object.create(null);
  for (const row of array(snapshot.detail?.augments?.all)) {
    const definition = byNumeric.get(String(row?.id)), stats = observation(row);
    if (!definition || !stats) continue;
    statistics[definition.id] = {...stats, comparable:stats.sampleCount >= 200, patch,
      source:'ARAMKit', sourceUrl:meta.sourceUrl || 'https://aramkit.com/', cohortId:`${meta.dataPath || patch}:all`};
  }
  // Never fill individual missing stage/cohort rows with a different cohort.
  const augmentStatistics = Object.keys(statistics).length ? statistics : empty.augmentStatistics;
  const selected = array(owned).at(-1);
  const selectedNumeric = idOf(selected);
  const conditional = Boolean(selected);
  const itemSource = conditional ? array(snapshot.single?.items).find(row => String(row.augmentId) === selectedNumeric)
    : snapshot.detail?.items?.filtered;
  const buildSource = conditional ? array(snapshot.single?.builds).find(row => String(row.augmentId) === selectedNumeric)
    : snapshot.detail?.builds?.filtered;
  const items = itemRows(itemSource?.all);
  const builds = array(buildSource?.archetypes).flatMap(archetype => array(archetype.profiles).flatMap(profile => {
    const stats = observation(profile), ids = array(profile.itemSet).map(item => String(item?.id));
    if (!stats || ids.length !== 3 || new Set(ids).size !== 3 || ids.some(id => !positiveId(id))) return [];
    const routes = array(profile.routes).flatMap(route => {
      const values = array(route.purchaseOrder).map(item => String(item?.id)), observed = observation(route);
      return observed && values.length === 3 && new Set(values).size === 3 && values.every(id => ids.includes(id))
        ? [{items:values, ...observed}] : [];
    }).sort((a, b) => b.sampleCount - a.sampleCount);
    return [{items:ids, ...stats, route:routes[0] || null, archetype:String(archetype.key || '')}];
  })).filter(row => row.sampleCount >= 200).sort((a, b) => b.winRate - a.winRate || b.sampleCount - a.sampleCount);
  const ownedIds = new Set(array(owned).map(augment => idOf(augment)));
  const pairs = array(snapshot.detail?.augmentCombinations).flatMap(pair => {
    const ids = array(pair.augmentIds).map(String), stats = observation(pair);
    if (!stats || ids.length !== 2 || ids[0] === ids[1]) return [];
    const existing = ids.find(id => ownedIds.has(id)), next = ids.find(id => !ownedIds.has(id));
    const definition = byNumeric.get(next);
    if (!existing || !next || !definition || stats.sampleCount < 200) return [];
    return [{augmentId:definition.id, withAugmentId:byNumeric.get(existing)?.id || '', ...stats,
      source:'ARAMKit', coverage:'published-top-10'}];
  });
  return {status:items.length ? 'ready' : conditional ? 'condition-missing' : 'missing',
    items, builds, pairs, augmentStatistics, patch, source:'ARAMKit', sourceUrl:meta.sourceUrl || 'https://aramkit.com/',
    dataDate:meta.dataDate || '', cacheStatus:entry?.mayhemStatus || entry?.status || '', scope:conditional ? 'champion-single-augment' : 'champion-filtered-items',
    conditionAugmentId:conditional ? selected.id : null,
    conditionNote:conditional && owned.length > 1 ? '统计按最近确认的单个海克斯取样；其他已选仅参与机制兼容校验，不代表联合条件胜率。' : ''};
}

function qualified(rows, minimumSamples) {
  return itemRows(rows).filter(row => row.sampleCount >= minimumSamples);
}

function rankScores(rows) {
  const ordered = [...rows].sort((a, b) => b.winRate - a.winRate || b.sampleCount - a.sampleCount);
  const uniqueRates = [...new Set(ordered.map(row => row.winRate))];
  return new Map(ordered.map(row => [row.id, uniqueRates.length === 1 ? 1 : 1 - uniqueRates.indexOf(row.winRate) / (uniqueRates.length - 1)]));
}

/** Blend ranks, never blend incompatible observed win rates into one probability. */
export function mixBuildItemEvidence(primary, {ordinaryAram, summonersRift, patch = '16.21', minimumSamples = 200} = {}) {
  const primaryRows = qualified(primary?.items, minimumSamples), primaryScores = rankScores(primaryRows);
  const validSecondary = (source, mode) => source?.mode === mode && source.patch === patch && source.comparable === true
    ? qualified(source.items, minimumSamples) : [];
  const aramRows = validSecondary(ordinaryAram, 'aram'), riftRows = validSecondary(summonersRift, 'summoners-rift');
  const candidateSecondary = !primaryRows.length ? null : aramRows.length ? ordinaryAram : riftRows.length ? summonersRift : null;
  const secondaryRows = aramRows.length ? aramRows : riftRows;
  const secondary = candidateSecondary && primaryRows.some(row => secondaryRows.some(other => row.id === other.id)) ? candidateSecondary : null;
  const secondaryScores = rankScores(secondaryRows), secondaryById = new Map(secondaryRows.map(row => [row.id, row]));
  const effectiveWeights = {mayhem:primaryRows.length ? secondary ? .8 : 1 : 0, aram:secondary === ordinaryAram && secondary ? .2 : 0,
    summonersRift:secondary === summonersRift && secondary ? .2 : 0};
  const sourceLabel = secondary ? secondary.mode === 'aram' ? '海克斯大乱斗 80%＋普通 ARAM 20%' : '海克斯大乱斗 80%＋召唤师峡谷 20%'
    : primaryRows.length ? '海克斯大乱斗 100%（辅助来源暂缺）' : '装备统计暂缺';
  const comparableItems = primaryRows.filter(row => secondaryScores.has(row.id)).length;
  const coverage = {mayhemItems:primaryRows.length, comparableItems:secondary ? comparableItems : 0,
    mayhemOnlyItems:secondary ? primaryRows.length - comparableItems : primaryRows.length};
  const items = primaryRows.map(row => ({...row,
    recommendationScore:secondaryScores.has(row.id) && secondary ? .8 * primaryScores.get(row.id) + .2 * secondaryScores.get(row.id) : primaryScores.get(row.id),
    effectiveWeights:secondaryScores.has(row.id) && secondary ? {...effectiveWeights} : {mayhem:1,aram:0,summonersRift:0},
    evidence:{mayhem:{...row, source:primary.source, scope:primary.scope, conditionAugmentId:primary.conditionAugmentId},
      secondary:secondaryById.has(row.id) ? {...secondaryById.get(row.id), source:secondary.source, mode:secondary.mode} : null}
  })).sort((a, b) => b.recommendationScore - a.recommendationScore || b.winRate - a.winRate || b.sampleCount - a.sampleCount || a.id.localeCompare(b.id));
  return {items, configuredWeights:{mayhem:.8, secondary:.2}, effectiveWeights, coverage, secondaryMode:secondary?.mode || null,
    summary:sourceLabel + (secondary && coverage.mayhemOnlyItems ? '；缺同装备辅助样本的项目仅用本模式' : ''),
    scoreKind:'within-mode-win-rate-rank', mixedWinRate:null};
}
