import {enrichData, getChampionTags, TAG_LABELS} from './engine.js';

const unique = values => [...new Set(values.filter(Boolean))];
const list = value => Array.isArray(value) ? value : [];
const finite = value => Number.isFinite(Number(value)) && value !== null && value !== '';
const text = value => String(value || '').replace(/<[^>]*>/g, '').trim();
const ROUTE_NAMES = {attack: '普攻', spell: '技能', tank: '坦克', support: '辅助', crit: '暴击'};
// Curated exceptions to broad role labels; these are mechanism notes, not a build ranking.
const AP_ATTACKERS = new Set(['Gwen', 'Kayle', 'Azir', 'Teemo', 'KogMaw', 'Kaisa']);
const SPECIAL_ATTACKS = new Set(['Jhin', 'Graves']);
const ALLY_HEAL_SHIELD = new Set(['Sona', 'Soraka', 'Nami', 'Milio', 'Yuumi', 'Seraphine', 'Janna', 'Karma', 'Lulu', 'Ivern', 'Rakan', 'Taric', 'Renata', 'Senna']);
const routeAlias = value => ({普攻: 'attack', 技能: 'spell', 坦克: 'tank', 辅助: 'support', 暴击: 'crit'})[value] || value;

function ownedDefinitions(owned, augments) {
  const byId = new Map(list(augments).map(augment => [String(augment.id), augment]));
  return enrichData({augments: list(owned).map(entry => typeof entry === 'object' ? entry : byId.get(String(entry))).filter(Boolean)}).augments;
}

function catalogMap(catalog) {
  if (catalog instanceof Map) return catalog;
  const data = catalog?.data || catalog || {};
  return new Map(Array.isArray(data) ? data.map(item => [String(item.id), item]) : Object.entries(data));
}

function summaryStats(stats) {
  const labels = {abilityPower: '法强', attackDamage: '攻击力', maxHealth: '最大生命值', abilityHaste: '技能急速'};
  return Object.entries(labels).filter(([key]) => finite(stats?.[key])).map(([key, label]) => `${label} ${Math.round(Number(stats[key]))}`).join(' · ');
}

/**
 * Own-player observations plus static mechanism explanations. No opponent data,
 * inferred cooldowns, win rates, automatic inputs, or unconfirmed OCR selections.
 */
export function buildLivePlan({champion, owned = [], route = 'auto', live = {}, augments = [], itemsCatalog = {}} = {}) {
  const context = [];
  if (live.mode?.known && live.mode.isMayhem === false) return {
    title: '当前模式不是海克斯大乱斗', summary: '切换到海克斯大乱斗后再生成当局玩法选项。', choices: [],
    context: ['已读取游戏模式；海克斯玩法建议已暂停。'], confidence: 'unavailable', label: '等待海克斯大乱斗'
  };
  if (!champion) return {
    title: '等待识别你的英雄', summary: '进入英雄选择或对局后会更新；也可以手动选择英雄。', choices: [],
    context: ['尚无当前英雄，暂不推断出装和玩法。'], confidence: 'unavailable', label: '等待英雄'
  };
  const hasLive = live.connection?.status === 'connected' && live.championId === champion.id;
  // A previous game/champion snapshot must never influence the current selection.
  const observed = hasLive ? live : {};
  const stats = observed.stats || {};
  const tags = getChampionTags(champion);
  const definitions = ownedDefinitions(owned, augments);
  const effectText = definitions.map(augment => text(augment.description)).join('\n');
  const noAttacks = /(?:无法|不能|不可)(?:进行|使用)?(?:普攻|普通攻击|基本攻击)|cannot (?:use |perform )?(?:basic )?attack/i.test(effectText);
  const noCrit = /(?:你|伤害)(?:将|的伤害)?(?:无法|不能|不可)暴击|(?:your damage|you) cannot (?:crit|critically strike)/i.test(effectText);
  const ownedTags = unique(definitions.flatMap(augment => augment.tags));
  const triggers = unique(definitions.flatMap(augment => augment.triggers));
  const effects = unique(definitions.flatMap(augment => augment.effects));
  const items = list(observed.items).filter(item => Number(item.count ?? 1) > 0);
  const itemIds = new Set(items.map(item => String(item.id ?? item.itemID)));
  const catalog = catalogMap(itemsCatalog);
  const ownedItems = items.map(item => ({...item, definition: catalog.get(String(item.id ?? item.itemID))}));
  const itemTags = unique(ownedItems.flatMap(item => item.definition?.tags || []));
  const currentRoute = routeAlias(route);
  const isRangedPhysical = tags.includes('physical') && tags.includes('attack');
  const apAttacker = AP_ATTACKERS.has(champion.id);
  const physical = tags.includes('physical');
  const spell = tags.includes('magic') && (!isRangedPhysical || apAttacker) || apAttacker;
  const frontline = tags.includes('defense') || tags.includes('health');
  const support = ALLY_HEAL_SHIELD.has(champion.id);
  const attack = tags.includes('attack') || apAttacker;
  const specialAttacks = SPECIAL_ATTACKS.has(champion.id);
  const championName = champion.title || champion.name || champion.id;
  context.push(`英雄：${championName}；${hasLive ? '本局自动读取' : '静态机制参考'}。`);
  if (finite(observed.level)) context.push(`当前 ${Math.round(observed.level)} 级。`);
  if (finite(observed.gameTime)) {
    const seconds = Math.max(0, Math.floor(Number(observed.gameTime)));
    context.push(`对局时间 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}。`);
  }
  if (summaryStats(stats)) context.push(`自身面板：${summaryStats(stats)}。`);
  if (ownedItems.length) context.push(`已读取装备：${ownedItems.map(item => item.definition?.name || text(item.name) || `装备 ${item.id ?? item.itemID}`).join('、')}。`);
  if (definitions.length) context.push(`已确认海克斯：${definitions.map(augment => augment.name || augment.id).join('、')}。`);
  else context.push('尚未确认已选海克斯；当前仅按英雄机制和可用面板提供选项。');
  if (noAttacks) context.push('已确认效果包含无法普攻的限制，普攻路线已暂停。');
  if (noCrit) context.push('已确认效果包含无法暴击的限制，不再列出暴击装备选项。');
  if (live.augments?.status !== 'detected') context.push('海克斯以你确认的列表为准；未把普通符文或识别草稿加入建议。');
  if (currentRoute !== 'auto' && ROUTE_NAMES[currentRoute]) context.push(`你选择的路线：${ROUTE_NAMES[currentRoute]}；保留其他玩法供比较。`);

  const stage = Number(observed.gameTime) >= 900 || Number(observed.level) >= 16 ? 'late'
    : Number(observed.gameTime) >= 480 || Number(observed.level) >= 11 ? 'mid' : 'early';
  const stageWhy = !hasLive ? '在真实对局开始前，先比较英雄机制对应的玩法方向。'
    : stage === 'late' ? '当前已到较高等级或较长对局阶段，优先延续已有装备和海克斯，避免无依据地推翻整套出装。'
      : stage === 'mid' ? '当前进入中段，把已有装备对应的输出方式与海克斯触发条件接起来。'
        : '当前等级或对局时间仍偏早，保留转型空间，先满足海克斯的触发条件。';
  const rank = [];
  const add = (id, title, weight, why, watch, suggestions) => rank.push({id, title, weight, why, watch, suggestions});
  const ownedNote = (wanted, prefix) => {
    const matching = definitions.filter(augment => wanted.some(tag => augment.tags.includes(tag)));
    return matching.length ? `${prefix}：已确认「${matching.slice(0, 2).map(augment => augment.name || augment.id).join('」「')}」的效果文字包含${unique(matching.flatMap(augment => augment.tags).filter(tag => wanted.includes(tag))).map(tag => TAG_LABELS[tag] || tag).join('、')}；仍需满足原文触发条件。` : '';
  };

  if (attack && !noAttacks) add('attack', apAttacker ? '普攻衔接技能' : '保持普攻输出', 50 + (physical ? 12 : 0) + (triggers.includes('attack') ? 24 : 0) + (itemTags.includes('AttackSpeed') ? 12 : 0), [
    apAttacker ? '这个英雄可以围绕普攻衔接技能构建路线；法强与攻速的收益需要结合技能机制。' : '英雄机制包含普攻方向，重点是创造持续攻击的时间和距离。',
    ownedNote(['attack', 'attackSpeed', 'crit', 'burn'], '海克斯依据'),
    itemTags.includes('AttackSpeed') ? '已持有攻速装备，保持普攻覆盖能利用已投入的属性。' : '',
    finite(stats.attackSpeed) ? `当前攻击速度为 ${Number(stats.attackSpeed).toFixed(2)}；它是已读取面板，不是额外收益预测。` : ''
  ], [specialAttacks ? '该英雄有特殊攻击或换弹机制，不能把攻速直接等同于攻击次数提升。' : '只有能安全普攻时，依赖命中的海克斯和装备才有持续价值。',
    '技能伤害不会自动触发所有普攻特效，具体看原文。'], apAttacker ? [
    ['3115', '同时提供法强、攻速和攻击特效，适合需要普攻衔接的法强路线；需实际能够持续攻击。']
  ] : [
    ...(!noCrit ? [['3031', '提供攻击力与暴击属性；作为暴击路线的可选项，需核对海克斯是否保留暴击能力。']] : []),
    ...(!specialAttacks ? [['3153', '提供攻击力、攻速与生命偷取；需要实际普攻命中才能发挥攻击特效。']] : [])
  ]);

  if (spell) add('spell', '围绕技能循环', 58 + (ownedTags.includes('spell') ? 14 : 0) + (ownedTags.includes('haste') ? 12 : 0) + (itemTags.includes('SpellDamage') ? 12 : 0), [
    '英雄的技能机制可支持法术方向；先确保关键技能能够命中并完成循环。',
    ownedNote(['spell', 'magic', 'haste', 'burn'], '海克斯依据'),
    itemTags.includes('SpellDamage') ? '已有法强装备，后续可比较继续补输出或为施法争取生存空间。' : '',
    finite(stats.abilityPower) ? `当前法术强度 ${Math.round(stats.abilityPower)}，已用于描述现有构筑；没有据此推算技能伤害。` : ''
  ], ['法强不会让全部海克斯自动获得加成，需要原文明确存在法强收益。',
    triggers.includes('crit') && !effects.includes('spellCrit') ? '已选效果包含暴击触发；未确认技能可暴击时，不能把技能命中视为暴击触发。' : '关键技能冷却期间留出走位和补刀空间。'], [
    ['3089', '提高法术强度，供法强路线比较；具体技能和海克斯是否受益需看加成说明。'],
    ['3116', '伤害型技能可施加减速，适合需要技能留人的情况；减速不能视为定身。']
  ]);

  if (support) add('support', '治疗护盾与团队衔接', 60 + (ownedTags.includes('heal') ? 16 : 0) + (ownedTags.includes('shield') ? 16 : 0) + (itemIds.has('6617') ? 14 : 0), [
    '英雄具有为友军提供治疗或护盾的机制，可以比较保护队友的路线。',
    ownedNote(['heal', 'shield', 'haste'], '海克斯依据'),
    itemIds.has('6617') ? '已持有月石再生器，其连锁效果要求对友军提供治疗或护盾。' : ''
  ], ['治疗和护盾强度只会放大已有来源，不能凭空创造一次治疗或护盾。',
    '友军是否需要治疗、是否能持续攻击仍需你在游戏中判断。'], [
    ['6617', '对友军的治疗或护盾可连锁至另一位友军，前提是英雄或海克斯能向友军施加对应效果。'],
    ['3504', '向友军施加治疗或护盾后可提供攻速和攻击特效，适合队友能利用普攻强化时比较。']
  ]);

  if (frontline || ownedTags.includes('health') || ownedTags.includes('defense')) add('tank', '承伤与控制窗口', 42 + (tags.includes('defense') ? 22 : frontline ? 10 : 0) + (ownedTags.includes('health') ? 19 : 0) + (ownedTags.includes('defense') ? 10 : 0) + (itemTags.includes('Health') ? 9 : 0), [
    frontline ? '英雄机制包含生命值或防御方向，可以为控制和第二轮技能争取时间。' : '已确认海克斯提供生命值或防御方向，可以比较增加生存空间的转型。',
    ownedNote(['health', 'defense', 'cc', 'sustain'], '海克斯依据'),
    itemTags.includes('Health') ? '当前装备已有生命值投入，生存路线可围绕现有构筑继续比较。' : '',
    finite(stats.maxHealth) ? `当前最大生命值 ${Math.round(stats.maxHealth)}；生命值不等于额外生命值，不能代入所有海克斯公式。` : ''
  ], ['没有读取敌方伤害构成，护甲与魔抗的取舍需要你在游戏里判断。',
    '减速与硬控制的触发条件不同；只有原文允许的控制才能触发对应海克斯。'], [
    ['3068', '生命值与护甲提供承伤属性；附近持续伤害需要保持合适距离，是否需要护甲由你判断。'],
    ...((tags.includes('heal') || tags.includes('shield') || effects.includes('heal') || effects.includes('shield')) ? [['3065', '提供生命值与魔抗，并放大你受到的治疗和护盾；需已有可利用的来源。']] : [])
  ]);

  // A second option prioritizes protecting the hero's established action pattern.
  add('survive', '为已有输出争取时间', 35 + (stage === 'late' ? 14 : 0), [
    '当持续输出或技能循环容易被打断时，可以比较一件符合当前输出属性的生存装备。',
    stageWhy,
    definitions.length ? '保留已确认海克斯的触发方式，先解决能否安全触发的问题。' : ''
  ], ['没有根据敌方阵容替你选定抗性；请结合游戏内实际承伤再决定。',
    '生存装备也有主动、距离或生命值阈值条件，不等于持续无敌。'], spell ? [
    ['3157', '提供法强与护甲，并可主动进入凝滞；需由你判断使用时机。'],
    ['3102', '提供法强与魔抗，并有法术护盾；是否适合本局取决于你在游戏中观察到的威胁。']
  ] : physical ? [
    ['3053', '提供生命值与低生命值护盾，供需要贴近作战的攻击力路线比较；请核对商店及英雄适用条件。']
  ] : [
    ['3068', '生命值与护甲作为生存属性示例；仅在你需要护甲且能利用近身效果时考虑。']
  ]);

  if (!rank.some(choice => choice.id !== 'survive')) add('mechanics', '先确认核心触发方式', 40, [
    '当前英雄的静态机制标签不足，先依据技能说明与已选海克斯逐条确认触发条件。',
    ownedNote(ownedTags, '已确认效果'), stageWhy
  ], ['资料不足时不从攻击力和法强面板直接断言技能加成。'], []);

  const chooseItems = suggestions => suggestions.filter(([id]) => !itemIds.has(id)).flatMap(([id, reason]) => {
    const item = catalog.get(id);
    if (!item || item.inStore === false || item.gold?.purchasable !== true) return [];
    if (item.requiredChampion && item.requiredChampion.toLowerCase() !== String(champion.id).toLowerCase()) return [];
    // Static catalog map flags cannot prove the current Mayhem shop; keep a
    // conservative normal-ARAM suggestion list without deleting special items.
    if (item.maps && Object.keys(item.maps).length && item.maps['12'] !== true) return [];
    return [{id, name: item.name, reason: `${reason} 商店可用性与实际效果以本局为准。`, sourceUrl: itemsCatalog?.meta?.sourceUrl || '', catalogVersion: itemsCatalog?.meta?.version || ''}];
  }).slice(0, 2);

  rank.sort((a, b) => (b.weight + (b.id === currentRoute || currentRoute === 'crit' && b.id === 'attack' ? 40 : 0)) - (a.weight + (a.id === currentRoute || currentRoute === 'crit' && a.id === 'attack' ? 40 : 0)));
  const choices = rank.slice(0, 3).map(({id, title, why, watch, suggestions}, index) => ({
    id, title, why: unique([...why, index === 0 ? stageWhy : '']), watch: unique([
      ...watch,
      definitions.some(augment => list(augment.unresolvedValues).length) ? '已选海克斯含待核实的动态数值，仅按可确认的机制文字解释。' : '',
      !hasLive ? '尚未读取匹配当前英雄的实战面板，进入对局后再核对装备。' : '',
      finite(observed.currentGold) ? `当前金币 ${Math.floor(observed.currentGold)}；装备合成费用还取决于你已有的组件。` : ''
    ]), items: chooseItems(suggestions)
  }));
  return {
    title: `${championName}的可选玩法`,
    summary: `${hasLive ? '已结合当前英雄、自身面板与装备' : '当前基于英雄静态机制'}${definitions.length ? `，以及 ${definitions.length} 个已确认海克斯` : ''}。以下路线供你比较，随状态和确认列表更新。`,
    choices, context,
    confidence: hasLive ? 'mechanism-with-live' : 'mechanism',
    label: hasLive ? '机制建议 · 已读取本局数据' : '机制建议 · 等待本局数据'
  };
}
