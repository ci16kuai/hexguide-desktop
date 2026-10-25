/**
 * Pure ranking policy shared by browsing and live recommendations.
 * Rates are probabilities (0..1), never percentage values or mechanism scores.
 * The close-rate window is anchored to each group's best observed rate so the
 * grouping remains transitive; it is a product preference, not a significance test.
 * Policy overrides contain JSON values only. Nothing here fetches or persists data.
 */
import {getMechanicalConstraints} from './engine.js';

const CATEGORIES = ['mechanical', 'scaling-percent', 'fixed-stat', 'unknown'];
const NUMERIC_KINDS = ['omnivamp', 'lifeSteal', 'percentPenetration', 'crit',
  'percentAttackDamage', 'highFlatAttackDamage', 'flatPenetration', 'attackDamage', 'health', 'shield'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const list = value => Array.isArray(value) ? value : [];
const unique = value => [...new Set(value)];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rate = value => finite(value) && value >= 0 && value <= 1;
const text = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
function freeze(value) {
  if (record(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_RECOMMENDATION_POLICY = freeze({
  version: 1,
  closeWinRateGap: 0.01,
  minSampleCount: 200,
  // Product threshold for the user's "large flat AD" category, not a game rule.
  highFlatAttackDamage: 60,
  statisticsPatch: null,
  pickRateOrder: 'higher-first',
  categoryPriority: [...CATEGORIES],
  numericPriority: [...NUMERIC_KINDS],
  // Reviewed exceptions can override category/numericKinds with a reason.
  // Example: { augmentId: {category:'mechanical', numericKinds:[], reason:'...'} }
  augmentOverrides: {},
  // Keyed by exact champion ID. Supported fields: noMana, noAttacks, noCrit,
  // excludedAugmentIds, excludedNumericKinds, numericPriority, augmentOverrides.
  // No inferred AP/AD ban: a role label cannot establish a spell's scaling.
  championOverrides: {},
});

function priority(value, allowed, fallback) {
  const chosen = unique(list(value).filter(key => allowed.includes(key)));
  return chosen.length ? [...chosen, ...fallback.filter(key => !chosen.includes(key))] : [...fallback];
}

function configuration(policy, champion) {
  const supplied = record(policy) ? policy : {};
  const championRule = own(supplied.championOverrides, String(champion?.id ?? ''));
  const hero = record(championRule) ? championRule : {};
  return {
    closeWinRateGap: rate(supplied.closeWinRateGap) ? supplied.closeWinRateGap : DEFAULT_RECOMMENDATION_POLICY.closeWinRateGap,
    minSampleCount: Number.isSafeInteger(supplied.minSampleCount) && supplied.minSampleCount > 0
      ? supplied.minSampleCount : DEFAULT_RECOMMENDATION_POLICY.minSampleCount,
    highFlatAttackDamage: finite(supplied.highFlatAttackDamage) && supplied.highFlatAttackDamage > 0
      ? supplied.highFlatAttackDamage : DEFAULT_RECOMMENDATION_POLICY.highFlatAttackDamage,
    statisticsPatch: typeof supplied.statisticsPatch === 'string' && supplied.statisticsPatch.trim()
      ? supplied.statisticsPatch.trim() : null,
    pickRateOrder: supplied.pickRateOrder === 'lower-first' ? 'lower-first' : 'higher-first',
    categoryPriority: priority(supplied.categoryPriority, CATEGORIES, CATEGORIES),
    numericPriority: priority(hero.numericPriority ?? supplied.numericPriority, NUMERIC_KINDS, NUMERIC_KINDS),
    augmentOverrides: record(supplied.augmentOverrides) ? supplied.augmentOverrides : {},
    hero,
  };
}

const STAT_WORDS = /全能吸血|生命偷取|护甲穿透|法术穿透|魔法穿透|穿甲|暴击(?:几率|率)?|攻击力|法术强度|生命值|护盾|攻击速度|攻速|技能急速|护甲|魔法抗性|移动速度|法力|omnivamp|life\s?steal|penetration|crit(?:ical)?|attack damage|ability power|health|shield|attack speed|haste|armor|magic resist|mana/i;
const STAT_NUMBER = /\d+(?:\.\d+)?\s*(?:点|的)?\s*(?:额外|最大|基础)?(?:全能吸血|生命偷取|护甲穿透|法术穿透|魔法穿透|穿甲|暴击(?:几率|率|伤害)?|攻击力|法术强度|生命值|护盾|攻击速度|攻速|技能急速|护甲|魔法抗性|移动速度|法力(?:值)?)/u;
const STAT_PERCENT = /\d+(?:\.\d+)?\s*%\s*(?:的)?\s*(?:额外|最大|基础)?(?:全能吸血|生命偷取|护甲穿透|法术穿透|魔法穿透|穿甲|暴击(?:几率|率|伤害)?|攻击力|法术强度|生命值|护盾|攻击速度|攻速|技能急速|护甲|魔法抗性|移动速度|法力(?:值)?)|(?:攻击力|法术强度|生命值|护盾|攻速|护甲|魔法抗性|法力(?:值)?)(?:提高|增加|提升)\s*\d+(?:\.\d+)?\s*%/u;
const GAIN = /获得|增加|提升|提高|提供|赋予|获取|gain|grant|increase|receive/i;
const LOSS = /(?:无法|不能|不可|不再).{0,12}(?:获得|增加|提升|提高|提供|产生)|(?:失去|降低|减少|消耗).{0,12}(?:全能吸血|生命偷取|穿透|穿甲|暴击|攻击力|法术强度|生命值|护盾)|cannot.{0,12}(?:gain|grant)|lose|reduce/i;
const MECHANICAL_RULES = [
  ['spell-critical-strikes', /技能.{0,12}(?:可以|能够|能|可)(?:造成)?暴击|(?:abilities|spells) can (?:crit|critically strike)/i],
  ['attribute-conversion', /(?:将|把).{0,35}(?:转化|转换|转为).{0,25}(?:攻击力|法术强度|生命值|护甲|魔法抗性|攻速|技能急速)|convert.{0,50}(?:attack damage|ability power|health|armor|haste)/i],
  ['revival-or-reset', /复活|重生|(?:重置|刷新).{0,18}(?:冷却|技能)|(?:再次|额外|重新)施放|reviv|resurrect|reset.{0,18}cooldown|cast.{0,15}(?:again|twice)/i],
  ['spell-attack-interaction', /(?:施放|释放|使用).{0,12}技能.{0,45}(?:下次|下一次).{0,15}(?:普攻|普通攻击|攻击)|(?:普攻|普通攻击).{0,18}(?:会|能|可|附带|施加|触发).{0,20}(?:灼烧|治疗|护盾|技能|魔法伤害|真实伤害)/i],
  ['new-control-trigger', /(?:定身|禁锢|眩晕|击飞).{0,15}(?:时|后).{0,30}(?:获得|提供|造成|施加).{0,20}(?:护盾|治疗|伤害|控制)/i],
  ['equipment-upgrade', /(?:升级|强化).{0,12}(?:装备|物品)|(?:装备|物品).{0,15}(?:升级|进化)|upgrade.{0,20}item/i],
];

function positiveClauses(description) {
  return description.split(/[，,。；;!！?？\n]/u).filter(clause => GAIN.test(clause) && !LOSS.test(clause)
    && !/^\s*(?:敌人|敌方|目标)(?:会|将|可)?(?:获得|增加|提升|提高)/u.test(clause));
}

function classification(augment, config) {
  const description = text(augment?.description);
  const clauses = positiveClauses(description);
  const numericKinds = [];
  const evidence = [];
  const add = (kind, pattern) => {
    const clause = clauses.find(value => pattern.test(value));
    if (clause) { numericKinds.push(kind); evidence.push({kind, text: clause.trim().slice(0, 160)}); }
  };
  add('omnivamp', /全能吸血|omnivamp/i);
  add('lifeSteal', /生命偷取|life\s?steal/i);
  add('percentPenetration', /\d+(?:\.\d+)?\s*%\s*(?:的)?\s*(?:护甲穿透|法术穿透|魔法穿透|物理穿透)|百分比.{0,8}(?:穿透|穿甲)|(?:armor|magic) penetration.{0,8}\d+(?:\.\d+)?\s*%/i);
  add('crit', /暴击(?:几率|率)|critical strike chance|crit chance/i);
  add('percentAttackDamage', /\d+(?:\.\d+)?\s*%\s*(?:的)?\s*攻击力|攻击力.{0,8}(?:提升|提高|增加)\s*\d+(?:\.\d+)?\s*%|attack damage.{0,8}\d+(?:\.\d+)?\s*%/i);
  const flatAttackClauses = clauses.filter(clause => /(?:^|[^\d.%])\d+(?:\.\d+)?\s*(?:点)?攻击力/u.test(clause));
  const flatAttack = flatAttackClauses.flatMap(clause => [...clause.matchAll(/(?:^|[^\d.%])(\d+(?:\.\d+)?)\s*(?:点)?攻击力/gu)].map(match => Number(match[1])));
  if (flatAttack.length) {
    const high = Math.max(...flatAttack) >= config.highFlatAttackDamage;
    numericKinds.push(high ? 'highFlatAttackDamage' : 'attackDamage');
    evidence.push({kind: high ? 'highFlatAttackDamage' : 'attackDamage', text: flatAttackClauses[0].trim().slice(0, 160)});
  }
  add('flatPenetration', /(?:^|[^\d.%])\d+(?:\.\d+)?\s*(?:点)?(?:穿甲|护甲穿透|法术穿透|魔法穿透)/u);
  // "a shield based on maximum health" does not grant health itself.
  add('health', /(?:获得|增加|提升|提高|提供|赋予|获取)\s*(?:\d+(?:\.\d+)?\s*%?|〔[^〕]{1,40}〕)\s*(?:点|的)?\s*(?:最大|额外|基础)?生命值(?!\s*(?:的)?(?:护盾|魔法伤害|物理伤害|真实伤害))|(?:最大|额外|基础)?生命值(?:提高|增加|提升)\s*\d+(?:\.\d+)?\s*%/u);
  add('shield', /护盾|shield/i);

  const mechanism = MECHANICAL_RULES.find(([, pattern]) => pattern.test(description));
  const statClauses = clauses.filter(clause => STAT_WORDS.test(clause));
  const growth = statClauses.some(clause => /永久|无限|叠加|叠层|每(?:级|次|当|秒|分钟)|随.{0,12}(?:时间|等级)|permanent|stack|per level/i.test(clause))
    || /(?:永久|无限|叠加|叠层).{0,20}(?:攻击力|法术强度|生命值|护甲|魔法抗性|技能急速|穿甲|穿透)/u.test(description) && statClauses.length > 0;
  const percent = statClauses.some(clause => STAT_PERCENT.test(clause));
  let category = mechanism ? 'mechanical' : growth || percent ? 'scaling-percent'
    : statClauses.some(clause => STAT_NUMBER.test(clause)) ? 'fixed-stat' : 'unknown';
  let categoryEvidence = mechanism ? mechanism[0] : growth ? 'explicit-stat-growth' : percent ? 'explicit-stat-percentage'
    : category === 'fixed-stat' ? 'explicit-flat-stat' : 'insufficient-description';
  let kinds = unique(numericKinds);
  const id = String(augment?.id ?? '');
  const override = own(config.hero.augmentOverrides, id) ?? own(config.augmentOverrides, id);
  if (record(override) && typeof override.reason === 'string' && override.reason.trim()) {
    if (CATEGORIES.includes(override.category)) category = override.category;
    if (Array.isArray(override.numericKinds)) kinds = unique(override.numericKinds.filter(kind => NUMERIC_KINDS.includes(kind)));
    categoryEvidence = `reviewed-override: ${override.reason.trim().slice(0, 200)}`;
  }
  return {category, numericKinds:kinds, categoryEvidence, numericEvidence:evidence,
    numericPriority:kinds.length ? Math.min(...kinds.map(kind => config.numericPriority.indexOf(kind))) : null};
}

/** No name-only classification: authentic description text or reviewed overrides. */
export function classifyAugmentPolicy(augment, {champion, policy} = {}) {
  return classification(augment, configuration(policy, champion));
}

function noMana(champion, hero) {
  if (typeof hero.noMana === 'boolean') return hero.noMana;
  if (!record(champion) || !Object.hasOwn(champion, 'resource')) return false;
  return !/^(?:mana|法力(?:值)?|魔法值)$/i.test(String(champion.resource).trim());
}

function manaOnly(description) {
  // Only a plain stat grant is provably unusable. A conversion, shield, damage,
  // or other conditional interaction mentioning mana stays eligible.
  return /法力/u.test(description)
    && /^(?:(?:你|自身|自己|立即|并|和|与|及|的|获得|增加|提高|提升|提供|赋予|额外|最大|基础|法力值|法力|上限|点)|[\d.%+\s，,。；;])+$/u.test(description);
}

function pureCrit(description) {
  return /暴击(?:几率|率)/u.test(description)
    && /^(?:(?:你|自身|自己|立即|并|和|与|及|的|获得|增加|提高|提升|提供|赋予|额外|暴击几率|暴击率|点)|[\d.%+\s，,。；;])+$/u.test(description);
}

function eligible(row, champion, owned, config, features) {
  const augment = row?.augment;
  if (!record(augment) || augment.id == null || String(augment.id) === '') return false;
  if (row.eligible === false || list(row.conflicts).length || row.conflicts === true) return false;
  if (augment.recommendable === false || augment.isInternalTemplate || augment.retiredPatch
    || Object.hasOwn(augment, 'availability') && augment.availability !== 'current') return false;
  const id = String(augment.id);
  if (owned.some(entry => String(record(entry) ? entry.id : entry) === id)) return false;
  if (list(config.hero.excludedAugmentIds).map(String).includes(id)) return false;
  if (features.numericKinds.some(kind => list(config.hero.excludedNumericKinds).includes(kind))) return false;
  const candidateConstraints = getMechanicalConstraints(augment);
  if (owned.filter(record).some(entry => {
    const previous = getMechanicalConstraints(entry);
    return previous.noUltimate && candidateConstraints.requiresUltimate
      || candidateConstraints.noUltimate && previous.requiresUltimate;
  })) return false;
  const description = text(augment.description);
  if (noMana(champion, config.hero) && (augment.requiresMana === true || manaOnly(description))) return false;
  const ownedText = owned.filter(record).map(entry => text(entry.description)).join('\n');
  const cannotAttack = config.hero.noAttacks === true
    || /(?:无法|不能|不可)(?:进行|使用)?(?:普攻|普通攻击|基本攻击)|cannot (?:use |perform )?(?:basic )?attack/i.test(ownedText);
  const cannotCrit = config.hero.noCrit === true
    || /(?:你|伤害)(?:将|的伤害)?(?:无法|不能|不可)暴击|(?:your damage|you) cannot (?:crit|critically strike)/i.test(ownedText);
  const attackOnly = /^(?:你的|每次|每当)?(?:普攻|普通攻击|基本攻击)|^(?:your |each |every )?(?:basic )?attacks?\b/i.test(description)
    && !/技能|施放|释放|每秒|abilit|spell|per second/i.test(description)
    && !positiveClauses(description).some(clause => !/普攻|普通攻击|基本攻击|attacks?/i.test(clause));
  if (cannotAttack && (augment.requiresAttacks === true || attackOnly)) return false;
  if (cannotCrit && (augment.requiresCrit === true || pureCrit(description)
    || features.categoryEvidence === 'spell-critical-strikes')) return false;
  return true;
}

function observation(statistics, id, config) {
  const supplied = statistics instanceof Map ? statistics.get(id) : own(statistics, id);
  const value = record(supplied) ? supplied : {};
  let rejection = null;
  if (!record(supplied)) rejection = 'missing-statistics';
  else if (value.comparable !== true) rejection = 'not-comparable';
  else if (!rate(value.winRate)) rejection = 'invalid-win-rate';
  else if (!Number.isSafeInteger(value.sampleCount) || value.sampleCount < config.minSampleCount) rejection = 'insufficient-sample';
  else if (config.statisticsPatch && value.patch !== config.statisticsPatch) rejection = 'patch-mismatch';
  return {
    trusted: rejection === null,
    winRate: rate(value.winRate) ? value.winRate : null,
    sampleCount: Number.isSafeInteger(value.sampleCount) && value.sampleCount >= 0 ? value.sampleCount : null,
    pickRate: rate(value.pickRate) && value.comparable === true
      && (!config.statisticsPatch || value.patch === config.statisticsPatch) ? value.pickRate : null,
    patch: typeof value.patch === 'string' ? value.patch : null,
    source: typeof value.source === 'string' || record(value.source) ? value.source : null,
    rejection,
  };
}

/**
 * rows: [{augment, mechanismScore, conflicts?, ...}], without mutation.
 * statistics: Map/record keyed by augment.id with {winRate:0..1,sampleCount,
 * pickRate?:0..1,comparable:true,patch?,source?}. Untrusted rates are preserved
 * only as observed evidence; they never control the statistical ordering.
 * Missing statistics follow trusted groups, with mechanism suitability first.
 */
export function rankAugmentCandidates(rows, {champion, owned = [], statistics, policy} = {}) {
  const config = configuration(policy, champion);
  const selected = list(owned);
  const entries = list(rows).filter(record).map((row, index) => {
    const features = classification(row.augment, config);
    return {row, index, features, observed:observation(statistics, String(row.augment?.id ?? ''), config),
      mechanismScore:finite(row.mechanismScore) ? row.mechanismScore : null, group:null, anchor:null};
  }).filter(entry => eligible(entry.row, champion, selected, config, entry.features));
  const trusted = entries.filter(entry => entry.observed.trusted)
    .sort((a, b) => b.observed.winRate - a.observed.winRate || a.index - b.index);
  let group = -1, anchor = null;
  for (const entry of trusted) {
    if (anchor === null || anchor - entry.observed.winRate > config.closeWinRateGap + Number.EPSILON * 4) {
      anchor = entry.observed.winRate; group++;
    }
    entry.group = group; entry.anchor = anchor;
  }
  const categoryOrder = entry => config.categoryPriority.indexOf(entry.features.category);
  const numericOrder = entry => entry.features.numericPriority ?? config.numericPriority.length;
  const mechanismOrder = entry => entry.mechanismScore ?? -Infinity;
  const pick = (a, b) => {
    if ((a.observed.pickRate === null) !== (b.observed.pickRate === null)) return a.observed.pickRate === null ? 1 : -1;
    if (a.observed.pickRate === null) return 0;
    return config.pickRateOrder === 'lower-first'
      ? a.observed.pickRate - b.observed.pickRate : b.observed.pickRate - a.observed.pickRate;
  };
  entries.sort((a, b) => {
    if (a.observed.trusted !== b.observed.trusted) return a.observed.trusted ? -1 : 1;
    if (a.observed.trusted && a.group !== b.group) return a.group - b.group;
    if (!a.observed.trusted) {
      const score = mechanismOrder(b) - mechanismOrder(a);
      if (score && !Number.isNaN(score)) return score;
    }
    return categoryOrder(a) - categoryOrder(b) || numericOrder(a) - numericOrder(b)
      || (mechanismOrder(b) - mechanismOrder(a) || 0)
      || (a.observed.trusted ? b.observed.winRate - a.observed.winRate : 0)
      || pick(a, b) || a.index - b.index;
  });
  return entries.map((entry, index) => ({...entry.row, rank:index + 1,
    rankingEvidence:{
      policyVersion:1,
      basis:entry.observed.trusted ? 'statistics' : 'mechanism-fallback',
      ...entry.observed,
      winRateGroup:entry.group, winRateGroupAnchor:entry.anchor,
      closeWinRateGap:config.closeWinRateGap, minSampleCount:config.minSampleCount,
      highFlatAttackDamage:config.highFlatAttackDamage,
      ...entry.features,
      mechanismScore:entry.mechanismScore,
      tieBreak:entry.observed.trusted
        ? ['anchored-win-rate-group', 'category', 'numeric-kind', 'mechanism-score', 'win-rate', 'pick-rate-last', 'input-order']
        : ['mechanism-score', 'category', 'numeric-kind', 'pick-rate-last', 'input-order'],
      pickRateOrder:config.pickRateOrder,
    },
  }));
}
