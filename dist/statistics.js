import {buildLivePlan} from './adaptive.js';

// Rates in this module are percentages. A difference between two rates is in
// percentage points; neither a pick rate nor a mechanism score is a win rate.
const RATE_TOLERANCE_PP = 0.00011;
const asArray = value => Array.isArray(value) ? value : [];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s·'’:\-：]/g, '');
const validRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const validGames = value => Number.isSafeInteger(value) && value > 0;
const validWins = (value, games) => Number.isSafeInteger(value) && value >= 0 && value <= games;
const current = augment => Boolean(augment && augment.availability === 'current' && !augment.retiredPatch
  && augment.recommendable !== false && !augment.isInternalTemplate);
const search = (value, query) => !normalize(query) || normalize(value).includes(normalize(query));

function countStatistics(row) {
  const games = validGames(row.games) ? row.games : null;
  const wins = games !== null && validWins(row.wins, games) ? row.wins : null;
  const sourceWinRate = validRate(row.winRate) ? row.winRate : null;
  const calculated = games !== null && wins !== null ? 100 * wins / games : null;
  // Source rates may be rounded to six decimal places as a probability. Reject
  // inconsistent units/counts, while keeping the observed counts for inspection.
  const suppliedRate = row.winRate !== undefined && row.winRate !== null;
  const consistent = calculated !== null && (!suppliedRate || sourceWinRate !== null
    && Math.abs(sourceWinRate - calculated) <= RATE_TOLERANCE_PP);
  return {games, wins, sourceWinRate, winRate:consistent ? calculated : null, hasStats:consistent,
    dataIssue:calculated === null ? '缺少有效胜场或样本数' : !consistent ? '来源胜率与胜场、样本数不一致' : ''};
}

function lowSample(row, meta) {
  // An explicit source flag is authoritative, even if a local assumption about
  // sample thresholds would produce the opposite result.
  if (typeof row.lowSample === 'boolean') return row.lowSample;
  return Number.isSafeInteger(meta.lowSampleThreshold) && meta.lowSampleThreshold > 0
    && validGames(row.games) && row.games < meta.lowSampleThreshold;
}

/** Merge a source snapshot onto the complete local hero catalog, without mutation. */
export function createStatistics(raw, catalogData = {}) {
  if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.meta) || raw.meta.mode !== 'aram-mayhem'
    || !Array.isArray(raw.champions)) throw new TypeError('Invalid ARAM Mayhem statistics snapshot.');
  const source = record(raw.meta.source) ? {...raw.meta.source} : {};
  const meta = {...raw.meta, source,
    coverage:record(raw.meta.coverage) ? {...raw.meta.coverage} : {},
    updatedAt:text(raw.meta.statsUpdatedAt) || null,
    sourceName:text(source.name), sourceUrl:text(source.url),
    totalMatches:validGames(raw.meta.validGames) ? raw.meta.validGames : null};
  const augmentById = new Map(asArray(catalogData.augments).filter(augment => text(augment?.id))
    .map(augment => [String(augment.id), augment]));
  const sourceHeroes = new Map();
  for (const row of raw.champions) {
    const id = text(row?.championId);
    if (!id || !record(row)) continue;
    if (sourceHeroes.has(id)) throw new TypeError(`Duplicate statistics champion: ${id}`);
    sourceHeroes.set(id, row);
  }
  const rulesPatch = text(catalogData.meta?.augmentPatch) || text(catalogData.meta?.patch);
  const snapshotOutdated = Boolean(rulesPatch && text(meta.rulesPatch) && rulesPatch !== text(meta.rulesPatch));
  const champions = asArray(catalogData.champions).map(champion => {
    const championId = String(champion.id);
    const row = sourceHeroes.get(championId);
    const baseline = countStatistics(row || {});
    const cohortId = text(row?.cohortId) || text(meta.cohortId);
    const provisional = row?.provisional === true || meta.provisional === true;
    const hero = {...champion, id:championId, championId,
      sourceChampionId:row?.sourceChampionId == null ? null : String(row.sourceChampionId),
      cohortId, ...baseline, sourceUrl:text(row?.sourceUrl) || text(source.url),
      provisional, outdated:snapshotOutdated, augments:[]};
    const seen = new Set();
    hero.augments = asArray(row?.augments).filter(record).map(entry => {
      const augmentId = text(entry.augmentId) || null;
      const sourceAugmentId = entry.sourceAugmentId == null ? '' : String(entry.sourceAugmentId);
      const key = sourceAugmentId || augmentId;
      if (!key || seen.has(key)) throw new TypeError(`Missing or duplicate source augment for ${championId}.`);
      seen.add(key);
      const augment = augmentId ? augmentById.get(augmentId) || null : null;
      const observed = countStatistics(entry);
      const entryCohort = text(entry.cohortId) || text(meta.cohortId);
      const isCurrent = current(augment);
      const entryProvisional = entry.provisional === true || provisional;
      const outdated = snapshotOutdated || Boolean(augment?.retiredPatch);
      const sameCohort = Boolean(cohortId && entryCohort && cohortId === entryCohort);
      const comparable = baseline.hasStats && observed.hasStats && sameCohort && !entryProvisional;
      const deltaPp = comparable ? observed.winRate - baseline.winRate : null;
      const comparisonReason = entryProvisional ? '预览或待确认数据，不能与正式统计基线比较'
        : !sameCohort ? '统计范围不同，不能计算胜率差'
          : !baseline.hasStats ? '缺少同口径英雄基础胜率'
            : !observed.hasStats ? observed.dataIssue : '';
      return {...entry, id:augmentId || sourceAugmentId, augmentId, sourceAugmentId,
        name:text(entry.name) || text(augment?.name) || sourceAugmentId,
        rarity:text(entry.rarity) || text(augment?.rarity), icon:text(augment?.icon) || text(entry.icon),
        cohortId:entryCohort, ...observed, augment,
        lowSample:lowSample(entry, meta), provisional:entryProvisional,
        isCurrent, canAdopt:isCurrent && !entryProvisional && !snapshotOutdated,
        outdated, sameCohort, comparable, deltaPp, delta:deltaPp, comparisonReason,
        sourceUrl:text(entry.sourceUrl) || hero.sourceUrl,
        builds:asArray(entry.builds).map(build => record(build) ? {...build} : build)};
    });
    return hero;
  });
  return {meta, champions, championById:new Map(champions.map(champion => [champion.championId, champion])), augmentById};
}

/** Unknown heroes always follow observed heroes; no missing value becomes zero. */
export function getChampionRows(index, {query = '', sort = 'winRate'} = {}) {
  const rows = asArray(index?.champions).filter(champion => search([
    champion.name, champion.title, champion.enName, champion.championId, ...asArray(champion.aliases)
  ].join(' '), query));
  return rows.sort((a, b) => {
    if (sort === 'name') return String(a.name).localeCompare(String(b.name), 'zh-CN');
    if (a.hasStats !== b.hasStats) return a.hasStats ? -1 : 1;
    const difference = sort === 'games' ? (b.games ?? -1) - (a.games ?? -1)
      : (b.winRate ?? -1) - (a.winRate ?? -1);
    return difference || (b.games ?? -1) - (a.games ?? -1) || String(a.name).localeCompare(String(b.name), 'zh-CN');
  });
}

/** Rank observed differences, never mechanism scores or relative percentages. */
export function getAugmentRows(index, championId, {
  query = '', rarity = 'all', includeLowSample = false, includeUnavailable = false
} = {}) {
  const hero = index?.championById?.get(String(championId))
    || asArray(index?.champions).find(champion => champion.championId === String(championId));
  return asArray(hero?.augments).filter(row => (includeLowSample || !row.lowSample)
    && (includeUnavailable || row.isCurrent && !row.provisional && !row.outdated && row.sameCohort)
    && (rarity === 'all' || row.rarity === rarity)
    && search([row.name, row.augment?.name, row.augment?.enName, row.augmentId, row.sourceAugmentId,
      ...asArray(row.augment?.aliases)].join(' '), query))
    .sort((a, b) => Number(b.comparable) - Number(a.comparable)
      || (b.deltaPp ?? -Infinity) - (a.deltaPp ?? -Infinity)
      || Number(b.hasStats) - Number(a.hasStats)
      || (b.games ?? -1) - (a.games ?? -1)
      || String(a.name).localeCompare(String(b.name), 'zh-CN'));
}

/** Static hero/augment explanations. This never claims a conditional build win rate. */
export function getAugmentBuildAdvice({champion, augment, augments = [], itemsCatalog = {}} = {}) {
  const mapped = record(augment) && Object.hasOwn(augment, 'augment') ? augment.augment : augment;
  const definitions = asArray(augments);
  const confirmed = mapped && definitions.find(entry => String(entry.id) === String(mapped.id));
  const unavailable = !champion || !confirmed || !current(mapped) || !current(confirmed)
    || augment?.provisional === true || augment?.canAdopt === false;
  if (unavailable) return {
    title:'暂不能生成这个海克斯的机制出装建议',
    summary:!champion ? '请先选择英雄。' : !confirmed ? '这条来源统计尚未映射到当前海克斯资料，不猜测装备搭配。'
      : '该条目为预览、历史或非当前常规选择，暂不套用正式服机制建议。',
    choices:[], context:[], confidence:'unavailable', label:'机制出装建议暂不可用', evidence:'mechanism'
  };
  const plan = buildLivePlan({champion, owned:[confirmed], augments:definitions,
    itemsCatalog, route:'auto', live:{}});
  // This is a browsing view, so a preview must never sound as if it has adopted
  // the augment or read the user's current match. The live assistant keeps its
  // original wording and state in adaptive.js.
  const context = [`英雄：${champion.title || champion.name || champion.id}；静态机制参考。`,
    `此页查看的海克斯：「${confirmed.name || confirmed.id}」。查看建议不会将它加入本局。`,
    '装备建议来自机制规则，不是来源统计中的最优出装或胜率排序。'];
  const liveWording = /已确认|在真实对局开始前|尚未读取|实战面板|当前进入|当前已到|当前等级|当前装备|已持有|已读取|当前.*?面板/u;
  let choices = plan.choices.map(choice => ({...choice,
    why:asArray(choice.why).filter(line => !liveWording.test(line)),
    watch:asArray(choice.watch).filter(line => !liveWording.test(line)),
    items:asArray(choice.items).map(item => ({...item}))}));
  const entries = itemsCatalog instanceof Map ? [...itemsCatalog.values()]
    : Array.isArray(itemsCatalog?.data) ? itemsCatalog.data : Object.values(itemsCatalog?.data || itemsCatalog || {});
  const usableItem = item => record(item) && item.inStore !== false && item.gold?.purchasable === true
    && (item.maps?.['12'] === true || item.maps?.['453'] === true)
    && (!item.requiredChampion || String(item.requiredChampion).toLowerCase() === String(champion.id).toLowerCase())
    && !item.requiredAlly;
  const itemSuggestion = (id, reason, verify) => {
    const item = entries.find(entry => String(entry?.id) === id);
    if (!usableItem(item) || !verify(text(item.description))) return null;
    return {id, name:item.name, reason,
      sourceUrl:itemsCatalog?.meta?.sourceUrl || '', catalogVersion:itemsCatalog?.meta?.version || ''};
  };
  const weave = /(?:施放|使用)(?:一个|你的)?技能(?:之?后)[^。！？\n]{0,60}(?:下一次|下次)(?:普通攻击|普攻|攻击)/u.test(text(confirmed.description));
  const noAttack = /(?:无法|不能|不可)(?:进行|使用)?(?:普攻|普通攻击|基本攻击)/u.test(text(confirmed.description));
  const hasSpellRoute = plan.choices.some(choice => choice.id === 'spell');
  const hasAttackRoute = plan.choices.some(choice => choice.id === 'attack');
  if (weave && !noAttack && (hasSpellRoute || hasAttackRoute)) {
    // A magic on-hit bonus does not turn an AD hero into an AP hero. Reuse the
    // established hero routes, then verify every item claim against its catalog.
    const spellblade = description => /咒刃/u.test(description)
      && /(?:施放|使用)技能后[^。\n]{0,45}下一次(?:普通攻击|攻击)/u.test(description);
    const equipment = hasSpellRoute ? [
      itemSuggestion('3100','巫妖之祸的咒刃明确在施放技能后强化下一次攻击，可与这条海克斯的“技能后接普攻”动作衔接；仍需亲自命中普攻。',spellblade),
      hasAttackRoute ? itemSuggestion('3115','纳什之牙提供攻速与普攻攻击特效；仅在法强路线也能持续普攻时作为后续方向比较，不会因为海克斯附带魔法伤害就必买。',
        description => /攻击速度/u.test(description) && /普攻.*攻击特效/u.test(description)) : null
    ] : [
      itemSuggestion('3078','三相之力的咒刃在施放技能后强化下一次普通攻击，与这条海克斯的触发动作一致；保留物理与战士路线，不因额外魔法伤害转买法强。',spellblade),
      itemSuggestion('3161','朔极之矛提供基础技能急速，适合比较缩短基础技能循环、再衔接普攻的方向；它本身不是这条海克斯的额外普攻触发器。',
        description => /基础技能急速/u.test(description))
    ];
    choices.unshift({id:'spell-attack-weave',title:'技能后衔接普攻',
      why:[`「${confirmed.name}」原文明确要求施放技能后，再用下一次攻击触发收益。`,
        '先用能安全命中的技能，再穿插一次普攻；不要只连续施法而漏掉强化后的攻击。',
        hasSpellRoute ? '沿用这个英雄现有的法强或技能路线，再比较能配合普攻的装备。'
          : '沿用这个英雄现有的物理或战士路线；额外魔法伤害本身不能证明法强出装更好。'],
      watch:['需要能接近或保持射程并实际普攻命中；不要为触发一次强化而失去安全位置。',
        '技能、海克斯与咒刃各自的冷却及触发条件以本局说明为准，不据此推断它们会无限连锁。',
        '下列装备是机制方向，排列不代表实测最优购买顺序或组合胜率。'],
      items:equipment.filter(Boolean)});
  }
  const upgradeName = text(confirmed.name).match(/^升级[：:]\s*(.+)$/u)?.[1]?.trim();
  if (upgradeName) {
    const matches = entries.filter(item => record(item) && text(item.name) === upgradeName
      && usableItem(item));
    // Some official catalogs contain two purchasable, same-name ARAM variants.
    // A name alone cannot establish which variant is in this game's shop.
    if (matches.length === 1) {
      const item = matches[0];
      const grantsItem = new RegExp(`获得(?:一个|一件)\\s*[【「]?${upgradeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(confirmed.description || '');
      choices = [{id:'augment-equipment', title:`围绕${upgradeName}的强化效果`,
        why:[`「${confirmed.name}」与当前可购目录中的「${item.name}」名称精确对应。`,
          grantsItem ? '强化文本说明会提供这件装备，请先确认已获得，避免重复购买。' : '如果选择利用这条装备强化，请先在本局商店确认对应基础装备是否可购买。'],
        watch:['这条建议依据强化效果与装备目录；没有该组合出装的胜率或最优购买顺序。',
          '同名装备在不同模式可能有不同价格和效果，以本局商店显示为准。'],
        items:[{id:String(item.id), name:item.name,
          reason:grantsItem ? '强化会提供该装备；作为效果参考，请勿据此重复购买。' : `用于触发「${confirmed.name}」所述的对应装备效果，购买前核对本局商店。`,
          sourceUrl:itemsCatalog?.meta?.sourceUrl || '', catalogVersion:itemsCatalog?.meta?.version || ''}]
      }, ...choices];
    } else if (matches.length > 1) context.push(`「${upgradeName}」在目录中存在多个可购同名版本，没有根据名称替你选定具体版本，请在本局商店核对。`);
  }
  // A generic survival fallback follows the interaction-specific choices. Keep
  // each suggested item in its first route so the list does not repeat a build.
  choices.sort((a,b) => Number(a.id === 'survive') - Number(b.id === 'survive'));
  const suggested = new Set();
  choices = choices.slice(0,3).map(choice => ({...choice, items:asArray(choice.items).filter(item => {
    if (suggested.has(String(item.id))) return false;
    suggested.add(String(item.id));return true;
  })}));
  return {...plan, choices, label:'机制出装建议 · 无该组合出装胜率', evidence:'mechanism',
    summary:`结合${champion.title || champion.name || champion.id}与「${confirmed.name || confirmed.id}」的效果解释玩法和装备方向。以下没有英雄 × 海克斯 × 装备的实测胜率。`,
    context};
}
