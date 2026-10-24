// Every event below is SYNTHETIC. Passing these tests is not evidence that
// Overwolf supplies usable events in a live LoL match, region, or custom room.
import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../../dist/data.json' with { type: 'json' };
import { createAugmentDecoder } from './decoder.mjs';

const row = {
  availability: 'current', id: 'synthetic_augment', name: 'Synthetic local display name',
  gameDataId: 1234, sourceGameId: 'ARAM_Synthetic',
  sourcePath: 'Maps/ModeSpecificData/Augments/ARAM_Synthetic', definitionKey: '{12345678}',
};
const decoder = createAugmentDecoder({ augments: [row] });
const info = (value, key = 'picked_augment') => ({ feature: 'augments', info: { me: { [key]: value } } });
const picked = name => info({ slot_1: { name } });
const expectedSlot = { slot: 'slot_1', nameMapped: row.name, id: row.id, gameDataId: row.gameDataId };

test('synthetic: exact internal source keys map without normalization', () => {
  for (const key of ['sourceGameId', 'sourcePath', 'definitionKey']) {
    const result = decoder.decode(picked(row[key]));
    assert.equal(result.status, 'observed');
    assert.deepEqual(result.updates[0].slots, [expectedSlot]);
  }
  for (const rawName of ['aram_synthetic', 'Synthetic', 'ARAM_Synthetic ', row.name]) {
    assert.equal(decoder.decode(picked(rawName)).updates[0].unknownCount, 1);
  }
});

test('synthetic: all 248 named non-template current catalog entries map by exact source key', () => {
  const current = catalog.augments.filter(augment => augment.availability === 'current');
  assert.equal(current.length, 249);
  const displayable = current.filter(augment => augment.name.trim().length > 0 && augment.isInternalTemplate !== true);
  assert.equal(displayable.length, 248);
  const actualCatalogDecoder = createAugmentDecoder(catalog);
  for (const augment of displayable) {
    const result = actualCatalogDecoder.decode(picked(augment.sourceGameId));
    assert.equal(result.status, 'observed', augment.id);
    assert.equal(result.updates[0].slots[0].gameDataId, augment.gameDataId);
    assert.equal(result.updates[0].slots[0].id, augment.id);
  }
});

test('synthetic: blank names and internal templates cannot become mapped selections', () => {
  for (const override of [{ name: '' }, { name: '   ' }, { isInternalTemplate: true }]) {
    const result = createAugmentDecoder([{ ...row, ...override }]).decode(picked(row.sourceGameId));
    assert.equal(result.status, 'uncertain');
    assert.deepEqual(result.updates[0].slots, []);
    assert.equal(result.updates[0].unknownCount, 1);
  }
  const mystery = catalog.augments.find(augment => augment.id === 'mystery_augment');
  assert.equal(mystery.isInternalTemplate, true);
  const result = createAugmentDecoder(catalog).decode(picked(mystery.sourceGameId));
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.updates[0].slots, []);
});

test('synthetic: unknown TFT documentation names cannot become LoL selections or escape output', () => {
  const rawName = 'TFT9_Augment_CyberneticBulk3';
  const result = decoder.decode(picked(rawName));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.updates[0].unknownCount, 1);
  assert.deepEqual(result.updates[0].slots, []);
  assert.equal(JSON.stringify(result).includes(rawName), false);
});

test('synthetic: JSON-string snapshots and the documented candidate update envelope work', () => {
  const result = decoder.decode({ feature: 'augments', category: 'me', key: 'augments',
    value: JSON.stringify({ augment_1: { name: row.sourceGameId }, augment_2: { name: '' } }) });
  assert.equal(result.status, 'observed');
  assert.deepEqual(result.receivedKeys, ['augments']);
  assert.equal(result.updates[0].slots[0].slot, 'augment_1');
  assert.equal(result.updates[0].unknownCount, 0);
});

test('synthetic: unrelated features and player fields are discarded', () => {
  const privateText = 'DoNotRetain_PlayerName_OrToken';
  const result = decoder.decode({ ...picked(row.sourceGameId), token: privateText,
    info: { me: { picked_augment: { slot_1: { name: row.sourceGameId, playerName: privateText } },
      summonerName: privateText }, players_tagline: [{ playerName: privateText }] } });
  assert.equal(result.status, 'observed');
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.deepEqual(decoder.decode({ ...picked(row.sourceGameId), feature: 'teams' }),
    { status: 'ignored', receivedKeys: [], updates: [], malformed: false });
});

test('synthetic: malformed JSON and invalid slot records do not leak partial observations', () => {
  for (const value of ['{broken', { slot_1: { name: row.sourceGameId }, slot_2: { name: 123 } }]) {
    const result = decoder.decode(info(value));
    assert.equal(result.status, 'malformed');
    assert.equal(result.malformed, true);
    assert.deepEqual(result.updates[0].slots, []);
  }
});

test('synthetic: empty snapshots remain uncertain and contain no reset or clear command', () => {
  for (const value of [{}, { slot_1: { name: '' }, slot_2: { name: '' } }]) {
    const result = decoder.decode(info(value));
    assert.equal(result.status, 'uncertain');
    assert.deepEqual(result.updates[0].slots, []);
    assert.equal(result.updates[0].unknownCount, 0);
    assert.deepEqual(Object.keys(result), ['status', 'receivedKeys', 'updates', 'malformed']);
    assert.deepEqual(Object.keys(result.updates[0]), ['key', 'status', 'slots', 'unknownCount', 'malformed']);
  }
});

test('synthetic: repeated updates are independent snapshots and are never appended', () => {
  const event = picked(row.sourceGameId);
  const first = decoder.decode(event);
  const second = decoder.decode(event);
  assert.deepEqual(first, second);
  first.updates[0].slots[0].id = 'changed-only-in-output';
  assert.deepEqual(decoder.decode(event).updates[0].slots, [expectedSlot]);
});

test('synthetic: conflicting catalog identifiers fail closed without throwing', () => {
  const conflictDecoder = createAugmentDecoder([row,
    { ...row, id: 'other', name: 'Other local name', gameDataId: 5678 }]);
  const result = conflictDecoder.decode(picked(row.sourceGameId));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.updates[0].unknownCount, 1);
  assert.deepEqual(result.updates[0].slots, []);
  assert.equal(createAugmentDecoder([{ ...row, availability: 'retired-in-source' }])
    .decode(picked(row.sourceGameId)).status, 'uncertain');
});

test('synthetic: slot and UTF-8 byte bounds reject oversized snapshots', () => {
  const seventeenSlots = Object.fromEntries(Array.from({ length: 17 }, (_, index) =>
    [`slot_${index + 1}`, { name: row.sourceGameId }]));
  for (const value of [seventeenSlots, ' '.repeat(64 * 1024 + 1), '中'.repeat(23000),
    { slot_1: { name: 'x'.repeat(257) } }]) {
    assert.equal(decoder.decode(info(value)).status, 'malformed');
  }
});

test('synthetic: unsupported shapes remain uncertain without extracting nested data', () => {
  for (const value of [null, [], { name: row.sourceGameId }, { slot_0: { name: row.sourceGameId } }]) {
    const result = decoder.decode(info(value));
    assert.equal(result.status, 'uncertain');
    assert.deepEqual(result.updates[0].slots, []);
  }
  assert.equal(decoder.decode({ feature: 'augments', category: 'me', key: 'picked_augment',
    value: JSON.stringify({ slot_1: { name: row.sourceGameId } }) }).status, 'uncertain');
});

test('synthetic: available candidates and picked slots remain separate observations', () => {
  const result = decoder.decode({ feature: 'augments', info: { me: {
    augments: { augment_1: { name: row.sourceGameId } },
    picked_augment: JSON.stringify({ slot_1: { name: row.sourceGameId } }),
  } } });
  assert.equal(result.status, 'observed');
  assert.deepEqual(result.receivedKeys, ['augments', 'picked_augment']);
  assert.deepEqual(result.updates.map(update => update.slots[0].slot), ['augment_1', 'slot_1']);
});

test('synthetic: a partially mapped snapshot is uncertain and omits unknown names', () => {
  const result = decoder.decode(info({
    slot_1: { name: row.sourceGameId }, slot_2: { name: 'Unverified_InternalName' },
  }));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.updates[0].unknownCount, 1);
  assert.deepEqual(result.updates[0].slots, [expectedSlot]);
  assert.equal(JSON.stringify(result).includes('Unverified_InternalName'), false);
});

test('synthetic: a combined info and category/key envelope is ambiguous', () => {
  const result = decoder.decode({ ...picked(row.sourceGameId), category: 'me', key: 'augments',
    value: { augment_1: { name: row.sourceGameId } } });
  assert.deepEqual(result, { status: 'uncertain', receivedKeys: [], updates: [], malformed: false });
});
