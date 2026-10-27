import {enrichData, getChampionTags} from '../dist/engine.js';
import {selectBuildEvidence, mixBuildItemEvidence} from '../dist/build-evidence.js';
import {describeEnemies, shortEquipmentEffect} from '../dist/adaptive.js';
import {questRewardRule, hasItemQuest, buildItemQuestPlans, withItemQuestGuidance, questInventoryIds} from '../dist/item-acquisition.js';

// Product ranking weights, not measured win-rate gains. Keep this policy separate
// from the full application's comparison plan and its list ordering.
export const NEXT_ITEM_POLICY = Object.freeze({version:3, rawAgeMs:10000, enemyAgeMs:10000,
  futureToleranceMs:5000, rankWeight:16, winRateWeight:50, nextRouteBonus:24,
  referenceNextBonus:12, delayedItemPenalty:12, contextLimit:18, recipeLimit:6, minimumSamples:200});
const list = value => Array.isArray(value) ? value : [];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() : '';
const id = value => /^(?:[1-9]\d{0,8})$/.test(String(value ?? '')) ? String(value) : '';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const has = (item, tag) => list(item?.tags).includes(tag);
const stat = (item, key) => finite(item?.stats?.[key]) && item.stats[key] > 0 ? item.stats[key] : 0;
const gold = item => finite(item?.gold?.total) && item.gold.total > 0 && item.gold.total <= 30000 ? item.gold.total : 0;
const time = value => finite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (value, now, age) => Number.isFinite(time(value)) && now - time(value) <= age && time(value) - now <= NEXT_ITEM_POLICY.futureToleranceMs;
const gameId = value => (typeof value === 'string' || Number.isSafeInteger(value))
  && /^[A-Za-z0-9_-]{1,40}$/.test(String(value)) && !/^0+$/.test(String(value));
const FALLBACK_ITEMS = ['3153','3124','3072','6333','3156','3091','3031','6672','3089','3157','3102','6653','3135','3165','3084','3068','4401','3143','3075','3107','3504','6617','3190','6620','4005','3047','3111'];
// Known shop-exclusive families. Component ownership does not block its upgrade.
const FAMILIES = [
  ['3156','3053','6673'], ['3036','3033','6694'], ['3135','3137'],
  ['3003','3040','3004','3042','3119','3121'], ['3074','3748','6698'],
];

function catalogOf(value) {
  const data = value?.data || value || {};
  return data instanceof Map ? data : new Map(Array.isArray(data)
    ? data.filter(record).map(item => [String(item.id), item]) : Object.entries(data));
}

function shopItem(item, champion) {
  return item && !questRewardRule(item.id) && item.inStore !== false && item.gold?.purchasable === true && gold(item) > 0
    && (!item.requiredChampion || text(item.requiredChampion).toLowerCase() === text(champion?.id).toLowerCase())
    && (!record(item.maps) || !Object.keys(item.maps).length || item.maps['12'] === true)
    && !has(item, 'Consumable') && !has(item, 'Trinket');
}

function completed(item, catalog, champion) {
  if (!shopItem(item, champion)) return false;
  if (has(item, 'Boots')) return gold(item) >= 900;
  if (gold(item) < 1800) return false;
  // A purchasable map-12 upgrade proves this is a component. Non-purchasable
  // transformations and off-map variants do not disqualify a completed item.
  return !list(item.into).some(next => {
    const upgrade = catalog.get(String(next));
    return shopItem(upgrade, champion) && gold(upgrade) > gold(item)
      && list(upgrade.from).map(String).includes(String(item.id));
  });
}

export function isPurchaseTarget(itemId, champion, itemsCatalog) {
  const catalog = catalogOf(itemsCatalog);
  return Boolean(champion?.id && typeof itemId === 'string' && id(itemId) && completed(catalog.get(itemId),catalog,champion));
}

function ancestorIds(itemId, catalog, visited = new Set(), depth = 0) {
  if (depth > 12 || visited.has(itemId) || visited.size >= 128) return visited;
  visited.add(itemId);
  const ingredients = questRewardRule(itemId)?.ingredients || list(catalog.get(itemId)?.from);
  for (const previous of ingredients.slice(0, 12)) ancestorIds(String(previous), catalog, visited, depth + 1);
  return visited;
}

function inventoryOf(live, catalog) {
  const rows = list(live.items).slice(0, 20).filter(row => id(row?.id ?? row?.itemID)
    && (row.count == null || Number.isSafeInteger(row.count) && row.count > 0 && row.count <= 99))
    .map(row => ({id:id(row.id ?? row.itemID), definition:catalog.get(id(row.id ?? row.itemID))}));
  const owned = new Set(rows.map(row => row.id));
  const satisfied = new Set();
  for (const itemId of owned) for (const previous of ancestorIds(itemId, catalog)) satisfied.add(previous);
  return {rows, owned, satisfied, occupied:rows.filter(row => !has(row.definition, 'Trinket')).length};
}

function recipeProgress(itemId, inventory, catalog) {
  const available = new Map();
  for (const row of inventory.rows) available.set(row.id, (available.get(row.id) || 0) + 1);
  let value = 0, consumed = 0, visited = 0;
  const walk = (wanted, branch = new Set(), depth = 0) => {
    if (depth > 12 || visited++ > 128 || branch.has(wanted)) return;
    if ((available.get(wanted) || 0) > 0) {
      available.set(wanted, available.get(wanted) - 1);
      value += gold(catalog.get(wanted)); consumed++; return;
    }
    const nextBranch = new Set(branch).add(wanted);
    for (const child of list(catalog.get(wanted)?.from).slice(0, 12)) walk(String(child), nextBranch, depth + 1);
  };
  for (const child of list(catalog.get(itemId)?.from).slice(0, 12)) walk(String(child));
  const total = gold(catalog.get(itemId));
  return {consumed, value:Math.min(total, value), ratio:total ? clamp(value / total, 0, 1) : 0};
}

function profileOf(champion, owned, route) {
  const tags = new Set(getChampionTags(champion));
  const effects = owned.map(augment => text(augment.description)).join('\n');
  const noAttacks = /(?:无法|不能|不可)(?:进行|使用)?(?:普攻|普通攻击|基本攻击)|cannot (?:use |perform )?(?:basic )?attack/i.test(effects);
  const noCrit = /(?:你|伤害)(?:将|的伤害)?(?:无法|不能|不可)暴击|(?:your damage|you) cannot (?:crit|critically strike)/i.test(effects);
  const grantsAd = /(?:获得|增加|提升|提高).{0,15}攻击力|(?:转换|转化|转为).{0,15}攻击力/.test(effects);
  const grantsAp = /(?:获得|增加|提升|提高).{0,15}法术强度|(?:转换|转化|转为).{0,15}法术强度/.test(effects);
  const physical = tags.has('physical') || grantsAd || ['attack','crit'].includes(route);
  const spell = tags.has('magic') || grantsAp || route === 'spell';
  const fighter = [...list(champion.roles), ...list(champion.tags)].some(role => /^(fighter|战士)$/i.test(role));
  return {tags, noAttacks, noCrit, physical, spell, fighter, attack:!noAttacks && tags.has('attack'),
    tank:route === 'tank' || tags.has('defense'), support:route === 'support' || tags.has('heal') || tags.has('shield'),
    hydraQuest:hasItemQuest(owned,2141),
    affinitySource:'champion-and-confirmed-mechanisms'};
}

function allyUtility(item) {
  return /(?:友军|友方|盟友).{0,24}(?:治疗|护盾)|(?:治疗|护盾).{0,24}(?:友军|友方|盟友)/.test(text(item?.description));
}

function profileWithEvidence(profile, evidence, orders, catalog) {
  // Missing mechanism tags are not a scaling prohibition. Two same-direction
  // items in a verified hero core establish a gear direction; one off-role
  // high-win-rate outlier does not. No champion-ID exceptions are required.
  const cores = [...list(evidence.builds).filter(build => build.sampleCount >= NEXT_ITEM_POLICY.minimumSamples)
    .map(build => build.route?.items || build.items), ...orders.map(order => order.items)];
  let ad = false, ap = false;
  for (const ids of cores) {
    const definitions = list(ids).map(itemId => catalog.get(String(itemId))).filter(Boolean);
    const physical = definitions.filter(item => stat(item,'FlatPhysicalDamageMod') > 0).length;
    const magic = definitions.filter(item => stat(item,'FlatMagicDamageMod') > 0).length;
    if (physical >= 2 && magic === 0) ad = true;
    if (magic >= 2 && physical === 0) ap = true;
  }
  return {...profile,physical:profile.physical || ad,spell:profile.spell || ap,
    affinitySource:ad || ap ? 'hero-mechanisms-and-observed-cores' : profile.affinitySource};
}

function requiresAttacks(item) {
  // Ally-triggered buffs still work when the holder cannot attack; their own
  // attack-speed benefit is not the entire item's function.
  if (allyUtility(item)) return false;
  if (has(item, 'AttackSpeed') || has(item, 'OnHit')) return true;
  const clauses = text(item.description).split(/[，,。；;\n]/).filter(clause =>
    !/(?:被|受到|承受|所受|来自|即将到来).{0,32}(?:普攻|普通攻击|攻击)|(?:普攻|普通攻击).{0,16}(?:对你|对自身|对自己)/.test(clause));
  return /普攻|普通攻击|基本攻击|攻击特效|basic attacks?|on[- ]hit/i.test(clauses.join('。'));
}

function compatible(itemId, item, inventory, profile, catalog, champion, retainTarget = false) {
  if (!completed(item, catalog, champion) || inventory.satisfied.has(itemId)) return false;
  if (profile.noAttacks && requiresAttacks(item)) return false;
  if (profile.noCrit && (has(item, 'CriticalStrike') || stat(item, 'FlatCritChanceMod'))) return false;
  if (has(item, 'Boots') && inventory.rows.some(row => has(row.definition, 'Boots') && gold(row.definition) >= 900)) return false;
  if (FAMILIES.some(family => !(profile.hydraQuest && family.includes('3074'))
    && family.includes(itemId) && family.some(other => inventory.satisfied.has(other)))) return false;
  // Affinity inferred from current statistical cores helps choose a new target;
  // it is not a shop/mechanism prohibition on an already committed purchase.
  if (!retainTarget && !profile.physical && stat(item, 'FlatPhysicalDamageMod') && !stat(item, 'FlatMagicDamageMod')) return false;
  if (!retainTarget && !profile.spell && stat(item, 'FlatMagicDamageMod') && !stat(item, 'FlatPhysicalDamageMod')) return false;
  if (!retainTarget && profile.tags.has('noMana') && (has(item, 'Mana') || has(item, 'ManaRegen'))
    && !stat(item, 'FlatMagicDamageMod') && !stat(item, 'FlatPhysicalDamageMod') && !stat(item, 'FlatHPPoolMod')) return false;
  return true;
}

const counter = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
function performanceWeight(performance) {
  if (!record(performance)) return {bonus:0, known:false};
  const kills = counter(performance.kills, 1000), deaths = counter(performance.deaths, 1000), assists = counter(performance.assists, 1000);
  // Missing deaths are not treated as zero. CS is retained by the collector but
  // is not a cross-champion measure of combat danger in this policy.
  const bonus = kills === null ? 0 : deaths === null ? Math.min(.5, kills * .025)
    : Math.min(1.2, kills / (deaths + 2) * .24);
  return {bonus:Math.min(1.4, bonus + (assists === null ? 0 : Math.min(.2, assists * .01))), known:kills !== null || deaths !== null || assists !== null};
}

function enemyFacts({champion, live, champions, itemsCatalog, catalog, now, loading}) {
  const empty = {status:'unavailable', opponents:0, frontline:0, physical:0, magic:0, unknownDamage:0, armor:0, magicResist:0,
    healing:0, strongPhysical:null, strongMagic:null, performanceObserved:false};
  if (!fresh(live.teams?.observedAt, now, NEXT_ITEM_POLICY.enemyAgeMs)) return {...empty,status:'stale'};
  const context = describeEnemies({champion, live, champions, itemsCatalog, now});
  if (context.status !== 'detected') return {...empty,status:context.status};
  const facts = {...empty,status:'detected'};
  const seen = new Set();
  for (const enemy of context.champions) {
    if (!enemy.id || seen.has(enemy.id)) continue;
    seen.add(enemy.id); facts.opponents++;
    const tags = new Set(enemy.tags), items = enemy.items.map(item => catalog.get(item.id)).filter(Boolean);
    const raw = list(live.teams?.enemies).find(row => row.championId === enemy.id);
    const performance = loading ? {bonus:0,known:false} : performanceWeight(raw?.performance);
    facts.performanceObserved ||= performance.known;
    const level = !loading && finite(raw?.level) && raw.level >= 1 && raw.level <= 30
      && finite(live.level) && live.level >= 1 && live.level <= 30 ? clamp((raw.level - live.level) * .12, -.24, .36) : 0;
    const investment = loading ? 0 : Math.min(.35, items.reduce((sum,item) => sum + gold(item), 0) / 15000);
    const weight = clamp(1 + level + investment + performance.bonus, .75, 3.2);
    const hp = items.reduce((sum,item) => sum + stat(item, 'FlatHPPoolMod'), 0);
    if (tags.has('defense') || tags.has('health') || hp >= 350) facts.frontline++;
    if (items.some(item => stat(item, 'FlatArmorMod'))) facts.armor++;
    if (items.some(item => stat(item, 'FlatSpellBlockMod'))) facts.magicResist++;
    if (tags.has('heal') || tags.has('sustain') || items.some(item => has(item, 'LifeSteal') || has(item, 'SpellVamp'))) facts.healing++;
    const ad = tags.has('physical') || items.some(item => stat(item, 'FlatPhysicalDamageMod'));
    const ap = tags.has('magic') || items.some(item => stat(item, 'FlatMagicDamageMod'));
    facts.physical += ad ? weight / (ap ? 2 : 1) : 0;
    facts.magic += ap ? weight / (ad ? 2 : 1) : 0;
    if (!ad && !ap) facts.unknownDamage += weight;
    if (performance.known && weight >= 1.8) {
      const threat = {championId:enemy.id,name:text(enemy.name).slice(0,50),weight};
      if (ad && (!facts.strongPhysical || weight > facts.strongPhysical.weight)) facts.strongPhysical = threat;
      if (ap && (!facts.strongMagic || weight > facts.strongMagic.weight)) facts.strongMagic = threat;
    }
  }
  return facts;
}

function adjustment(item, profile, facts) {
  const reasons = [], description = text(item.description);
  let bonus = 0, threat = null;
  if (facts.status !== 'detected') return {bonus,reasons};
  // A holder-health proc (for example Heartsteel) is not enemy-health damage.
  const targetHealth = /(?:敌人|敌方|目标).{0,30}(?:当前|最大|额外)生命值/.test(description)
    && !/(?:你的|自身的|自己的).{0,8}(?:当前|最大)生命值.{0,12}(?:物理|魔法)伤害/.test(description);
  if (facts.frontline >= 2 && targetHealth && (profile.attack && requiresAttacks(item) || profile.spell && /技能.{0,15}灼烧/.test(description))) {
    bonus += Math.min(13, 7 + facts.frontline * 1.5);
    reasons.push(`已读取${facts.frontline}位前排或生命值投入者，这件装备的目标生命值相关效果适合当前触发方式。`);
  }
  // Missing damage evidence remains in the denominator: one known caster and
  // two unclassified opponents cannot imply an overwhelmingly magical team.
  const total = facts.physical + facts.magic + facts.unknownDamage;
  const physicalShare = total ? facts.physical / total : 0, magicShare = total ? facts.magic / total : 0;
  const armorFit = stat(item,'FlatArmorMod') && (profile.physical && profile.fighter && stat(item,'FlatPhysicalDamageMod')
    || profile.spell && stat(item,'FlatMagicDamageMod') || profile.tank && stat(item,'FlatHPPoolMod') || profile.support && allyUtility(item));
  const magicFit = stat(item,'FlatSpellBlockMod') && (profile.physical && (stat(item,'FlatPhysicalDamageMod') || profile.attack && has(item,'OnHit'))
    || profile.spell && stat(item,'FlatMagicDamageMod') || profile.tank && stat(item,'FlatHPPoolMod') || profile.support && allyUtility(item));
  if (armorFit && (facts.strongPhysical || facts.opponents >= 2 && physicalShare >= .65)) {
    bonus += facts.strongPhysical ? 16 : 6;
    threat = facts.strongPhysical;
    reasons.push(facts.strongPhysical ? `从已读表现、等级与装备看，${facts.strongPhysical.name}的物理机制威胁值得兼顾；护甲同时保留适配的装备效果。`
      : '敌方可见机制与装备偏物理，兼顾护甲可补充当前路线的生存属性。');
  }
  if (magicFit && (facts.strongMagic || facts.opponents >= 2 && magicShare >= .65)) {
    bonus += facts.strongMagic ? 16 : 6;
    if (facts.strongMagic && (!threat || facts.strongMagic.weight > threat.weight)) threat = facts.strongMagic;
    reasons.push(facts.strongMagic ? `从已读表现、等级与装备看，${facts.strongMagic.name}的魔法机制威胁值得兼顾；此件兼有适配属性与魔抗。`
      : '敌方可见机制与装备偏魔法，兼顾魔抗可补充当前路线的生存属性。');
  }
  if (facts.armor >= 2 && profile.physical && /\d+%护甲穿透/.test(description)
    || facts.magicResist >= 2 && profile.spell && /\d+%法术穿透/.test(description)) {
    bonus += 7; reasons.push('多位敌方已投入对应抗性装备，百分比穿透可供当前输出方向比较。');
  }
  if (facts.healing >= 2 && /重伤/.test(description) && !/被.{0,12}攻击/.test(description)) {
    bonus += 5; reasons.push('敌方有多个治疗或战斗续航来源；重伤仍需满足这件装备的伤害触发条件。');
  }
  return {bonus:Math.min(NEXT_ITEM_POLICY.contextLimit,bonus),reasons,threatChampionId:threat?.championId || null};
}

function fallbackScore(item, profile) {
  return (profile.physical && stat(item,'FlatPhysicalDamageMod') ? 10 : 0)
    + (profile.attack && (has(item,'AttackSpeed') || has(item,'OnHit')) ? 7 : 0)
    + (profile.spell && stat(item,'FlatMagicDamageMod') ? 10 : 0)
    + (profile.tank && stat(item,'FlatHPPoolMod') ? 8 : 0)
    + (profile.support && (has(item,'HealAndShieldPower') || has(item,'ManaRegen')) ? 8 : 0)
    + (profile.support && allyUtility(item) ? 8 : 0)
    + (has(item,'Boots') ? -8 : 0);
}

function referenceOrders(entry, champion, patch, now) {
  const rows = [];
  const sources = [
    [entry?.ordinaryAram,'aram',entry?.referenceStatus],
    [entry?.summonersRift,'summoners-rift',entry?.referenceStatus],
    [entry?.orderReference,entry?.orderReference?.mode,entry?.orderReferenceStatus],
  ];
  for (const [source, mode, status] of sources) {
    if (!['aram','summoners-rift'].includes(mode) || status != null && status !== 'ready'
      || source?.source !== 'OP.GG' || source.comparable !== true || source.mode !== mode
      || source.championId !== champion.id || source.patch !== patch
      || !fresh(source.observedAt,now,24*60*60*1000)) continue;
    for (const row of list(source.buildOrders).slice(0,128)) {
      const items = list(row?.items);
      if (row?.orderKind !== 'core-item-sequence' || items.length !== 3 || items.some(value => typeof value !== 'string' || !id(value))
        || new Set(items).size !== 3 || !Number.isSafeInteger(row.sampleCount) || row.sampleCount < NEXT_ITEM_POLICY.minimumSamples
        || !finite(row.winRate) || row.winRate < 0 || row.winRate > 1) continue;
      rows.push({items:[...items],sampleCount:row.sampleCount,winRate:row.winRate,orderKind:row.orderKind,
        source:'OP.GG',mode,sourceUrl:text(source.sourceUrl).slice(0,300),observedAt:source.observedAt});
    }
  }
  return rows;
}

const baseResult = (status, stage, message, evidence = {}) => ({status,stage,item:null,reasons:[],reason:'',evidenceLabel:'',message,
  evidence:{scope:'none',source:'',status:'unavailable',conditionAugmentId:null,sampleCount:null,modeWeights:{mayhem:0,aram:0,summonersRift:0},...evidence}});

/** Pure sidebar policy. Caller supplies confirmed definitions, never OCR offers. */
export function buildNextItemRecommendation({champion, owned = [], route = 'auto', live = {}, augments = [], champions = [], itemsCatalog = {}, recommendationData = null, plan = null, targetItemId = null, now = Date.now()} = {}) {
  now = time(now);
  const loading = live.stage === 'loading';
  const stage = loading ? 'loading-preview' : 'live';
  const waiting = message => baseResult('waiting','waiting',message);
  if (!champion?.id || live.connection?.status !== 'connected' || live.mode?.known !== true || live.mode.isMayhem !== true
    || live.championId !== champion.id || !gameId(live.gameId)) return waiting('等待确认本局海克斯大乱斗英雄与对局。');
  if (plan?.gameId != null && String(plan.gameId) !== String(live.gameId)
    || plan?.championId != null && plan.championId !== champion.id) return waiting('等待本局推荐状态同步。');
  if (!Number.isFinite(now) || !fresh(live.observedAt, now, NEXT_ITEM_POLICY.rawAgeMs)) return baseResult('stale','waiting','实时数据已过期，等待本局重新读取。');
  if (loading ? live.championSource !== 'loading-screen' || !['GameStart','InProgress'].includes(live.phase)
    || live.teams?.source !== 'loading-roster' || live.teams?.status !== 'detected' || !fresh(live.teams.observedAt,now,NEXT_ITEM_POLICY.enemyAgeMs)
    : live.stage !== 'live' || live.phase !== 'InProgress' || live.championSource !== 'live-client'
      || !finite(live.gameTime) || live.gameTime < 0) return waiting('等待当前阶段的有效对局资料。');
  const catalog = catalogOf(itemsCatalog);
  const definitions = loading ? [] : enrichData({augments:list(owned).filter(record)}).augments;
  let profile = profileOf(champion,definitions,loading ? 'auto' : route);
  const inventory = inventoryOf(loading ? {} : live,catalog);
  const questInventory = questInventoryIds(live,champion.id,now);
  const quests = buildItemQuestPlans({owned:definitions,inventoryIds:questInventory,catalog});
  if (!loading && questInventory === null) return withItemQuestGuidance(waiting('等待有效的本局背包资料。'),quests);
  const activeQuest = quests.find(quest => quest.kind === 'recipe' && quest.status !== 'earned') || null;
  const requiredIds = activeQuest ? activeQuest.ingredients.filter(item => !item.owned).map(item => item.id) : [];
  // Components (even the complete recipe) and available gold never prove a
  // purchase. Only the target ID, or an observed upgrade containing it in its
  // recipe ancestry, can release a committed target. Invalid/stale snapshots
  // return above without progress, so they cannot clear the caller's target.
  const target = loading || questRewardRule(targetItemId) ? '' : id(targetItemId);
  const purchaseProgress = target ? {targetItemId:target,status:inventory.satisfied.has(target) ? 'completed' : 'building'} : null;
  const unfinishedTarget = purchaseProgress?.status === 'building' ? target : null;
  const finish = result => withItemQuestGuidance(purchaseProgress ? {...result,purchaseProgress} : result,quests);
  if (!unfinishedTarget && activeQuest?.status === 'awaiting-reward') return finish(baseResult('waiting',stage,
    '任务前置已齐，确认获得任务奖励后再继续推荐。',{status:'quest-reward-pending'}));
  const completedCount = inventory.rows.filter(row => questRewardRule(row.id) || completed(row.definition,catalog,champion)).length;
  if (completedCount >= 6) return finish(baseResult(unfinishedTarget ? 'inventory-full' : 'complete',stage,
    unfinishedTarget ? '装备槽已满，当前目标尚未完成；暂不推进下一件。' : '六个装备槽已有成装，暂不建议继续购买。'));
  const patch = recommendationData?.patch || '16.21';
  const selected = selectBuildEvidence(recommendationData,{champion,owned:definitions,augments,patch});
  const freshReference = recommendationData?.referenceStatus == null || recommendationData.referenceStatus === 'ready';
  const mixed = mixBuildItemEvidence(selected,{ordinaryAram:freshReference ? recommendationData?.ordinaryAram : null,
    summonersRift:freshReference ? recommendationData?.summonersRift : null,patch,minimumSamples:NEXT_ITEM_POLICY.minimumSamples});
  const orders = referenceOrders(recommendationData,champion,patch,now);
  // Explicitly selected quests provide a verified acquisition requirement even
  // when empirical purchase-order data is unavailable. Ordinary builds retain
  // their original reference-order gate. An earlier committed ordinary target
  // is still completed first; accepting a quest never skips that purchase.
  const pursuingQuest = activeQuest && (!unfinishedTarget || requiredIds.includes(unfinishedTarget));
  if (!orders.length && !pursuingQuest) return finish(baseResult('waiting',stage,'等待可核验的普通 ARAM／召唤师峡谷核心装备顺序，再给出下一件成装。',
    {scope:selected.scope,source:selected.source,status:'order-data-pending',mayhemStatus:selected.status,
      conditionAugmentId:selected.conditionAugmentId,orderStatus:'unavailable',orderReference:null}));
  profile = profileWithEvidence(profile,selected,orders,catalog);
  if (unfinishedTarget && !compatible(unfinishedTarget,catalog.get(unfinishedTarget),inventory,profile,catalog,champion,true)) {
    return finish(baseResult('waiting',stage,'当前目标与已选海克斯或装备限制不兼容，暂不推进下一件；请核对当前路线与已选记录。',
      {status:'target-incompatible',conditionAugmentId:selected.conditionAugmentId}));
  }
  const facts = enemyFacts({champion,live,champions,itemsCatalog,catalog,now,loading});
  const statisticRows = new Map(mixed.items.map(row => [row.id,row]));
  let candidates = [...statisticRows.keys()].filter(itemId => compatible(itemId,catalog.get(itemId),inventory,profile,catalog,champion));
  let statistics = candidates.length > 0;
  // A consumed empirical catalogue represents completion, not permission to
  // reintroduce unrelated alternatives after the observed build is finished.
  if (!activeQuest && !unfinishedTarget && !candidates.length && statisticRows.size && [...statisticRows.keys()].every(itemId => inventory.satisfied.has(itemId))) {
    return finish(baseResult('complete',stage,'已持有所发布样本中的可继续装备，等待新的已选或装备资料。',
      {scope:selected.scope,source:selected.source,status:selected.status,conditionAugmentId:selected.conditionAugmentId}));
  }
  if (!statistics) {
    candidates = [...new Set([...FALLBACK_ITEMS,
      ...orders.flatMap(order => order.items),
      ...list(plan?.buildItems).map(item => id(item?.id)),
      ...list(plan?.choices).flatMap(choice => list(choice.items).map(item => id(item?.id)))])]
      .filter(itemId => compatible(itemId,catalog.get(itemId),inventory,profile,catalog,champion));
  }
  if (pursuingQuest) {
    candidates = requiredIds.filter(itemId => compatible(itemId,catalog.get(itemId),inventory,profile,catalog,champion,true));
    if (candidates.length !== requiredIds.length) return finish(baseResult('waiting',stage,'当前任务前置受到装备或已选机制限制，等待核对后继续。',
      {status:'quest-ingredient-incompatible',conditionAugmentId:selected.conditionAugmentId}));
  }
  // A statistics refresh or newly confirmed condition can omit a still-valid
  // target. Retain its mechanism guidance without borrowing another item's stats.
  if (unfinishedTarget && !candidates.includes(unfinishedTarget)) candidates.push(unfinishedTarget);
  const candidateSet = new Set(candidates);
  const routes = selected.builds.flatMap(build => {
    const order = build.route?.items;
    if (!Array.isArray(order) || !order.length || !order.every(itemId => inventory.satisfied.has(itemId) || candidateSet.has(itemId))) return [];
    const next = order.find(itemId => !inventory.satisfied.has(itemId));
    // A later completed route item proves purchases deviated; do not pretend a
    // former item is the observed next step. Such candidates retain item data.
    const position = order.indexOf(next);
    if (!next || order.slice(position + 1).some(itemId => inventory.satisfied.has(itemId))) return [];
    return [{next,order,winRate:build.winRate,sampleCount:build.sampleCount,
      matchCount:order.filter(itemId => inventory.satisfied.has(itemId)).length,
      score:order.reduce((sum,itemId) => sum + (statisticRows.get(itemId)?.recommendationScore || 0),0) / order.length}];
  }).sort((a,b) => b.matchCount-a.matchCount || b.score-a.score || b.winRate-a.winRate || b.sampleCount-a.sampleCount || a.order.join(',').localeCompare(b.order.join(',')));
  const preferredRoute = routes[0] || null;
  const candidateDetails = new Map(candidates.map(itemId => {
    const item = catalog.get(itemId), observed = statisticRows.get(itemId) || null;
    const recipe = recipeProgress(itemId,inventory,catalog), context = adjustment(item,profile,facts);
    // Holding an expensive late item is survival-conditioned. Saturating its
    // empirical score prevents a raw 90% outlier from erasing purchase order.
    const base = observed ? 50 + observed.recommendationScore * NEXT_ITEM_POLICY.rankWeight + (clamp(observed.winRate,.45,.6) - .5) * NEXT_ITEM_POLICY.winRateWeight : fallbackScore(item,profile);
    const recipeBonus = recipe.ratio * NEXT_ITEM_POLICY.recipeLimit;
    return [itemId,{itemId,item,observed,recipe,context,base,recipeBonus}];
  }));
  const compatibleOrders = orders.map(order => {
    const next = order.items.find(itemId => !inventory.satisfied.has(itemId) && candidateSet.has(itemId));
    const matchCount = order.items.filter(itemId => inventory.satisfied.has(itemId)).length;
    const candidate = candidateDetails.get(next);
    const compatibleCount = order.items.filter(itemId => inventory.satisfied.has(itemId) || candidateSet.has(itemId)).length;
    const mainRouteOverlap = preferredRoute ? order.items.filter(itemId => preferredRoute.order.includes(itemId)).length : 0;
    // Count is a small reliability tie-break, not a universal popular-build
    // lock. Conditioned Mayhem route overlap and the next item's live fit choose
    // between the source's separately observed, supported sequences.
    const fit = candidate ? candidate.base + candidate.context.bonus + candidate.recipeBonus
      + mainRouteOverlap * (selected.conditionAugmentId ? 6 : 2) + compatibleCount * 2
      + Math.min(3,Math.log10(order.sampleCount / NEXT_ITEM_POLICY.minimumSamples + 1)) : -Infinity;
    return {...order,next:next || null,matchCount,
      fit,
      disposition:matchCount === order.items.length ? 'completed-core' : next ? 'next-core' : 'different-core'};
  });
  const usableOrders = compatibleOrders.filter(order => order.disposition !== 'different-core');
  const orderPool = usableOrders.length ? usableOrders : compatibleOrders;
  const aramOrders = orderPool.filter(order => order.mode === 'aram');
  const preferredOrder = (aramOrders.length ? aramOrders : orderPool.filter(order => order.mode === 'summoners-rift'))
    .sort((a,b) => b.matchCount-a.matchCount || b.fit-a.fit || b.sampleCount-a.sampleCount || b.winRate-a.winRate || a.items.join(',').localeCompare(b.items.join(',')))[0] || null;
  let rows = [...candidateDetails.values()].map(candidate => {
    const {itemId,observed,context,recipe,base,recipeBonus} = candidate;
    const nextInRoute = Boolean(observed && preferredRoute?.next === itemId);
    // One sequence bonus, not two independent votes. A verified reference core
    // sequence supplies timing; Mayhem still owns item suitability and can alter
    // it through condition-specific rankings, constraints and bounded context.
    const nextInReference = preferredOrder?.next === itemId;
    const routeBonus = preferredOrder?.next ? nextInReference ? NEXT_ITEM_POLICY.referenceNextBonus : nextInRoute ? 4 : 0
      : nextInRoute ? NEXT_ITEM_POLICY.nextRouteBonus : 0;
    const timingPenalty = preferredOrder?.next && !nextInReference && !nextInRoute && context.bonus < 8 && recipe.ratio < .5
      ? NEXT_ITEM_POLICY.delayedItemPenalty : 0;
    return {...candidate,nextInRoute,nextInReference,routeBonus,timingPenalty,score:base + routeBonus + recipeBonus + context.bonus - timingPenalty};
  });
  if (inventory.occupied >= 6) {
    rows = rows.filter(row => row.recipe.consumed > 0);
    if (!rows.length || unfinishedTarget && !rows.some(row => row.itemId === unfinishedTarget)) return finish(baseResult('inventory-full',stage,
      unfinishedTarget ? '装备槽已满，当前目标没有可继续合成的已有组件；暂不推进下一件。' : '装备槽已满；当前没有可用已有组件直接推进的成装。'));
  }
  rows.sort((a,b) => b.score-a.score || (b.observed?.sampleCount || 0)-(a.observed?.sampleCount || 0) || a.itemId.localeCompare(b.itemId));
  const chosen = unfinishedTarget ? rows.find(row => row.itemId === unfinishedTarget) : rows[0];
  if (!chosen) return finish(baseResult('waiting',stage,'当前约束下暂无可靠的下一件成装。',
    {status:selected.status,conditionAugmentId:selected.conditionAugmentId}));
  const {item,itemId,observed,context,recipe} = chosen;
  const conditionName = definitions.at(-1)?.name || '最近确认的海克斯';
  const basis = pursuingQuest ? `先完成已选「${activeQuest.augmentName || activeQuest.rewardName}」任务缺少的前置成装。`
    : observed ? selected.conditionAugmentId ? `沿用「${conditionName}」条件下的本英雄 Mayhem 装备样本${chosen.nextInRoute ? '与购买顺序' : ''}。`
    : `沿用本英雄 Mayhem 装备样本${chosen.nextInRoute ? '与购买顺序' : ''}。`
    : selected.status === 'condition-missing' ? '这条已选海克斯的条件样本暂缺，当前按兼容机制建议。' : 'Mayhem 装备样本暂不可用，当前按英雄与已选机制建议。';
  const orderName = preferredOrder?.mode === 'aram' ? '普通 ARAM' : '召唤师峡谷';
  const orderReason = preferredOrder ? preferredOrder.disposition === 'completed-core'
    ? `已完成 OP.GG ${orderName} 参考核心三件套，后续按当前条件选择；来源未提供第四件顺序。`
    : preferredOrder.disposition === 'different-core' ? `已核对 OP.GG ${orderName} 核心序列；当前已选与装备样本指向不同候选。`
    : chosen.nextInReference ? `顺序参考 OP.GG ${orderName} 的三件核心装备序列。`
      : `已参考 OP.GG ${orderName} 核心装备序列，当前条件调整了下一件。`
    : pursuingQuest ? '当前按任务要求选择前置；没有普通 ARAM／峡谷的可核验顺序，不声称统计出装顺序。'
      : '普通 ARAM／召唤师峡谷的可核验核心装备顺序暂缺。';
  const reasons = [`${basis} ${orderReason}`,context.reasons[0] || (recipe.consumed ? '已有组件可继续合成这件装备。' : '')].filter(Boolean).slice(0,2);
  const scope = observed ? selected.scope : pursuingQuest ? 'confirmed-quest' : 'mechanism-fallback';
  return finish({status:'ready',stage,item:{id:itemId,name:text(item.name).slice(0,100),icon:/^https:\/\//i.test(item.icon || '') ? item.icon : '',
    effect:shortEquipmentEffect(item.description),totalGold:gold(item)}, reasons,reason:reasons.join(' '),
    evidenceLabel:(pursuingQuest ? '已选任务 · 前置成装' : observed ? selected.conditionAugmentId ? 'Mayhem 单海克斯条件样本' : 'Mayhem 英雄装备样本' : '机制建议 · 条件统计未就绪')
      + (preferredOrder ? ` · ${orderName}顺序` : ' · 顺序参考暂缺'),
    message:(loading ? '入场后随已选海克斯、装备和敌方状态更新。' : '确认背包已拥有这件成装后，再推荐下一件；组件不算完成。')
      + (preferredOrder ? '' : '普通 ARAM／峡谷核心装备顺序参考暂缺。'),
    evidence:{policyVersion:NEXT_ITEM_POLICY.version,itemRulesVersion:'16.21',affinitySource:profile.affinitySource,
      scope,source:observed ? selected.source : pursuingQuest ? 'confirmed-quest' : 'catalog-mechanisms',status:selected.status,
      ...(pursuingQuest ? {questAugmentId:activeQuest.augmentId} : {}),
      conditionAugmentId:selected.conditionAugmentId,conditionNote:observed ? selected.conditionNote || '' : '',
      sampleCount:observed?.sampleCount ?? null,winRate:observed?.winRate ?? null,patch,
      modeWeights:observed ? observed.effectiveWeights : {mayhem:0,aram:0,summonersRift:0},mixedWinRate:null,
      sourceUrl:observed ? selected.sourceUrl : itemsCatalog?.meta?.sourceUrl || '',
      enemyStatus:facts.status,opponentCount:facts.opponents,frontlineCount:facts.frontline,performanceObserved:facts.performanceObserved,
      threatChampionId:context.threatChampionId || null,
      contextBonus:context.bonus,recipeValue:recipe.value,recipeBonus:chosen.recipeBonus,
      mayhemPurchaseOrder:preferredRoute ? [...preferredRoute.order] : [],
      purchaseOrder:chosen.nextInReference ? [...preferredOrder.items] : chosen.nextInRoute ? [...preferredRoute.order] : [],
      purchaseOrderSource:chosen.nextInReference ? 'OP.GG' : chosen.nextInRoute ? 'ARAMKit' : null,
      orderStatus:preferredOrder ? 'ready' : 'unavailable',
      orderReference:preferredOrder ? {source:preferredOrder.source,mode:preferredOrder.mode,sourceUrl:preferredOrder.sourceUrl,
        observedAt:preferredOrder.observedAt,orderKind:preferredOrder.orderKind,items:[...preferredOrder.items],
        sampleCount:preferredOrder.sampleCount,winRate:preferredOrder.winRate,disposition:preferredOrder.disposition,
        completedCore:preferredOrder.disposition === 'completed-core',adjusted:!chosen.nextInReference} : null,
      limitations:['单件与单海克斯样本不是多海克斯联合胜率。','阵容、装备与表现只作机制线索，未读取敌方实际伤害占比。']}});
}
