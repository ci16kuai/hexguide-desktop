import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

// Independent acceptance checks for the 4.0 migration. These expectations come
// from Riot's final 26.21 notes, not the updater or the site's recommendations:
// https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-21-notes/
// Small frozen fixtures were extracted from the original sources, never from
// dist/data.json. No scratch files or network access are needed for npm test.
// HEXGUIDE_SOURCE_DIR additionally checks those fixtures against full raw caches.
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const [data, membership, statistics] = await Promise.all([
  readJson(new URL('../dist/data.json', import.meta.url)),
  readJson(new URL('./fixtures/kiwi-membership-26.21.json', import.meta.url)),
  readJson(new URL('./fixtures/pick-rates-26.20.json', import.meta.url))
]);

const NEW_AUGMENTS = {
  silver: [
    ['blue_barrier', 'Blue Barrier'],
    ['flow_of_spirit', 'Flow of Spirit'],
    ['fruitify', 'Fruitify'],
    ['gift_of_the_drowned', 'Gift of the Drowned'],
    ['hands_off_the_talent', 'Hands Off The Talent'],
    ['lich_brain', 'Lich Brain'],
    ['lonely_warrior', 'Lonely Warrior'],
    ['no_mana_no_problem', 'No Mana, No Problem'],
    ['sound_barrier', 'Sound Barrier'],
    ['ultimate_recursion', 'Ultimate Recursion']
  ],
  gold: [
    ['arcane_axiom', 'Arcane Axiom'],
    ['armored_impact', 'Armored Impact'],
    ['bees', 'BEES!!!'],
    ['brass_blast', 'Brass Blast'],
    ['crimson_cobalt', 'CRIMSON COBALT'],
    ['double_time', 'Double Time'],
    ['enchanting_butterflies', 'Enchanting Butterflies'],
    ['get_jinxed', 'Get Jinxed'],
    ['heavy_is_the_crown', 'Heavy Is The Crown'],
    ['jeweled_bracelet', 'Jeweled Bracelet'],
    ['recoil', 'Recoil'],
    ['salvation', 'Salvation'],
    ['sap_magic', 'Sap Magic'],
    ['still_here', 'Still Here'],
    ['take_em_down_down_down', 'Take’em Down Down Down'],
    ['the_boom_and_the_bass', 'The Boom and the Bass'],
    ['tickle_monster', 'Tickle Monster'],
    ['upgrade_stormsurge', 'Upgrade: Stormsurge'],
    ['weapon_of_destiny', 'Weapon Of Destiny']
  ],
  prismatic: [
    ['big_shot', 'Big Shot'],
    ['bouncing_bees', 'Bouncing Bees'],
    ['group_hug', 'Group Hug'],
    ['mosh_monster', 'Mosh Monster'],
    ['third_times_the_harm', 'Third Times The Harm'],
    ['totentanz', 'Totentanz']
  ]
};
const REMOVED_AUGMENTS = [
  ['combusting_interest', 'Combusting Interest'],
  ['crit_n_cast', "Crit 'n Cast"],
  ['critical_missile', 'Critical Missile'],
  ['dimension_shift', 'Dimension Shift'],
  ['dropbear', 'DropBear'],
  ['dropkick', 'Dropkick'],
  ['fan_the_hammer', 'Fan the Hammer'],
  ['hide_on_bush', 'Hide on Bush'],
  ['high_roller', 'High Roller'],
  ['our_healing', 'Our Healing'],
  ['poro_stampede', 'Poro Stampede'],
  ['spiritual_purification', 'Spiritual Purification'],
  ['ult_bot', 'Ult Bot']
];
const SPECIAL_PENTAKILL = new Set([
  'GoH_PentakillAug_Q', 'GoH_PentakillAug_W', 'GoH_PentakillAug_E',
  'GoH_PentakillAug_R'
]);
const INTERNAL_TEMPLATE = 'GoH_PentakillAug_Generic';
const normalizedName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// BIN references may be raw hashes while CommunityDragon also exposes a
// readable path. Verify the reference itself rather than ignoring that change.
const hashSourcePath = value => {
  let hash = 0x811c9dc5;
  for (const character of String(value).toLowerCase()) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  return `{${hash.toString(16).padStart(8, '0')}}`;
};
const byId = new Map(data.augments.map(item => [item.id, item]));
const findOfficial = ([id, name]) => byId.get(id) || data.augments.find(item => normalizedName(item.enName) === normalizedName(name));
const sameSet = (label, actualValues, expectedValues) => {
  const actual = new Set(actualValues), expected = new Set(expectedValues);
  const missing = [...expected].filter(value => !actual.has(value));
  const unexpected = [...actual].filter(value => !expected.has(value));
  assert.deepEqual({missing, unexpected}, {missing: [], unexpected: []}, label);
};

assert.equal(membership.sourceUrl, 'https://raw.communitydragon.org/16.21/game/maps/modespecificdata/kiwi.bin.json');
assert.equal(membership.gamePatch, '26.21');
assert.equal(membership.mode, 'KIWI');
assert.equal(statistics.sourceUrl, 'https://arammayhem.com/data/v1/26-20/augments.json');
for (const fixture of [membership, statistics]) assert.match(fixture.sourceSha256, /^[0-9a-f]{64}$/, 'Fixtures must retain original-file provenance.');
if (process.env.HEXGUIDE_SOURCE_DIR) {
  const sourceDir = process.env.HEXGUIDE_SOURCE_DIR;
  const [rawKiwi, rawStatistics] = await Promise.all([
    readJson(path.join(sourceDir, 'update-4', 'kiwi.bin.json')),
    readJson(path.join(sourceDir, 'source-cache', 'augments.json'))
  ]);
  const sourceLists = Object.values(rawKiwi).filter(entry => Array.isArray(entry?.AugmentList));
  assert.equal(sourceLists.length, 1, 'The raw KIWI file needs one authoritative list.');
  const extracted = sourceLists[0].AugmentList.map(sourcePath => {
    const definition = rawKiwi[sourcePath];
    assert.equal(definition?.__type, 'AugmentData', `Unresolved original reference: ${sourcePath}`);
    return {sourceGameId: definition.AugmentNameId, sourcePath, gameDataId: definition.AugmentPlatformId};
  });
  assert.deepEqual(membership.entries, extracted, 'Membership fixture differs from the independent raw game source.');
  assert.deepEqual(statistics.meta, rawStatistics.meta, 'Statistical fixture metadata differs from the raw source.');
  assert.deepEqual(statistics.rows, rawStatistics.rows.map(row => ({augmentId: row.augmentId, pickRate: row.pickRate})), 'Statistical fixture differs from the original 26.20 source rows.');
}

assert.equal(data.meta.gameVersion, '4.0', 'Game mode release must be 4.0.');
assert.equal(data.meta.patch, '26.21', 'Rules must use the official patch number, 26.21.');
assert.equal(data.meta.dataDragonVersion, '16.21.1', 'Static assets have their own 16.21.1 version.');
assert.equal(data.meta.statsPatch, '26.20', 'Do not relabel the old statistics as 26.21.');
assert.equal(statistics.meta.patch, '26.20', 'The comparison fixture itself must remain the old source snapshot.');
assert.equal(data.meta.statsDate, statistics.meta.statsDate, 'Keep the statistics date from the independent source.');
assert.equal(byId.size, data.augments.length, 'Augment IDs must be unique.');
assert.equal(new Set(data.champions.map(item => item.id)).size, data.champions.length, 'Champion IDs must be unique.');
for (const item of [...data.augments, ...data.champions]) {
  if (item.isInternalTemplate) continue;
  for (const field of ['name', 'description']) {
    if (item[field] == null) continue;
    assert.ok(!String(item[field]).includes('\uFFFD'), `${item.id}.${field} contains Unicode replacement characters; source localization must survive conversion.`);
  }
}
for (const [id, name] of [
  ['blue_barrier', '蓝色屏障'], ['double_time', '翻倍时间'],
  ['jeweled_bracelet', '珠光手镯'], ['totentanz', '死之舞']
]) assert.equal(byId.get(id)?.name, name, `The localized name of ${id} must be preserved.`);

for (const field of ['fetchedAt', 'updatedAt']) {
  const value = data.meta[field];
  assert.match(value || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, `${field} needs an explicit time zone.`);
  const timestamp = Date.parse(value);
  assert.ok(Number.isFinite(timestamp), `${field} must be a valid saved timestamp.`);
  assert.ok(timestamp <= Date.now() + 300_000, `${field} cannot be in the future.`);
  assert.ok(timestamp >= Date.parse('2026-10-21T00:00:00Z'), `${field} must refer to this migration, not an earlier release.`);
}
assert.ok(Date.parse(data.meta.updatedAt) >= Date.parse(data.meta.fetchedAt), 'Update time cannot precede fetching time.');

const newEntries = Object.entries(NEW_AUGMENTS).flatMap(([rarity, entries]) => entries.map(entry => ({rarity, entry})));
assert.equal(newEntries.length, 35);
for (const {rarity, entry} of newEntries) {
  const item = findOfficial(entry);
  assert.ok(item, `Missing official new augment: ${entry[1]}`);
  assert.equal(normalizedName(item.enName), normalizedName(entry[1]), `Wrong English definition mapped to ${entry[0]}.`);
  assert.equal(item.availability, 'current', `${entry[1]} is an official 26.21 addition, not an unconfirmed catalog entry.`);
  assert.equal(item.rarity, rarity, `${entry[1]} has the wrong quality.`);
  assert.notEqual(item.recommendable, false, `${entry[1]} should be available to ordinary selection.`);
  assert.ok(!item.retiredPatch, `${entry[1]} must not inherit a retired flag.`);
  assert.equal(item.pickRate ?? null, null, `${entry[1]} has no 26.20 statistical sample; do not invent a new rate.`);
  assert.equal(item.winRate ?? null, null, `${entry[1]} must not contain fabricated win rates.`);
}
for (const entry of REMOVED_AUGMENTS) {
  const item = findOfficial(entry);
  if (!item) continue; // A historical definition need not be included in the UI.
  assert.notEqual(item.availability, 'current', `${entry[1]} was removed in Riot's final 26.21 notes.`);
  assert.ok(item.retiredPatch, `${entry[1]} needs an explicit retirement marker if retained.`);
}

// Compare the *actual* KIWI source list, including its original hashed paths.
// A union with CHERRY or KIWI_JADE can have a plausible count but fails this test.
const sourceEntries = membership.entries;
const sourceById = new Map(sourceEntries.map(entry => [entry.sourceGameId, entry]));
assert.equal(sourceById.size, sourceEntries.length, 'The source list must not contain duplicate game IDs.');
const current = data.augments.filter(item => item.availability === 'current');
sameSet('Current entries must exactly match the original KIWI source IDs.', current.map(item => item.sourceGameId), sourceById.keys());
assert.equal(new Set(current.map(item => item.sourceGameId)).size, current.length, 'One game augment must not become duplicate current entries.');
for (const item of data.augments) {
  assert.ok(['current', 'catalog-only', 'retired', 'retired-in-source'].includes(item.availability), `${item.id} has an ambiguous availability value.`);
  if (item.availability.startsWith('retired')) assert.ok(item.retiredPatch, `${item.id} needs an explicit historical retirement marker.`);
  if (item.availability !== 'current') continue;
  const original = sourceById.get(item.sourceGameId);
  if (/^\{[0-9a-f]{8}\}$/i.test(original.sourcePath)) {
    assert.equal(item.definitionKey, original.sourcePath, `${item.id} must retain the original KIWI reference key.`);
    assert.equal(hashSourcePath(item.sourcePath), original.sourcePath, `${item.id} readable source path resolves to the wrong KIWI reference.`);
  } else {
    assert.equal(item.sourcePath, original.sourcePath, `${item.id} must preserve its original KIWI source path.`);
  }
  assert.equal(item.gameDataId, original.gameDataId, `${item.id} has the wrong numeric game ID.`);
  assert.ok(!item.retiredPatch, `${item.id} is in the current game source; a historical retired flag must not suppress its return.`);
}
const specials = current.filter(item => SPECIAL_PENTAKILL.has(item.sourceGameId));
sameSet('Keep the four obtainable Pentakill event definitions separate from normal offers.', specials.map(item => item.sourceGameId), SPECIAL_PENTAKILL);
for (const item of specials) {
  assert.equal(item.acquisition, 'headliner-only', `${item.id} is a Headliner-specific definition.`);
  assert.equal(item.recommendable, false, `${item.id} must not appear as an ordinary three-choice option.`);
}
const internalTemplates = current.filter(item => item.isInternalTemplate);
sameSet('The empty Generic definition must be explicitly identified as an internal template.', internalTemplates.map(item => item.sourceGameId), [INTERNAL_TEMPLATE]);
assert.equal(internalTemplates[0].recommendable, false, 'An internal template must never be an obtainable recommendation.');
const ordinary = current.filter(item => item.recommendable !== false);
sameSet('Normal recommendations must exclude four event definitions and the internal template.', ordinary.map(item => item.sourceGameId), [...sourceById.keys()].filter(id => !SPECIAL_PENTAKILL.has(id) && id !== INTERNAL_TEMPLATE));
const icathia = data.augments.find(item => normalizedName(item.enName) === 'icathiasfall');
assert.ok(icathia && icathia.availability === 'current', "Icathia's Fall must reflect its return in the game source.");
assert.ok(!icathia.retiredPatch && icathia.sourceRetiredPatch, 'Preserve the old site retirement as provenance, not as the current status.');

const sourceStats = new Map(statistics.rows.map(row => [row.augmentId, row]));
for (const row of statistics.rows) {
  const item = byId.get(row.augmentId);
  assert.ok(item, `Do not silently delete historical statistics: ${row.augmentId}`);
  assert.equal(item.pickRate, row.pickRate, `Historical pick rate was changed: ${row.augmentId}`);
}
for (const item of data.augments) {
  assert.equal(item.winRate ?? null, null, `The licensed source does not publish augment win rates: ${item.id}`);
  if (item.pickRate == null) continue;
  assert.ok(Number.isFinite(item.pickRate), `Invalid pick rate: ${item.id}`);
  assert.ok(sourceStats.has(item.id), `No statistical source for ${item.id}; a value must not be invented.`);
  assert.equal(item.statsPatch || data.meta.statsPatch, statistics.meta.patch, `Statistics for ${item.id} were relabeled.`);
  assert.equal(item.pickRate, sourceStats.get(item.id).pickRate, `The saved rate differs from the independent source: ${item.id}`);
}
for (const champion of data.champions) {
  assert.equal(champion.dataVersion, '16.21.1', `Stale champion metadata: ${champion.id}`);
  assert.match(champion.icon || '', /^https:\/\/ddragon\.leagueoflegends\.com\/cdn\/16\.21\.1\/img\/champion\//, `Stale champion icon: ${champion.id}`);
  assert.match(champion.sourceUrl || '', /\/cdn\/16\.21\.1\/data\/zh_CN\/champion\.json$/, `Stale champion source: ${champion.id}`);
}

console.log(`PASS: 4.0 / 26.21 rules; 35 official additions; 13 removal rules; exact ${current.length}-ID KIWI pool (${ordinary.length} ordinary, ${specials.length} Headliner-only, ${internalTemplates.length} internal template); ${statistics.rows.length} unchanged 26.20 pick rates; ${data.champions.length} champions on 16.21.1; valid saved timestamps.`);
