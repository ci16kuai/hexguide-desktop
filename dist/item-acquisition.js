// Mayhem 16.21 acquisition rules, shared by the full plan and compact sidebar.
// A catalog's purchasable flag also covers distributed rewards; it is not proof
// that a reward can be bought. Recipe order below is a set of requirements,
// never an invented observed purchase sequence.
const rule = value => Object.freeze({...value, rewardIds:Object.freeze(value.rewardIds), ingredients:Object.freeze(value.ingredients)});
export const QUEST_ITEM_RULES = Object.freeze([
  rule({augmentId:'quest_wooglets_witchcap',gameDataId:1156,rewardId:'228002',rewardIds:['228002'],kind:'recipe',ingredients:['3157','3089']}),
  rule({augmentId:'ultra_hydra',gameDataId:2141,rewardId:'226668',rewardIds:['226668'],kind:'recipe',ingredients:['3074','6698','3748']}),
  rule({augmentId:'void_immolation',gameDataId:1361,rewardId:'223069',rewardIds:['223069'],kind:'recipe',ingredients:['3068','6664']}),
  rule({augmentId:'quest_urfs_champion',gameDataId:1154,rewardId:'994403',rewardIds:['4403','224403','664403','994403'],kind:'takedowns',ingredients:[]}),
]);
const byReward = new Map(QUEST_ITEM_RULES.flatMap(rule => rule.rewardIds.map(id => [id,rule])));
export const questRewardRule = itemId => byReward.get(String(itemId)) || null;
export const hasItemQuest = (owned, gameDataId) => (Array.isArray(owned) ? owned : []).some(augment =>
  QUEST_ITEM_RULES.some(rule => rule.gameDataId === gameDataId && (augment?.id === rule.augmentId
    || Number(augment?.gameDataId ?? augment?.sourceAugmentId) === rule.gameDataId)));
const clean = value => typeof value === 'string' ? value.replace(/<[^>]*>/g,'').trim().slice(0,100) : '';

// Only live, fresh, matching observations can confirm task progress. Null means
// unknown, which must not be mistaken for an observed empty inventory.
export function questInventoryIds(live, championId, now) {
  const observed = Date.parse(live?.observedAt || '');
  if (!championId || live?.championId !== championId || live.connection?.status !== 'connected'
    || live.stage !== 'live' || live.phase !== 'InProgress' || live.championSource !== 'live-client'
    || live.mode?.known !== true || live.mode.isMayhem !== true
    || !/^[A-Za-z0-9_-]{1,40}$/.test(String(live.gameId ?? '')) || /^0+$/.test(String(live.gameId))
    || !Number.isFinite(observed) || !Number.isFinite(now) || now-observed > 10000 || observed-now > 5000
    || !Array.isArray(live.items)) return null;
  return live.items.slice(0,20).filter(row => /^[1-9]\d{0,8}$/.test(String(row?.id ?? row?.itemID ?? ''))
    && (row.count == null || Number.isSafeInteger(row.count) && row.count > 0 && row.count <= 99))
    .map(row => String(row.id ?? row.itemID));
}

/** Caller supplies only confirmed choices and valid observed inventory IDs. */
export function buildItemQuestPlans({owned = [], inventoryIds = [], catalog = new Map()} = {}) {
  const inventoryKnown = inventoryIds !== null;
  const held = new Set(inventoryIds || []), seen = new Set();
  return owned.flatMap(augment => {
    const rule = QUEST_ITEM_RULES.find(rule => !seen.has(rule.augmentId) && hasItemQuest([augment],rule.gameDataId));
    if (!rule) return [];
    seen.add(rule.augmentId);
    const reward = catalog.get(rule.rewardId);
    if (!reward) return [];
    const earned = rule.rewardIds.some(id => held.has(id));
    const ingredients = rule.ingredients.map(id => ({id,name:clean(catalog.get(id)?.name) || '前置装备资料暂缺',owned:earned || held.has(id)}));
    const status = !inventoryKnown ? 'unobserved' : earned ? 'earned' : rule.kind === 'recipe' && ingredients.every(item => item.owned) ? 'awaiting-reward' : 'building';
    const rewardName = clean(reward.name), rewardIcon = /^https:\/\//i.test(reward.icon || '') ? reward.icon : '';
    const routeText = rule.kind === 'recipe'
      ? ingredients.map(item => item.name + (item.owned ? '（已有）' : '')).join(' + ') + ' → ' + rewardName
      : '完成参杀任务 → ' + rewardName + '（任务奖励，无购买配方）';
    const progressText = !inventoryKnown ? '等待本局背包确认任务进度。' : earned ? '已确认获得任务奖励。' : status === 'awaiting-reward' ? '前置已齐，等待游戏发放奖励。'
      : rule.kind === 'takedowns' ? '任务进度以游戏面板为准。' : '逐件完成缺少的前置成装。';
    return [{augmentId:rule.augmentId,augmentName:clean(augment.name),rewardId:rule.rewardId,rewardName,rewardIcon,
      kind:rule.kind,status,ingredients,routeText,progressText}];
  }).slice(0,QUEST_ITEM_RULES.length);
}

export function withItemQuestGuidance(result, quests) {
  if (!quests.length) return result;
  const guidance = quests.map(quest => quest.status === 'earned' ? `${quest.rewardName}：已获得。`
    : `${quest.routeText}。${quest.progressText}`).join('\n');
  if (result.status !== 'ready') return {...result,questPlans:quests,message:[result.message,guidance].filter(Boolean).join('\n')};
  const reasons = [result.reasons?.[0],guidance].filter(Boolean);
  return {...result,questPlans:quests,reasons,reason:reasons.join(' ')};
}
