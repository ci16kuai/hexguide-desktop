import {enrichData, getChampionTags, getSynergy, recommend, TAG_LABELS} from './engine.js';

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

// Pure catalog formatting: this module also runs on the server and must not
// depend on the statistics view or its DOM event handlers.
export function shortEquipmentEffect(description) {
  const lines = String(description || '').replace(/<\/?(?:br|p|div|li)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[（(]\s*0(?:\.0+)?(?:秒|伤害|生命值|法力值)?\s*[）)]/g, '')
    .split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const known = line => !/{{|}}|@[\w]+@|%i:|\b(?:NaN|undefined)\b|(?<![\d.])0(?:\.0+)?(?:秒|(?:额外)?(?:物理伤害|魔法伤害|真实伤害|伤害|生命值|法力值|护盾))/.test(line);
  const sentences = lines.filter(line => !/^[-+]?\d/.test(line)).join('').match(/[^。！？]+[。！？]?/gu)?.filter(known) || [];
  const summary = [];
  for (const sentence of sentences) {
    if (summary.length === 2 || Array.from(summary.join('') + sentence).length > 100) break;
    summary.push(sentence);
  }
  return summary.join('') || lines.filter(line => /^[-+]?\d/.test(line) && known(line)).slice(0, 4).join('、').slice(0, 100);
}

const normalized = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');
const hasTag = (item, tag) => list(item?.tags).includes(tag);
const visibleStat = (item, stat) => Number(item?.stats?.[stat]) > 0;
function requiresOwnAttacks(item) {
  if (hasTag(item, 'AttackSpeed') || hasTag(item, 'OnHit')) return true;
  // A defensive effect that triggers when the enemy attacks does not require
  // the holder to be able to attack. Inspect the remaining effect clauses.
  const ownEffect = text(item?.description).split(/[，,。；;\n]+/).filter(clause => {
    if (/(?:你的|自身的|自己的)(?:下次|下一次|下一记)?(?:普攻|普通攻击|基本攻击)/.test(clause)) return true;
    return !/(?:被|受到|承受|所受|来自|即将到来).{0,32}(?:普攻|普通攻击|基本攻击)|(?:普攻|普通攻击|基本攻击).{0,16}(?:对你|对自身|对自己)/.test(clause);
  }).join('。');
  return /普攻|普通攻击|攻击特效|基本攻击|basic attacks?|on[- ]hit/i.test(ownEffect);
}

/** Only current visible opponents and official catalog attributes are used.
 * Champion tags describe mechanisms, never measured damage or hidden stats. */
export function describeEnemies({champion, live = {}, champions = [], itemsCatalog = {}, now = Date.now()} = {}) {
  const empty = (status, summary) => ({status, summary, signals: [], champions: [], observedAt: ''});
  if (!champion || live.connection?.status !== 'connected' || live.championId !== champion.id || live.teams?.status !== 'detected') {
    return empty('unavailable', '尚未读取当前敌方阵容和装备；推荐暂按自身英雄与已确认海克斯生成。');
  }
  const observedAt = live.teams.observedAt;
  const timestamp = typeof observedAt === 'number' ? observedAt : Date.parse(observedAt || '');
  const nowTime = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowTime) || nowTime - timestamp > 30_000 || timestamp - nowTime > 5_000) {
    return empty('stale', '敌方资料已过期，等待本局重新读取；本次不沿用旧阵容。');
  }
  const catalog = catalogMap(itemsCatalog);
  const definitions = new Map(list(champions).flatMap(hero => unique([hero.id, hero.enName, hero.name, hero.title, ...list(hero.aliases)]).map(alias => [normalized(alias), hero])));
  const enemies = list(live.teams.enemies).filter(enemy => enemy && (enemy.championId || enemy.championName)).slice(0, 5).map(enemy => {
    const hero = definitions.get(normalized(enemy.championId)) || definitions.get(normalized(enemy.championName));
    const items = list(enemy.items).filter(item => Number(item.count ?? 1) > 0).map(item => {
      const id = String(item.id ?? item.itemID ?? '');
      return {id, name: catalog.get(id)?.name || text(item.name) || `装备 ${id}`, definition: catalog.get(id)};
    });
    return {id: hero?.id || text(enemy.championId), name: hero?.title || hero?.name || text(enemy.championName) || text(enemy.championId), icon: hero?.icon || '', level: finite(enemy.level) ? Number(enemy.level) : null, tags: hero ? getChampionTags(hero) : [], items};
  });
  if (!enemies.length) return empty('unavailable', '当前未读取到敌方玩家；推荐暂按自身英雄与已确认海克斯生成。');
  const signals = [];
  const add = (id, label, affected, reason, itemFilter = () => false) => {
    if (!affected.length) return;
    const itemNames = unique(affected.flatMap(enemy => enemy.items.filter(item => itemFilter(item.definition)).map(item => item.name)));
    signals.push({id, label, reason, championIds: affected.map(enemy => enemy.id), itemNames});
  };
  const armor = item => hasTag(item, 'Armor') || visibleStat(item, 'FlatArmorMod');
  const magicResist = item => hasTag(item, 'SpellBlock') || hasTag(item, 'MagicResist') || visibleStat(item, 'FlatSpellBlockMod');
  // Combat healing/lifesteal is actionable for grievous wounds. Out-of-combat
  // Warmog regeneration alone is deliberately not treated as combat healing.
  const healing = item => hasTag(item, 'LifeSteal') || hasTag(item, 'SpellVamp') || /(?:你身上的|受到的)治疗和护盾效果提升|(?:回复|恢复|治疗)(?:自身|自己|你|友军|盟友)|生命偷取|全能吸血/.test(text(item?.description));
  const health = item => visibleStat(item, 'FlatHPPoolMod') && Number(item.stats.FlatHPPoolMod) >= 350;
  add('armor', '可见护甲装备', enemies.filter(enemy => enemy.items.some(item => armor(item.definition))), '已读取到敌方护甲装备；这只说明可见装备投入，不是敌方总护甲数值。', armor);
  add('magic-resist', '可见魔抗装备', enemies.filter(enemy => enemy.items.some(item => magicResist(item.definition))), '已读取到敌方魔抗装备；法术路线可比较穿透，未推算敌方总魔抗。', magicResist);
  add('healing', '治疗与续航条件', enemies.filter(enemy => enemy.tags.includes('heal') || enemy.tags.includes('sustain') || enemy.items.some(item => healing(item.definition))), '敌方英雄机制或可见装备包含治疗/战斗续航来源；重伤仍需实际命中并满足装备触发条件。', healing);
  add('frontline', '前排或生命值投入', enemies.filter(enemy => enemy.tags.includes('defense') || enemy.tags.includes('health') || enemy.items.some(item => health(item.definition))), '敌方有前排机制或可见大件生命值投入，可比较持续输出；未读取其实际生命值或隐藏抗性。', health);
  add('magic-mechanisms', '魔法机制倾向', enemies.filter(enemy => enemy.tags.includes('magic') || enemy.items.some(item => visibleStat(item.definition, 'FlatMagicDamageMod'))), '静态英雄标签与可见法强装备提供魔法方向线索，不代表本局实际伤害占比。', item => visibleStat(item, 'FlatMagicDamageMod'));
  add('physical-mechanisms', '物理机制倾向', enemies.filter(enemy => enemy.tags.includes('physical') || enemy.items.some(item => visibleStat(item.definition, 'FlatPhysicalDamageMod'))), '静态英雄标签与可见攻击力装备提供物理方向线索，不代表本局实际伤害占比。', item => visibleStat(item, 'FlatPhysicalDamageMod'));
  return {
    status: 'detected', observedAt, signals,
    summary: `已读取 ${enemies.length} 位敌方英雄${signals.length ? `：${signals.slice(0, 4).map(signal => signal.label).join('、')}` : '；当前没有足够的针对性装备线索'}。`,
    champions: enemies.map(enemy => ({...enemy, items: enemy.items.map(({definition, ...item}) => item)}))
  };
}

function enemyAugmentAdjustment(augment, enemyContext, {physical, spell}) {
  const signals = new Set(enemyContext.signals.map(signal => signal.id));
  const description = text(augment.description), reasons = [];
  let bonus = 0;
  if ((signals.has('armor') && physical && /(?:护甲穿透|穿甲|护甲.{0,6}击碎)/.test(description)) || (signals.has('magic-resist') && spell && /(?:法术穿透|魔法抗性.{0,6}击碎)/.test(description))) {
    bonus += 18;
    reasons.push('已读取敌方对应抗性装备，该海克斯的穿透或削减机制可供当前输出路线比较。');
  }
  if (signals.has('healing') && /重伤|治疗.{0,10}(?:降低|减少)/.test(description)) {
    bonus += 10;
    reasons.push('敌方具有已知治疗/续航条件，该效果可作为限制治疗的机制选项。');
  }
  if (signals.has('frontline') && /(?:敌人|敌方|目标).{0,15}(?:最大生命|当前生命)|真实伤害|持续伤害|灼烧/.test(description)) {
    bonus += 5;
    reasons.push('敌方有前排或生命值投入，可比较持续伤害、目标生命值相关或真实伤害机制，仍需满足原文条件。');
  }
  return {bonus, reasons};
}

/**
 * Live visible observations plus static mechanism explanations. No hidden
 * opponent stats, inferred cooldowns, win rates, or unconfirmed OCR selections.
 */
export function buildLivePlan({champion, owned = [], route = 'auto', live = {}, augments = [], itemsCatalog = {}, champions = [], now = Date.now()} = {}) {
  const context = [];
  const noPlan = {buildItems: [], nextAugments: [], enemyContext: {status: 'unavailable', summary: '等待当前海克斯大乱斗对局。', signals: [], champions: [], observedAt: ''}};
  if (live.mode?.known && live.mode.isMayhem === false) return {
    ...noPlan,
    title: '当前模式不是海克斯大乱斗', summary: '切换到海克斯大乱斗后再生成当局玩法选项。', choices: [],
    context: ['已读取游戏模式；海克斯玩法建议已暂停。'], confidence: 'unavailable', label: '等待海克斯大乱斗'
  };
  if (!champion) return {
    ...noPlan,
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
  const enemyContext = describeEnemies({champion, live, champions, itemsCatalog, now});
  context.push(`英雄：${championName}；${hasLive ? '本局自动读取' : '静态机制参考'}。`);
  context.push(enemyContext.summary);
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
  ], [enemyContext.status === 'detected' ? '敌方英雄机制与可见装备仅提供抗性选项的依据；仍需结合实际承伤决定。' : '没有读取敌方伤害构成，护甲与魔抗的取舍需要你在游戏里判断。',
    '减速与硬控制的触发条件不同；只有原文允许的控制才能触发对应海克斯。'], [
    ['3068', '生命值与护甲提供承伤属性；附近持续伤害需要保持合适距离，是否需要护甲由你判断。'],
    ...((tags.includes('heal') || tags.includes('shield') || effects.includes('heal') || effects.includes('shield')) ? [['3065', '提供生命值与魔抗，并放大你受到的治疗和护盾；需已有可利用的来源。']] : [])
  ]);

  // A second option prioritizes protecting the hero's established action pattern.
  add('survive', '为已有输出争取时间', 35 + (stage === 'late' ? 14 : 0), [
    '当持续输出或技能循环容易被打断时，可以比较一件符合当前输出属性的生存装备。',
    stageWhy,
    definitions.length ? '保留已确认海克斯的触发方式，先解决能否安全触发的问题。' : ''
  ], [enemyContext.status === 'detected' ? '已结合可见敌方条件给出装备选项，没有测量本局实际伤害占比。' : '尚无当前敌方资料；请结合游戏内实际承伤再决定抗性。',
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

  const eligibleItem = id => {
    const item = catalog.get(String(id));
    if (!item || item.inStore === false || item.gold?.purchasable !== true) return null;
    if (item.requiredChampion && item.requiredChampion.toLowerCase() !== String(champion.id).toLowerCase()) return null;
    // Static catalog map flags cannot prove the current Mayhem shop; keep a
    // conservative normal-ARAM suggestion list without deleting special items.
    if (item.maps && Object.keys(item.maps).length && item.maps['12'] !== true) return null;
    if (noCrit && (hasTag(item, 'CriticalStrike') || visibleStat(item, 'FlatCritChanceMod'))) return null;
    if (noAttacks && requiresOwnAttacks(item)) return null;
    if (tags.includes('noMana') && (hasTag(item, 'Mana') || hasTag(item, 'ManaRegen')) && !/法术强度|攻击力|生命值|护甲|魔法抗性/.test(text(item.description))) return null;
    return item;
  };
  const itemCard = (id, reason) => {
    const item = eligibleItem(id);
    if (!item?.name || itemIds.has(String(id))) return null;
    const effect = shortEquipmentEffect(item.description);
    if (!effect || !/^https:\/\//i.test(item.icon || '')) return null;
    return {id: String(id), name: item.name, icon: item.icon, effect, reason: `${reason} 商店可用性与实际效果以本局为准。`, sourceUrl: itemsCatalog?.meta?.sourceUrl || '', catalogVersion: itemsCatalog?.meta?.version || ''};
  };
  const chooseItems = suggestions => suggestions.map(([id, reason]) => itemCard(id, reason)).filter(Boolean).slice(0, 2);

  rank.sort((a, b) => (b.weight + (b.id === currentRoute || currentRoute === 'crit' && b.id === 'attack' ? 40 : 0)) - (a.weight + (a.id === currentRoute || currentRoute === 'crit' && a.id === 'attack' ? 40 : 0)));
  const choices = rank.slice(0, 3).map(({id, title, why, watch, suggestions}, index) => ({
    id, title, why: unique([...why, index === 0 ? stageWhy : '']), watch: unique([
      ...watch,
      definitions.some(augment => list(augment.unresolvedValues).length) ? '已选海克斯含待核实的动态数值，仅按可确认的机制文字解释。' : '',
      !hasLive ? '尚未读取匹配当前英雄的实战面板，进入对局后再核对装备。' : '',
      finite(observed.currentGold) ? `当前金币 ${Math.floor(observed.currentGold)}；装备合成费用还取决于你已有的组件。` : ''
    ]), items: chooseItems(suggestions)
  }));
  const enemySignals = new Map(enemyContext.signals.map(signal => [signal.id, signal]));
  const signals = new Set(enemySignals.keys());
  const spellRoute = spell && ['auto', 'spell'].includes(currentRoute);
  const physicalRoute = physical && ['auto', 'attack', 'crit'].includes(currentRoute) && (!noAttacks || tags.includes('spell'));
  const tankRoute = frontline || currentRoute === 'tank' || ownedTags.includes('health') || ownedTags.includes('defense');
  const targeted = [];
  const target = (id, reason) => targeted.push([id, reason]);
  const evidence = id => {
    const signal = enemySignals.get(id);
    const names = signal?.championIds.map(id => enemyContext.champions.find(enemy => enemy.id === id)?.name).filter(Boolean) || [];
    return `${names.join('、')}${signal?.itemNames.length ? `持有的${signal.itemNames.join('、')}` : ''}`;
  };
  if (signals.has('healing')) {
    const why = `已读取${evidence('healing')}的治疗/续航条件；重伤需要造成装备要求的伤害才能限制治疗，不推断实际治疗量。`;
    if (spellRoute) target('3165', why);
    else if (physicalRoute) target(noCrit ? '6609' : '3033', why);
    else if (tankRoute && signals.has('physical-mechanisms')) target('3075', `${why} 荆棘要求被敌方攻击命中，无法仅靠站在附近施加重伤。`);
  }
  if (signals.has('armor') && physicalRoute) target(noCrit ? '6694' : '3036', `已读取${evidence('armor')}的护甲装备；护甲穿透对应当前物理输出方向，不代表已测得其总护甲。`);
  if (signals.has('magic-resist') && spellRoute) target('3135', `已读取${evidence('magic-resist')}的魔抗装备；法术穿透对应当前法术方向，不代表已测得其总魔抗。`);
  if (signals.has('frontline')) {
    if (spellRoute) target('6653', '敌方有前排机制或可见生命值投入，技能灼烧可作为持续输出选项；需要技能实际造成伤害，未推算目标血量。');
    if ((physicalRoute || apAttacker) && attack && !noAttacks && !specialAttacks) target('3153', '敌方有前排机制或可见生命值投入，可比较按目标当前生命值造成伤害的普攻特效；需要持续普攻命中。');
  }
  const magicCount = enemySignals.get('magic-mechanisms')?.championIds.length || 0;
  const physicalCount = enemySignals.get('physical-mechanisms')?.championIds.length || 0;
  if (magicCount >= 2 && magicCount > physicalCount) {
    const reason = '已读取的敌方英雄机制/装备偏魔法方向，可比较魔抗生存选项；这是机制倾向，未测量本局魔法伤害占比。';
    if (spellRoute) target('3102', reason);
    else if (physicalRoute) target('3156', reason);
    else if (tankRoute) target('4401', reason);
  }
  if (physicalCount >= 2 && physicalCount > magicCount) {
    const reason = '已读取的敌方英雄机制/装备偏物理方向，可比较护甲生存选项；这是机制倾向，未测量本局物理伤害占比。';
    if (spellRoute) target('3157', reason);
    else if (tankRoute) target('3143', `${reason} 兰顿减暴击的部分仍需敌方实际造成暴击伤害。`);
  }
  const seenItems = new Set();
  const buildItems = [...targeted.map(([id, reason]) => itemCard(id, reason)), ...choices.flatMap(choice => choice.items)].filter(item => {
    if (!item || seenItems.has(item.id)) return false;
    seenItems.add(item.id); return true;
  }).slice(0, 6);
  const ownedIds = new Set(definitions.map(augment => String(augment.id)));
  const nextAugments = enrichData({augments}).augments.filter(augment => {
    if (ownedIds.has(String(augment.id)) || augment.retiredPatch || augment.recommendable === false || augment.isInternalTemplate || !text(augment.description)) return false;
    if (Object.prototype.hasOwnProperty.call(augment, 'availability') && augment.availability !== 'current') return false;
    if (noAttacks && (augment.tags.includes('attack') || augment.tags.includes('attackSpeed') || augment.triggers.includes('attack'))) return false;
    if (noCrit && augment.tags.includes('crit')) return false;
    return !definitions.some(previous => getSynergy(previous, augment, champion).level === 'conflict');
  }).map(augment => {
    const result = recommend(augment, champion, definitions, currentRoute);
    const adjustment = enemyAugmentAdjustment(augment, enemyContext, {physical: physicalRoute, spell: spellRoute});
    const reasons = unique([...adjustment.reasons, ...result.reasons.filter(reason => !/适配分不代表胜率/.test(reason))]);
    return {id: augment.id, name: augment.name, icon: augment.icon || '', rarity: augment.rarity, description: augment.description, mechanismLabel: '后续机制参考', reason: reasons[0], reasons, cautions: unique([...result.cautions, '仅为后续遇到时的机制参考；不预测下轮出现，也不代表胜率。']), sourceUrl: augment.sourceUrl || '', confidence: result.confidence, rankingScore: result.score + adjustment.bonus};
  }).sort((a, b) => b.rankingScore - a.rankingScore || String(a.id).localeCompare(String(b.id))).slice(0, 6).map(({rankingScore, ...augment}, index) => ({...augment, rank: index + 1}));
  return {
    title: `${championName}的可选玩法`,
    summary: `${hasLive ? '已结合当前英雄、自身面板与装备' : '当前基于英雄静态机制'}${definitions.length ? `，以及 ${definitions.length} 个已确认海克斯` : ''}${enemyContext.status === 'detected' ? '；已加入可见敌方阵容与装备条件' : ''}。以下路线供你比较，随状态和确认列表更新。`,
    choices, context, buildItems, nextAugments, enemyContext,
    confidence: hasLive ? 'mechanism-with-live' : 'mechanism',
    label: hasLive ? '机制建议 · 已读取本局数据' : '机制建议 · 等待本局数据'
  };
}
