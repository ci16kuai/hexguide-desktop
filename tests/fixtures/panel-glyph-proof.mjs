import {createHash} from 'node:crypto';
import {PANEL_GLYPH_ALGORITHM,panelTemplateBinding} from '../../server/panel-glyph-identity.mjs';

// Synthetic descriptors for boundary/integration fixtures only. Tests with real
// catalog assets supply fingerprints produced by the actual native extractor.
export function glyphProof(offers, owned = [], glyphFor = url => createHash('sha256').update(url).digest('hex')) {
  return {algorithm:PANEL_GLYPH_ALGORITHM,templates:[...offers,...owned].map(entry => {
    const url = entry.iconKey ?? entry.icon;
    return [panelTemplateBinding(entry.id,url),glyphFor(url,entry.id)];
  })};
}
