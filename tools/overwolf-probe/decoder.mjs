/**
 * In-memory observer for documented Overwolf LoL augment info updates.
 *
 * This module has no I/O and never retains an event, accumulates owned augments,
 * or produces a command to update a game/session. Each update is an independent
 * observation; an empty snapshot is uncertain, not an instruction to clear picks.
 *
 * Supported documentation shapes:
 *   { feature: 'augments', info: { me: { augments, picked_augment } } }
 *   { feature: 'augments', category: 'me', key: 'augments', value }
 * Snapshot values may be JSON strings or objects. The latter envelope is only
 * accepted for the key explicitly shown in the official augments example.
 * https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/league-of-legends/#augments
 *
 * Documentation examples are not evidence of live LoL internal-name mappings.
 */

const MAX_SLOTS = 16;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 256;
const SUPPORTED_KEYS = ['augments', 'picked_augment'];
const SOURCE_KEYS = ['sourceGameId', 'sourcePath', 'definitionKey'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A bounded UTF-8 measurement avoids allocating a second, potentially huge copy.
function exceedsByteLimit(value, limit) {
  if (value.length > limit) return true;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

function result(key, status, slots = [], unknownCount = 0) {
  return { key, status, slots, unknownCount, malformed: status === 'malformed' };
}

function readSnapshot(key, value, exactNames) {
  let snapshot = value;
  if (typeof snapshot === 'string') {
    if (exceedsByteLimit(snapshot, MAX_SNAPSHOT_BYTES)) return result(key, 'malformed');
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      return result(key, 'malformed');
    }
  }
  if (!record(snapshot)) return result(key, 'uncertain');

  const entries = Object.entries(snapshot);
  if (entries.length > MAX_SLOTS) return result(key, 'malformed');
  if (entries.length === 0) return result(key, 'uncertain');

  const prefix = key === 'augments' ? 'augment_' : 'slot_';
  const validSlot = new RegExp(`^${prefix}([1-9][0-9]?)$`);
  const slots = [];
  let unknownCount = 0;
  let examinedBytes = 0;
  for (const [slot, entry] of entries) {
    const slotMatch = validSlot.exec(slot);
    if (!slotMatch || Number(slotMatch[1]) > MAX_SLOTS) return result(key, 'uncertain');
    if (!record(entry) || !own(entry, 'name') || typeof entry.name !== 'string') {
      return result(key, 'malformed');
    }
    const name = entry.name;
    if (name.length > MAX_NAME_LENGTH) return result(key, 'malformed');
    examinedBytes += slot.length * 3 + name.length * 3;
    if (examinedBytes > MAX_SNAPSHOT_BYTES) return result(key, 'malformed');
    // Empty documented slots are not selections and do not count as unknowns.
    if (name === '') continue;
    const mapped = exactNames.get(name);
    if (!mapped) {
      unknownCount += 1;
      continue;
    }
    slots.push({ slot, nameMapped: mapped.nameMapped, id: mapped.id, gameDataId: mapped.gameDataId });
  }

  return result(key, slots.length > 0 && unknownCount === 0 ? 'observed' : 'uncertain', slots, unknownCount);
}

/**
 * Build a decoder from a catalog object ({ augments: [...] }) or augment array.
 * Only named, non-template current rows with a valid numeric gameDataId can map.
 * Source identifiers are matched exactly; a key claimed by two catalog rows is
 * deliberately blocked.
 * Returned data contains no unknown raw names or unrelated event information.
 */
export function createAugmentDecoder(catalog) {
  const rows = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.augments) ? catalog.augments : [];
  const exactNames = new Map();
  for (const row of rows) {
    if (!record(row) || row.availability !== 'current'
      || typeof row.id !== 'string' || row.id.length === 0
      || typeof row.name !== 'string' || row.name.trim().length === 0 || row.isInternalTemplate === true
      || !Number.isSafeInteger(row.gameDataId) || row.gameDataId <= 0) continue;
    const mapped = Object.freeze({ id: row.id, nameMapped: row.name, gameDataId: row.gameDataId });
    for (const field of SOURCE_KEYS) {
      const key = row[field];
      if (typeof key !== 'string' || key.length === 0 || key.length > MAX_NAME_LENGTH) continue;
      if (!exactNames.has(key)) exactNames.set(key, mapped);
      else if (exactNames.get(key) !== mapped) exactNames.set(key, null);
    }
  }

  function decode(event) {
    if (!record(event) || event.feature !== 'augments') {
      return { status: 'ignored', receivedKeys: [], updates: [], malformed: false };
    }

    const updates = [];
    const me = record(event.info) && record(event.info.me) ? event.info.me : null;
    const hasInfoUpdate = me && SUPPORTED_KEYS.some(key => own(me, key));
    const hasEnvelope = event.category === 'me' && event.key === 'augments' && own(event, 'value');
    // A combined envelope is not a documented shape. Do not choose one branch.
    if (hasInfoUpdate && hasEnvelope) {
      return { status: 'uncertain', receivedKeys: [], updates: [], malformed: false };
    }
    if (hasInfoUpdate) {
      for (const key of SUPPORTED_KEYS) {
        if (own(me, key)) updates.push(readSnapshot(key, me[key], exactNames));
      }
    } else if (hasEnvelope) {
      updates.push(readSnapshot('augments', event.value, exactNames));
    }

    const malformed = updates.some(update => update.malformed);
    const status = malformed ? 'malformed'
      : updates.length > 0 && updates.every(update => update.status === 'observed') ? 'observed' : 'uncertain';
    return { status, receivedKeys: updates.map(update => update.key), updates, malformed };
  }

  return Object.freeze({ decode });
}
