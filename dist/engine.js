/**
 * Explainable, deliberately conservative mechanism rules.
 * Scores are product suitability scores, never win rates. Original descriptions
 * are retained; inferred relationships always carry a mechanism evidence label.
 */
export const TAG_LABELS = Object.freeze({
  attack: '普攻', spell: '技能', crit: '暴击', burn: '灼烧', heal: '治疗',
  shield: '护盾', cc: '控制', health: '生命值', haste: '技能急速',
  mobility: '机动', sustain: '续航', physical: '物理', magic: '魔法',
  defense: '防御', range: '射程', attackSpeed: '攻速', mana: '法力', execute: '斩杀', noMana: '无蓝条'
});

const TAG_PATTERNS = {
  attack: /普攻|普通攻击|基本攻击|(?:你的|每次)攻击(?!力|速度|距离|范围)|basic attacks?|on[- ]hit|攻击特效/i,
  spell: /技能|法术|abilities|ability|spells?/i,
  crit: /暴击|critical|\bcrit\b/i,
  burn: /灼烧|燃烧|burn|damage over time|持续伤害/i,
  heal: /治疗|回复.{0,8}生命|恢复.{0,8}生命|healing?|restore.{0,12}health/i,
  shield: /护盾|shield/i,
  cc: /定身|控制|减速|禁锢|眩晕|晕眩|击飞|恐惧|嘲讽|魅惑|压制|immobili|crowd control|stun|slow|knock.?up|root/i,
  health: /最大生命|额外生命|(?:获得|增加|提升|提高).{0,12}生命值|maximum health|max health|bonus health/i,
  haste: /技能急速|冷却缩减|冷却减缩|ability haste|cooldown reduction/i,
  mobility: /移动速度|移速|冲刺|位移|闪烁|movement speed|dash|blink/i,
  sustain: /吸血|生命偷取|生命回复|omnivamp|lifesteal|life steal|health regen/i,
  physical: /攻击力|物理伤害|attack damage|physical damage|armor penetration|护甲穿透/i,
  magic: /法术强度|魔法伤害|法术穿透|ability power|magic damage|magic penetration/i,
  defense: /护甲(?!穿透)|魔法抗性|魔抗|伤害减免|减伤|armor(?! penetration)|magic resist|damage reduction/i,
  range: /攻击距离|攻击范围|射程|attack range/i,
  attackSpeed: /攻击速度|攻速|attack speed/i,
  mana: /法力|蓝量|\bmana\b/i,
  execute: /斩杀|处决|execute/i
};

const ROLE_TAGS = {
  marksman: ['attack', 'attackSpeed', 'physical', 'crit', 'range'],
  mage: ['spell', 'magic', 'haste', 'mana'],
  tank: ['health', 'defense', 'cc'],
  fighter: ['attack', 'health'],
  assassin: ['spell', 'mobility'],
  support: ['haste', 'cc'],
  射手: ['attack', 'attackSpeed', 'physical', 'crit', 'range'],
  法师: ['spell', 'magic', 'haste', 'mana'],
  坦克: ['health', 'defense', 'cc'],
  战士: ['attack', 'health'],
  刺客: ['spell', 'mobility'],
  辅助: ['haste', 'cc']
};

// Only broad, recognizable champion mechanics, not performance rankings.
const CHAMPION_GROUPS = [
  [['Ahri', 'Annie', 'Anivia', 'AurelionSol', 'Brand', 'Cassiopeia', 'Karthus', 'Kennen', 'LeBlanc', 'Lissandra', 'Lux', 'Malzahar', 'Morgana', 'Neeko', 'Orianna', 'Syndra', 'Veigar', 'Velkoz', 'Vex', 'Viktor', 'Xerath', 'Ziggs', 'Zoe'], ['spell', 'magic']],
  [['Ashe', 'Caitlyn', 'Draven', 'Jinx', 'Kalista', 'KogMaw', 'Lucian', 'MissFortune', 'Sivir', 'Tristana', 'Twitch', 'Varus', 'Vayne', 'Xayah'], ['attack', 'attackSpeed', 'physical', 'crit']],
  [['Jhin', 'Graves'], ['attack', 'physical', 'crit']],
  [['Ezreal', 'Smolder', 'Corki', 'Jayce'], ['spell', 'attack']],
  [['Sona', 'Soraka', 'Nami', 'Milio', 'Yuumi', 'Seraphine'], ['heal', 'spell']],
  [['Janna', 'Karma', 'Lulu', 'Lux', 'Ivern', 'Morgana', 'Orianna', 'Rakan', 'Seraphine', 'Sona', 'Taric', 'Yuumi'], ['shield', 'spell']],
  [['Aatrox', 'Briar', 'DrMundo', 'Fiddlesticks', 'Illaoi', 'Maokai', 'Nunu', 'Swain', 'Vladimir', 'Warwick', 'Zac'], ['heal', 'sustain']],
  [['Alistar', 'Amumu', 'Blitzcrank', 'Braum', 'Chogath', 'Galio', 'Leona', 'Malphite', 'Maokai', 'Nautilus', 'Ornn', 'Rell', 'Sejuani', 'Sion', 'Skarner', 'TahmKench', 'Taric', 'Thresh', 'Zac'], ['cc', 'health', 'defense']],
  [['Brand', 'Lillia', 'Malzahar', 'Singed', 'Teemo'], ['burn', 'spell', 'magic']],
  [['Garen', 'Katarina', 'Kennen', 'RekSai', 'Renekton', 'Rengar', 'Riven', 'Shen', 'Vladimir', 'Zac', 'Zed', 'Akali', 'Aatrox', 'Briar', 'DrMundo', 'Sett', 'Tryndamere', 'Yasuo', 'Yone'], ['noMana']],
  [['Akali', 'Diana', 'Ekko', 'Evelynn', 'Fizz', 'Kassadin', 'Katarina'], ['spell', 'magic', 'mobility']],
  [['Irelia', 'Jax', 'MasterYi', 'Tryndamere', 'Yasuo', 'Yone'], ['attack', 'attackSpeed', 'physical']],
  [['Karthus', 'Cassiopeia', 'Ryze', 'Anivia', 'Kassadin'], ['mana']],
  [['Chogath', 'DrMundo', 'Sion', 'Vladimir', 'Zac', 'TahmKench', 'Sett'], ['health']]
];

const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');
const unique = list => [...new Set(list.filter(Boolean))];
const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
const cleanText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/〔(?:运行时内容|数值)待核实〕/g, ' ').replace(/\s+/g, ' ');
// Effect names may contain unrelated character sequences, e.g. 暴击飞弹 → 击飞.
// Only authentic effect descriptions supply mechanism evidence.
const rawText = augment => cleanText(augment?.description);
const label = tag => TAG_LABELS[tag] || tag;

/** Hard restrictions need an explicit lost action and an exclusively dependent
 * payoff. Merely mentioning an ultimate (or a borrowed one) is not a dependency.
 * Keep this shared by pair explanations and every recommendation entry point.
 */
export function getMechanicalConstraints(augment) {
  const description = rawText(augment);
  const noUltimate = /(?:无法|不能|不可)(?:施放|释放|使用)(?:你(?:的)?|自身的?|自己的?)?(?:终极技能|大招)|(?:cannot|can not|can't|unable to)\s+(?:cast|use)\s+(?:your\s+)?ultimate(?:\s+ability)?\b/i.test(description);
  const sentences = description.split(/[。；;!！?？]|\.(?=\s|$)/u).map(value => value.trim()).filter(Boolean)
    .filter(value => !/^[（(][^（）()]{0,80}(?:冷却时间|cooldown)[^（）()]{0,80}[）)]$/i.test(value));
  const dependent = sentence => {
    const trigger = sentence.split(/[，,（(]|时|后|会/u)[0];
    const ownCast = /^(?:在|当|每当|每次)?\s*(?:你)?\s*(?:施放|释放|使用)(?:你(?:的)?|自身的?|自己的?)?(?:终极技能|大招)|^(?:(?:when|whenever|after|upon)\s+)?(?:you\s+)?(?:cast(?:ing)?|us(?:e|ing))\s+(?:your\s+)?ultimate(?:\s+ability)?\b/i.test(trigger);
    // An alternate trigger still works when the holder's ultimate is disabled.
    if (ownCast && !/(?:或|或者)|\bor\b/i.test(trigger)) return true;
    if (/^(?:你的?|自身的?|自己的?)(?:终极技能|大招)(?:的)?伤害|^your ultimate(?: ability)?(?:'s)? damage/i.test(sentence)) return true;
    if (/^(?:获得|增加|提升|提高)\s*(?:\d+(?:\.\d+)?\s*(?:点)?)?终极技能急速\s*$|^(?:gain|grant|increase)\s+\d+(?:\.\d+)?\s+ultimate(?: ability)? haste\s*$/i.test(sentence)) return true;
    const clauses = sentence.split(/[，,]/u).map(value => value.trim()).filter(Boolean);
    const last = clauses.at(-1) || '';
    return /^(?:则会|则|会)?(?:返还|减少|降低|重置|刷新)(?:你的?|自身的?|自己的?)?(?:终极技能|大招)(?:的)?.{0,24}(?:冷却时间|冷却)$/u.test(last)
      && clauses.slice(0, -1).every(value => /^(?:在|当|每当|每次|如果|若)/u.test(value));
  };
  const dependencies = sentences.map((sentence, index) => dependent(sentence)
    || index > 0 && /^(?:当它|在其中|它|该效果|此效果)/u.test(sentence) && dependent(sentences[index - 1]));
  return {noUltimate, requiresUltimate: dependencies.length > 0 && dependencies.every(Boolean)};
}

function normalizeTags(tags) {
  return unique(asArray(tags).flatMap(tag => {
    const value = String(tag);
    if (TAG_LABELS[value] || value === 'noMana') return [value];
    const translated = Object.keys(TAG_LABELS).find(key => TAG_LABELS[key] === value);
    if (translated) return [translated];
    const roles = ROLE_TAGS[value.toLowerCase()];
    return roles || [];
  }));
}

/** Returns rule-derived mechanism tags, not statistics. */
export function getChampionTags(champion) {
  if (!champion) return [];
  const names = unique([champion.id, champion.enName, ...asArray(champion.aliases)].map(normalize));
  const roles = unique([...asArray(champion.roles), ...asArray(champion.tags)]);
  const tags = normalizeTags(champion.tags);
  for (const role of roles) tags.push(...(ROLE_TAGS[String(role).toLowerCase()] || []));
  for (const [ids, mechanics] of CHAMPION_GROUPS) {
    if (ids.some(id => names.includes(normalize(id)))) tags.push(...mechanics);
  }
  const result = unique(tags);
  // Riot's actual resource type takes precedence over broad role heuristics.
  // Rage, energy, heat, and "none" must never inherit Mage's mana affinity.
  const resource = String(champion.resource ?? '').trim();
  if (Object.prototype.hasOwnProperty.call(champion, 'resource')) {
    const usesMana = /^(?:mana|法力(?:值)?|魔法值)$/i.test(resource);
    return usesMana
      ? unique([...result.filter(tag => tag !== 'noMana'), 'mana'])
      : unique([...result.filter(tag => tag !== 'mana'), 'noMana']);
  }
  return result.includes('noMana') ? result.filter(tag => tag !== 'mana') : result;
}

function mechanics(augment) {
  const text = rawText(augment);
  if (!text) return {tags: [], outputs: [], triggers: [], constraints: [], requirements: []};
  let tags = unique([...normalizeTags(augment?.tags), ...Object.keys(TAG_PATTERNS).filter(tag => TAG_PATTERNS[tag].test(text))]);
  // A trigger mentioning "gain a shield" is not itself a source of shields.
  const outputText = cleanText(augment?.description)
    .replace(/(?:每当|每次|当|如果|若)[^，,。；;]{0,45}?(?:时|后)[，,]?/g, ' ')
    .replace(/(?:施加|提供|获得)[^，,。；;〔〕]{0,24}?(?:护盾|治疗|灼烧|燃烧|伤害|效果)(?:时|后)/g, ' ')
    // Increasing heal/shield power does not produce an actual heal or shield.
    .replace(/(?:治疗(?:效果)?(?:和|与|及|或))?护盾强度|治疗强度|治疗增幅|护盾增幅|healing and shielding power|healing and shielding strength|healing power|shielding power/gi, ' ');
  // Grant verbs must belong to the same clause as the granted resource.
  // Otherwise "gain cooldown reduction, your attack speed converts..." would
  // incorrectly claim that this effect produces attack speed.
  const outputClauses = outputText.split(/[，,。；;!！?？\n]|\.(?=\s|$)/).filter(Boolean);
  const hasOutput = pattern => outputClauses.some(clause => pattern.test(clause));
  const outputs = [];
  const triggers = [];
  const constraints = [];
  const requirements = [];
  const ultimate = getMechanicalConstraints(augment);
  if (ultimate.noUltimate) constraints.push('noUltimate');
  if (ultimate.requiresUltimate) requirements.push('requiresUltimate');
  if (hasOutput(/(?:获得|提供|增加|提升|提高|获取|赋予).{0,45}(?:暴击几率|暴击率)(?!\s*(?:转换|转化|转)为)|(?:gain|grant|increase).{0,30}(?:critical strike chance|crit chance)/i)) outputs.push('critChance');
  if (hasOutput(/技能.{0,12}(?:可以|能够|能|可)(?:造成)?暴击|abilities can (?:crit|critically strike)|spells can (?:crit|critically strike)/i)) outputs.push('spellCrit');
  if (hasOutput(/(?:获得|增加|提升|提高).{0,18}(?:攻击速度|攻速)(?!\s*(?:转换|转化|转)为)|(?:gain|grant|increase).{0,25}attack speed(?!\s*(?:is |are )?convert)/i)) outputs.push('attackFrequency');
  if (hasOutput(/(?:获得|增加|提升|提高).{0,16}(?:技能急速|冷却缩减|冷却减缩)(?!\s*(?:转换|转化|转)为)|(?:gain|grant|increase).{0,25}ability haste(?!\s*(?:is |are )?convert)/i)) outputs.push('spellFrequency');
  if (hasOutput(/(?:获得|增加|提升|提高).{0,16}(?:最大生命|额外生命|生命值)(?!\s*(?:转换|转化|转)为)|(?:gain|grant|increase).{0,25}(?:max(?:imum)?|bonus) health/i)) outputs.push('bonusHealth');
  if (hasOutput(/治疗(?:自身|自己|你|友军|盟友|目标)|(?:回复|恢复).{0,14}生命|(?:获得|提供).{0,10}(?:治疗|全能吸血|生命偷取)|heal (?:yourself|you|allies|an ally)|restore.{0,20}health|(?:gain|grant).{0,12}(?:omnivamp|lifesteal)/i)) outputs.push('heal');
  if (hasOutput(/(?:获得|提供|生成|施加|赋予).{0,100}护盾(?!强度|增幅)|(?:gain|grant|give|receive).{0,70}(?:a |an )?shield(?!ing power| power)/i)) outputs.push('shield');
  if (hasOutput(/(?:造成|施加|附带|使.{0,8}|会)(?:.{0,15})(?:灼烧|燃烧)|(?:apply|inflict|deal|cause).{0,25}burn|burn.{0,12}(?:damage|enemies|target)/i)) outputs.push('burn');
  if (hasOutput(/(?:造成|施加|使|会|将|并).{0,15}(?:禁锢|眩晕|晕眩|击飞|恐惧|嘲讽|魅惑|压制)|(?:stun|root|knock up|immobilize) (?:the |an? |nearby )?(?:target|enemy|enemies)/i)) outputs.push('hardCC');

  if (/普攻|普通攻击|基本攻击|(?:你的|每次)攻击(?!力|速度|距离|范围)|basic attacks?|on[- ]hit|攻击特效/i.test(text)) triggers.push('attack');
  if (/(?:施放|释放|使用).{0,10}技能|(?:cast|casting|use).{0,15}(?:an? |your )?(?:abilit|spell)/i.test(text)) triggers.push('cast');
  if (/(?:暴击|critical strikes?).{0,18}(?:时|后|会|造成|治疗|回复|grant|heal|deal)|(?:当|每次).{0,8}暴击/i.test(text)) triggers.push('crit');
  if (/(?:当|每次|每当)[^，,。；;]{0,20}(?:治疗|受到治疗)|治疗(?:自己|自身|友军|盟友|目标|他人|其他人)?(?:时|后)|你的治疗(?:或护盾|和护盾)?会|(?:whenever|when|each time).{0,25}(?:you heal|healing|are healed)/i.test(text)) triggers.push('heal');
  if (/(?:获得|提供|施加|受到|给予)[^，,。；;]{0,12}护盾(?:时|后)|你的(?:治疗(?:或|和))?护盾(?:会|能够|可以)(?:对|为|使|触发|造成|施加|治疗|生成)|(?:whenever|when|each time)[^,.!?]{0,30}(?:gain|grant|receive|give)[^,.!?]{0,12}shield/i.test(text)) triggers.push('shield');
  if (/(?:对|攻击|伤害).{0,12}(?:正在|已|被)?(?:灼烧|燃烧).{0,8}(?:敌人|目标)|(?:灼烧|持续伤害)(?:效果)?会|施加.{0,8}灼烧时|(?:against|to).{0,15}burning (?:enemies|targets)/i.test(text)) triggers.push('burn');
  if (/(?:当|每次|每当).{0,20}(?:定身|禁锢|眩晕|晕眩|击飞)|(?:定身|禁锢|眩晕|晕眩|击飞).{0,12}(?:时|后)|(?:whenever|when|after).{0,20}(?:immobiliz|stun|root|knock)/i.test(text)) triggers.push('hardCC');
  if (/(?:基于|根据|受益于|相当于|等于)(?:你的|你|自身|自己)?(?:最大生命|额外生命)|(?:每拥有|每有).{0,8}(?:最大生命|额外生命)|(?:最大生命|额外生命).{0,16}(?:转化|转为|加成)|(?:based on|per|of) (?:your )?(?:max(?:imum)?|bonus) health/i.test(text)) triggers.push('bonusHealth');
  if (/(?:无法|不能|不可)(?:进行|使用)?(?:普攻|普通攻击|基本攻击)|cannot (?:use |perform )?(?:basic )?attack/i.test(text)) constraints.push('noAttacks');
  if (/(?:你|伤害)(?:将|的伤害)?(?:无法|不能|不可)暴击|(?:your damage|you) cannot (?:crit|critically strike)/i.test(text)) constraints.push('noCrit');
  if (tags.includes('health') && !outputs.includes('bonusHealth') && !triggers.includes('bonusHealth') && !/(?:你的|自身|自己)(?:最大生命|额外生命)|(?:受益于|基于|相当于)(?:你的)?(?:最大生命|额外生命)/.test(text)) tags = tags.filter(tag => tag !== 'health');
  return {tags, outputs: unique(outputs), triggers: unique(triggers), constraints: unique(constraints), requirements};
}

/** Clones data and augments metadata without replacing authentic descriptions. */
export function enrichData(data) {
  return {
    ...data,
    champions: asArray(data?.champions).map(champion => ({...champion, mechanismTags: getChampionTags(champion)})),
    augments: asArray(data?.augments).map(augment => {
      const inferred = mechanics(augment);
      const summary = augment.summary || (augment.description ? String(augment.description).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '效果待补充，暂不判断具体适配。');
      return {...augment, tags: inferred.tags, derivedTags: inferred.tags.filter(tag => !normalizeTags(augment.tags).includes(tag)), summary, effects: inferred.outputs, triggers: inferred.triggers, constraints: inferred.constraints, requirements: inferred.requirements, mechanismNote: '标签和推荐基于文字效果推导，未代表实测胜率。'};
    }),
    combos: asArray(data?.combos)
  };
}

const relationship = (level, reason, chain = '', conditions = [], sourceUrl = '', evidence = 'mechanism') => ({level, reason, chain, conditions, sourceUrl, evidence});

/** No shared-tag-only "strong combo" claims. */
export function getSynergy(a, b, champion = null) {
  if (!a || !b) return relationship('unknown', '请选择两个海克斯后查看联动。', '', [], '', 'unknown');
  const sourceUrl = a.sourceUrl || b.sourceUrl || '';
  if (a.id != null && b.id != null && String(a.id) === String(b.id)) return relationship('conflict', '这是同一个海克斯，不能作为两个不同选择组合。', '', [], sourceUrl);
  if (a.exclusiveGroup && a.exclusiveGroup === b.exclusiveGroup) return relationship('conflict', '来源数据将这两个海克斯标记为互斥。', '', [], sourceUrl, 'documented');
  const ma = mechanics(a), mb = mechanics(b);
  for (const [first, second, fm, sm] of [[a, b, ma, mb], [b, a, mb, ma]]) {
    if (fm.constraints.includes('noUltimate') && sm.requirements.includes('requiresUltimate')) return relationship('conflict', `${first.name}禁止使用终极技能，而${second.name}的收益依赖终极技能，无法满足其核心条件。`, '禁止终极技能 → 终极技能相关收益无法触发', [], sourceUrl);
    if (fm.constraints.includes('noAttacks') && (sm.triggers.includes('attack') || sm.outputs.includes('attackFrequency'))) return relationship('conflict', `${first.name}禁止普攻，而${second.name}需要普攻或提高攻速，核心收益存在冲突。`, '禁止普攻 → 普攻相关收益受限', [], sourceUrl);
    if (fm.constraints.includes('noCrit') && (sm.tags.includes('crit'))) return relationship('conflict', `${first.name}禁止暴击，而${second.name}依赖暴击机制。`, '禁止暴击 → 暴击相关收益受限', ['需核对原始描述是否存在例外。'], sourceUrl);
  }

  for (const [first, second, fm, sm] of [[a, b, ma, mb], [b, a, mb, ma]]) {
    const nameA = first.name || '前者', nameB = second.name || '后者';
    for (const [output, trigger, category, condition] of [
      ['burn', 'burn', '灼烧', '确认两者采用同一种灼烧判定；持续伤害未必等于灼烧。'],
      ['heal', 'heal', '治疗', '确认治疗来源、治疗对象和内置冷却满足后者要求；吸血不一定计入。'],
      ['shield', 'shield', '护盾', '确认自我护盾或对友军护盾满足后者的触发条件。'],
      ['hardCC', 'hardCC', '定身控制', '确认控制类型符合定身要求；减速通常不能替代定身。'],
      ['bonusHealth', 'bonusHealth', '额外生命收益', '确认后者按最大生命值还是额外生命值计算，且没有额外上限。']
    ]) {
      if (fm.outputs.includes(output) && sm.triggers.includes(trigger)) return relationship('conditional', `${nameA}可提供${category}，${nameB}的描述中存在对应触发或数值收益，需要核对触发细则。`, `${nameA}提供${category} → 满足${nameB}条件 → 获得后续收益`, [condition, '机制推导，尚未实测该组合在当前版本中的特殊交互。'], sourceUrl);
    }
    if (fm.outputs.includes('critChance') && (sm.triggers.includes('crit') || sm.outputs.includes('spellCrit'))) return relationship('conditional', `${nameA}增加暴击几率，可提高${nameB}暴击机制的覆盖，实际收益取决于暴击规则。`, '增加暴击几率 → 更多符合规则的暴击 → 暴击效果收益', ['确认技能或效果允许暴击，以及暴击率上限、转换和伤害系数。', '机制推导，未核实特殊触发规则。'], sourceUrl);
    if (fm.outputs.includes('attackFrequency') && sm.triggers.includes('attack')) {
      const special = ['jhin', 'graves'].includes(normalize(champion?.id || champion?.enName));
      return relationship('conditional', `${nameA}提供攻速，可能提高${nameB}普攻相关效果的触发频率。`, '攻速提高 → 普攻更频繁 → 普攻效果触发机会增加', [special ? '当前英雄有特殊攻击或换弹机制，攻速不直接等比例增加攻击频率。' : '需要能够持续普攻；核对攻速上限、内置冷却与触发频率限制。', '机制推导，未核实特殊触发规则。'], sourceUrl);
    }
    if (fm.outputs.includes('spellFrequency') && sm.triggers.includes('cast')) return relationship('conditional', `${nameA}提供技能急速，可能增加${nameB}施法相关效果的触发机会。`, '技能冷却缩短 → 更多施法机会 → 施法效果收益', ['取决于技能冷却、法力和施法机会；核对是否仅限基础技能及内置冷却。', '机制推导，未实测当前版本交互。'], sourceUrl);
  }
  return relationship('unknown', '暂未从描述中识别到明确的“产出 → 触发”关系；相同标签不代表已验证联动。', '', [], sourceUrl, 'unknown');
}

const ROUTES = {
  attack: ['attack', 'attackSpeed', 'physical', 'crit', 'range'],
  spell: ['spell', 'magic', 'haste', 'mana'],
  tank: ['health', 'defense', 'cc', 'shield'],
  support: ['heal', 'shield', 'haste', 'cc'],
  crit: ['crit', 'attack', 'attackSpeed'],
  普攻: ['attack', 'attackSpeed', 'physical', 'crit', 'range'],
  技能: ['spell', 'magic', 'haste', 'mana'],
  坦克: ['health', 'defense', 'cc', 'shield'],
  辅助: ['heal', 'shield', 'haste', 'cc']
};
const WEIGHTS = {attack: 8, spell: 8, crit: 6, burn: 5, heal: 9, shield: 8, cc: 5, health: 6, haste: 4, mobility: 3, sustain: 5, physical: 4, magic: 4, defense: 5, range: 4, attackSpeed: 6, mana: 5, execute: 3};

/** Explainable suitability score. Changing champion, owned choices or route matters. */
export function recommend(augment, champion, ownedAugments = [], route = 'auto') {
  if (!augment) return {score: 0, reasons: [], cautions: ['尚未选择海克斯。'], confidence: 'unknown', matches: [], conflicts: []};
  if (augment.retiredPatch) return {score: 0, reasons: ['来源记录该海克斯已退出可选目录。'], cautions: [`退场版本：${augment.retiredPatch}；保留用于历史查询，不推荐作为本轮选择。`], confidence: 'unknown', matches: [], conflicts: []};
  const m = mechanics(augment), championTags = getChampionTags(champion);
  const owned = asArray(ownedAugments).filter(Boolean);
  const reasons = [], cautions = [], conflicts = [], matches = [];
  let score = 44;
  if (augment.availability === 'catalog-only') cautions.push('来源仅确认目录收录，尚未确认当前版本是否可选。');
  if (String(augment.description || '').includes('数值待核实')) cautions.push('来源效果中存在待核实数值，当前仅按机制方向判断。');
  if (owned.some(item => item.id != null && augment.id != null && String(item.id) === String(augment.id))) return {score: 0, reasons: ['这个海克斯已在当前已选列表中。'], cautions: ['请比较本轮其他候选项。'], confidence: 'mechanism', matches: [], conflicts: ['重复选择']};
  const overlap = m.tags.filter(tag => championTags.includes(tag));
  const weight = overlap.reduce((sum, tag) => sum + (WEIGHTS[tag] || 0), 0);
  score += Math.min(31, weight);
  matches.push(...overlap);
  if (overlap.length) reasons.push(`与${champion?.name || '当前英雄'}的${overlap.slice(0, 3).map(label).join('、')}机制方向匹配。`);
  if (!champion) cautions.push('尚未选择英雄，当前只比较海克斯之间的机制关系。');
  else if (!championTags.length) cautions.push('当前英雄的机制资料不足，无法可靠判断英雄适配。');
  else if (!overlap.length && m.tags.length) cautions.push('当前规则未找到与英雄主要机制的直接匹配；不等于这个选择一定无效。');
  if (championTags.includes('noMana') && m.tags.includes('mana')) {
    score -= 19;
    cautions.push('当前英雄不使用法力：法力相关部分可能没有收益，需核对转换规则。');
  }
  if (['jhin', 'graves'].includes(normalize(champion?.id || champion?.enName)) && m.tags.includes('attackSpeed')) cautions.push('这个英雄有特殊攻击或换弹机制，攻速收益需要单独核对。');

  const routeTags = ROUTES[route];
  if (routeTags) {
    const routeMatches = m.tags.filter(tag => routeTags.includes(tag));
    if (routeMatches.length) {
      score += Math.min(19, routeMatches.length * 7);
      reasons.push(`符合当前选择的${({attack: '普攻', spell: '技能', tank: '坦克', support: '辅助', crit: '暴击'})[route] || route}路线。`);
    } else if (m.tags.length) {
      score -= 7;
      cautions.push('与当前玩法路线的直接关联较弱。');
    }
  }
  let links = 0;
  for (const previous of owned) {
    const synergy = getSynergy(previous, augment, champion);
    if (synergy.level === 'conflict') {
      score -= 33;
      conflicts.push(previous.name || previous.id);
      cautions.push(synergy.reason);
    } else if (synergy.level === 'conditional' || synergy.level === 'strong') {
      score += links === 0 ? 16 : links === 1 ? 7 : 2;
      links += 1;
      reasons.push(`与已选「${previous.name || previous.id}」有条件联动：${synergy.reason}`);
      if (synergy.conditions[0]) cautions.push(synergy.conditions[0]);
    }
  }
  if (!m.tags.length) {
    score = Math.min(score, 40);
    cautions.push('当前规则尚不能解释该效果，暂不提供确定的适配结论。');
  }
  if (!reasons.length) reasons.push('暂未发现足够的英雄适配或已有组合证据。');
  reasons.push('以上是基于效果文字的机制推导，适配分不代表胜率。');
  return {score: Math.max(0, Math.min(100, Math.round(score))), reasons: unique(reasons), cautions: unique(cautions), confidence: overlap.length || links || conflicts.length ? 'mechanism' : 'unknown', matches: unique(matches), conflicts: unique(conflicts)};
}
