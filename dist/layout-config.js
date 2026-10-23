import {UI_ELEMENTS} from './layout-elements.js';

export {UI_ELEMENTS};
export const MAX_LAYOUT_BYTES = 32768;
export const DEFAULT_LAYOUT = Object.freeze({schemaVersion:1, elements:Object.freeze({}), orders:Object.freeze({})});
export function createDefaultLayout() { return structuredClone(DEFAULT_LAYOUT); }

const registry = new Map(UI_ELEMENTS.map(element => [element.id, element]));
const families = new Set(['system', 'yahei', 'dengxian', 'simsun']);
const alignments = new Set(['left', 'center', 'right']);
const hexadecimalColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const integer = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const allowed = {
  hidden:value => typeof value === 'boolean',
  fontFamily:value => families.has(value),
  fontSize:value => integer(value, 10, 60),
  color:hexadecimalColor,
  background:value => value === 'transparent' || hexadecimalColor(value),
  padding:value => integer(value, 0, 64),
  align:value => alignments.has(value),
  width:value => integer(value, 0, 1600),
  height:value => integer(value, 0, 900),
  columns:value => integer(value, 1, 3),
  gap:value => integer(value, 0, 48),
  span:value => integer(value, 1, 3),
  borderRadius:value => integer(value, 0, 32),
};

/** A sparse, versioned interface model. No CSS, HTML, selectors, paths or game data are accepted. */
export function validateLayout(input) {
  const invalid = () => { throw new TypeError('Invalid interface layout.'); };
  if (!record(input) || input.schemaVersion !== 1 || Object.keys(input).length !== 3
    || !Object.hasOwn(input, 'schemaVersion') || !Object.hasOwn(input, 'elements') || !Object.hasOwn(input, 'orders')
    || !record(input.elements) || !record(input.orders)) return invalid();
  const elements = {};
  for (const [id, overrides] of Object.entries(input.elements)) {
    const element = registry.get(id);
    if (!element || !record(overrides)) return invalid();
    const clean = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.hasOwn(allowed, key) || !allowed[key](value)
        || (['columns', 'gap'].includes(key) && !element.container)) return invalid();
      clean[key] = value;
    }
    elements[id] = clean;
  }
  const orders = {};
  for (const [id, children] of Object.entries(input.orders)) {
    const element = registry.get(id);
    if (!element?.container || !Array.isArray(children) || new Set(children).size !== children.length
      || children.some(child => typeof child !== 'string' || !registry.has(child) || registry.get(child).parent !== id)) return invalid();
    orders[id] = [...children];
  }
  return {schemaVersion:1, elements, orders};
}
