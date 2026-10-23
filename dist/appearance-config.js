const families = new Set(['system', 'yahei', 'dengxian', 'simsun']);
const sections = ['hero', 'owned', 'offers', 'plan'];
const hasKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;

export const DEFAULT_APPEARANCE = Object.freeze({
  schemaVersion:1,
  main:Object.freeze({fontFamily:'system', scale:100, density:'comfortable', cardLayout:'grid', panelSide:'left'}),
  sidebar:Object.freeze({fontFamily:'system', scale:100, width:324, side:'right', opacity:100, sections:Object.freeze([...sections])}),
});

export function createDefaultAppearance() { return structuredClone(DEFAULT_APPEARANCE); }

/** Returns an independent, strictly validated whole settings object; never accepts CSS or paths. */
export function validateAppearance(input) {
  if (!hasKeys(input, ['schemaVersion', 'main', 'sidebar']) || input.schemaVersion !== 1
    || !hasKeys(input.main, ['fontFamily', 'scale', 'density', 'cardLayout', 'panelSide'])
    || !hasKeys(input.sidebar, ['fontFamily', 'scale', 'width', 'side', 'opacity', 'sections'])) throw new TypeError('Invalid appearance settings.');
  const {main, sidebar} = input;
  if (!families.has(main.fontFamily) || !integer(main.scale, 85, 130)
    || !['comfortable', 'compact'].includes(main.density) || !['grid', 'list'].includes(main.cardLayout)
    || !['left', 'right'].includes(main.panelSide) || !families.has(sidebar.fontFamily)
    || !integer(sidebar.scale, 85, 130) || !integer(sidebar.width, 280, 460)
    || !['left', 'right'].includes(sidebar.side) || !integer(sidebar.opacity, 75, 100)
    || !Array.isArray(sidebar.sections) || sidebar.sections.length !== sections.length
    || new Set(sidebar.sections).size !== sections.length || sidebar.sections.some(section => !sections.includes(section))) throw new TypeError('Invalid appearance settings.');
  return {
    schemaVersion:1,
    main:{fontFamily:main.fontFamily, scale:main.scale, density:main.density, cardLayout:main.cardLayout, panelSide:main.panelSide},
    sidebar:{fontFamily:sidebar.fontFamily, scale:sidebar.scale, width:sidebar.width, side:sidebar.side, opacity:sidebar.opacity, sections:[...sidebar.sections]},
  };
}
