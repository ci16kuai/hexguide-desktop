import {QUEST_ITEM_RULES, questRewardRule} from '../dist/item-acquisition.js';

// These are qualitative purchase intents, never inferred win-rate gains. The
// caller still applies champion, inventory, shop and mutually-exclusive rules.
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() : '';
const itemId = value => /^[1-9]\d{0,8}$/.test(String(value ?? '')) ? String(value) : '';
const normalize = value => text(value).replace(/[\s：:【】\[\]·]/g, '').toLowerCase();
const has = (item, tag) => list(item.tags).includes(tag);
const stat = (item, key) => Number.isFinite(item.stats?.[key]) && item.stats[key] > 0;
const physical = item => stat(item, 'FlatPhysicalDamageMod');
const magic = item => stat(item, 'FlatMagicDamageMod');
const crit = item => has(item, 'CriticalStrike') || stat(item, 'FlatCritChanceMod');
const hp = item => has(item, 'Health') || stat(item, 'FlatHPPoolMod');
const mana = item => has(item, 'Mana') || stat(item, 'FlatMPPoolMod');
// "When dealing physical damage, apply grievous wounds" is a condition, not
// damage caused by the item. Only select an actual damage-producing clause.
const damageProc = item => /造成[^。\n]{0,60}?(?:物理|魔法|真实)伤害(?!时|后|会|将|可|的)|(?:物理|魔法)伤害\s*攻击特效/.test(text(item.description));
const burn = item => /灼烧|献祭/.test(text(item.description));
const activeOrCooldown = item => has(item, 'Active')
  || /主动|(?:每个目标|冷却时间)[^。\n]{0,20}\d+秒|\d+秒冷却/.test(text(item.description));

function catalogOf(itemsCatalog) {
  const source = itemsCatalog?.data || itemsCatalog || {};
  const entries = source instanceof Map ? [...source] : Array.isArray(source)
    ? source.map(item => [item?.id, item]) : Object.entries(source);
  return new Map(entries.slice(0, 2048).filter(([id, item]) => itemId(id) && item && typeof item === 'object')
    .map(([id, item]) => [String(id), {...item, id:String(id)}]));
}

function shopItem(item) {
  // Data Dragon 16.21 retains a separate 77xxxx recipe/catalog namespace
  // (including old items such as Deathfire Grasp), even with map-12 flags.
  // Those are not evidence of an ordinary Mayhem shop purchase option.
  return item && !/^77\d{4}$/.test(item.id) && !questRewardRule(item.id) && item.inStore !== false && item.gold?.purchasable === true
    && Number.isFinite(item.gold?.total) && item.gold.total > 0 && item.gold.total <= 30000
    && (!item.maps || !Object.keys(item.maps).length || item.maps['12'] === true)
    && !['Consumable', 'Trinket'].some(tag => has(item, tag));
}

function finished(item, catalog) {
  return shopItem(item) && item.gold.total >= (has(item, 'Boots') ? 900 : 1800)
    && !list(item.into).some(id => {
      const next = catalog.get(String(id));
      return shopItem(next) && next.gold.total > item.gold.total && list(next.from).map(String).includes(item.id);
    });
}

// The catalog also contains old-mode/Arena copies with identical names and
// map-12 flags. Prefer the ordinary recipe over those duplicate definitions;
// keep unique Mayhem items (e.g. Sword of Blossoming Dawn) without ID guesses.
function canonicalShop(catalog) {
  const byName = new Map();
  const rank = item => (item.maps?.['11'] === true ? 4 : 0) + (list(item.from).length ? 2 : 0);
  for (const item of catalog.values()) {
    if (!shopItem(item) || !text(item.name)) continue;
    const key = normalize(item.name), previous = byName.get(key);
    if (!previous || rank(item) > rank(previous) || rank(item) === rank(previous) && Number(item.id) < Number(previous.id))
      byName.set(key, item);
  }
  return [...byName.values()];
}

function descendants(start, catalog, candidates) {
  const seen = new Set([start]);
  for (let depth = 0; depth < 12 && seen.size < 128; depth++) {
    const before = seen.size;
    for (const item of candidates) if (list(item.from).some(id => seen.has(String(id)))) seen.add(item.id);
    if (seen.size === before) break;
  }
  return candidates.filter(item => seen.has(item.id) && finished(item, catalog));
}

function acquisitionQuest(augment) {
  return QUEST_ITEM_RULES.some(rule => rule.augmentId === augment.id
    || rule.gameDataId === Number(augment.gameDataId ?? augment.sourceAugmentId));
}

const mechanismRules = [
  {key:'item-haste', match:/装备急速|装备冷却(?:时间)?缩减/, item:activeOrCooldown,
    reason:'已选海克斯提升装备冷却收益，优先比较适配的主动或有冷却装备。'},
  {key:'item-damage', match:/(?:装备(?:和强化符文)?伤害.{0,12}提升|装备效果.{0,16}(?:暴击|额外伤害))/, item:damageProc,
    reason:'已选海克斯强化装备伤害效果，比较可实际触发的伤害装备。'},
  {key:'burn', match:/(?:你的灼烧效果|灼烧和持续伤害|灼烧.{0,24}(?:生成金币|降低.{0,12}冷却))/, item:burn,
    reason:'已选海克斯与灼烧效果联动，比较适配的灼烧装备。'},
  {key:'critical', match:/(?:技能|治疗和护盾).{0,12}(?:可以|可(?:以)?造成)暴击|(?:每拥有|每有).{0,12}暴击(?:率|几率)|你的(?:普攻在)?暴击.{0,20}(?:施加|治疗|获得)|暴击造成伤害.{0,20}治疗/, item:crit,
    reason:'已选海克斯新增暴击联动，结合英雄输出或治疗方式比较暴击装备。'},
  {key:'on-hit', match:/(?:技能|暴击|小蜜蜂).{0,24}(?:施加|附带|触发).{0,12}攻击特效|额外.{0,10}(?:箭矢|飞弹).{0,100}触发命中效果/, item:item => has(item, 'OnHit'),
    reason:'已选海克斯增加攻击特效的触发方式，比较适配的攻击特效装备。'},
  {key:'ability-power', match:/(?:额外)?攻击力转(?:换|化)(?:\s*为)?法术强度|你的攻击造成相当于你.{0,20}法术强度|获得相当于.{0,15}法术强度的技能急速/, item:magic,
    reason:'已选海克斯新增法术强度转化或收益，重新比较本英雄的法强装备。'},
  {key:'attack-damage', match:/法术强度转(?:换|化)(?:\s*为)?(?:额外)?攻击力/, item:physical,
    reason:'已选海克斯改变攻击力转化收益，重新比较本英雄的物理装备。'},
  {key:'mana', match:/(?:装备的)?法力值转(?:换|化)\s*为法术强度|(?:相当于|基于)你.{0,10}法力值/, item:mana,
    reason:'已选海克斯让法力值产生额外收益，结合已有装备比较法力成装。'},
  {key:'own-health', match:/(?:你(?:的)?[^。\n]{0,12}最大生命值的额外|受益于你的最大生命值)/, item:hp,
    reason:'已选海克斯明确按自身最大生命值成长，比较适配的生命值装备。'},
];

/** Only confirmed augment definitions may be supplied as owned. */
export function resolveAugmentItemIntents({owned = [], itemsCatalog = {}} = {}) {
  const catalog = catalogOf(itemsCatalog), shop = canonicalShop(catalog);
  const complete = shop.filter(item => finished(item, catalog));
  const output = [], seen = new Set();
  for (const augment of list(owned).slice(0, 16)) {
    if (!augment || typeof augment !== 'object' || !text(augment.id) || seen.has(augment.id)) continue;
    seen.add(augment.id);
    if (acquisitionQuest(augment)) continue;
    const name = text(augment.name), description = text(augment.description), compact = description.replace(/\s+/g, '');
    const upgrade = /^(?:升级|强化)\s*[:：]/.test(name);
    const titleItem = upgrade ? normalize(name.replace(/^(?:升级|强化)\s*[:：]\s*/, '')) : '';
    const requirement = /任务\s*[:：].{0,10}(?:需求\s*[:：])?持有([^。\n]*)/.exec(description)?.[1];
    const referenced = upgrade ? description : requirement || '';
    const named = shop.filter(item => titleItem === normalize(item.name)
      || referenced && (text(item.name).length >= 3 && referenced.includes(text(item.name))
        || referenced.includes(`【${text(item.name)}】`)));
    if (upgrade || requirement) {
      const options = [...new Set(named.flatMap(item => descendants(item.id, catalog, shop).map(next => next.id)))];
      if (options.length) output.push({augmentId:text(augment.id).slice(0,100), augmentName:name.slice(0,100),
        kind:options.length === 1 ? 'item' : 'family', itemIds:options.slice(0,32),
        reason:`已选「${name.slice(0,100)}」明确强化或要求对应装备；在可用成装中结合英雄与背包选择。`});
      // Named upgrades are specific commitments. Do not infer a second, broad
      // crit/AP route from their incidental gold/stat/reward descriptions.
      if (upgrade) continue;
    }
    for (const rule of mechanismRules) {
      if (!rule.match.test(compact)) continue;
      const options = complete.filter(rule.item).map(item => item.id).slice(0,64);
      if (options.length) output.push({augmentId:text(augment.id).slice(0,100), augmentName:name.slice(0,100),
        kind:'mechanism', mechanism:rule.key, itemIds:options, reason:rule.reason});
    }
  }
  return output.slice(0,48);
}
