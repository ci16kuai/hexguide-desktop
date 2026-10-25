import {createHash} from 'node:crypto';

// Versioned native descriptor: 28x28 normalized booleans, row-major, packed
// least-significant bit first into 98 bytes, then SHA-256. This is a bounded
// native classification attestation, not an independent pixel verification or
// a cryptographic authentication mechanism. No catalog aliases are assumed.
export const PANEL_GLYPH_ALGORITHM = 'normalized28-sha256-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
export const panelTemplateBinding = (id, url) => hash(`${PANEL_GLYPH_ALGORITHM}\0${id}\0${url}`);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Bind every native template to the server's ordered current/owned catalog.
 * A URL may appear for several IDs, but cannot claim different descriptors.
 * Different URLs may carry the same descriptor, as the real catalog does.
 */
export function panelGlyphIdentity(proof, offers, owned) {
  if (!record(proof) || Object.keys(proof).length !== 2 || !Object.hasOwn(proof,'algorithm') || !Object.hasOwn(proof,'templates') || proof.algorithm !== PANEL_GLYPH_ALGORITHM
    || !Array.isArray(proof.templates)) return null;
  const entries = [...offers,...owned];
  if (proof.templates.length !== entries.length || entries.length < 3 || entries.length > 9) return null;
  const byUrl = new Map(), identities = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], template = proof.templates[index];
    if (!Array.isArray(template) || template.length !== 2 || !Array.from(template).every(digest)
      || template[0] !== panelTemplateBinding(entry.id,entry.iconKey)) return null;
    const previous = byUrl.get(entry.iconKey), identity = template[1];
    if (previous !== undefined && previous !== identity) return null;
    byUrl.set(entry.iconKey,identity); identities.push(identity);
  }
  return {offers:identities.slice(0,3),owned:identities.slice(3)};
}
