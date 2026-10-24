// Fixed, bounded machine codes shared by capture matching and session diagnostics.
// Never derive a public code from exception text, paths, window titles or OCR text.
export const NATIVE_OCR_STAGES = Object.freeze(['initializing','native-window','foreground-check','winrt-runtime','ocr-language','ocr-engine','window-bounds','capture','resize','encode','stream-write','decode','software-bitmap','recognize','result']);
export const NATIVE_OCR_CODES = Object.freeze(['ok','game-not-foreground','foreground-changed','ocr-language-missing','ocr-engine-unavailable','window-bounds-unavailable','window-size-unsupported','ocr-passes-incomplete',...NATIVE_OCR_STAGES.map(stage=>`ocr-${stage}-failed`)]);
export const OCR_SCAN_CODES = Object.freeze(['title-layout-confirmed','capture-size-invalid','ocr-no-text','title-name-unmatched','title-layout-incomplete','title-layout-ambiguous',...NATIVE_OCR_CODES.filter(code=>code!=='ok'),'ocr-unavailable','scan-busy','scan-platform-unsupported','scan-output-too-large','scan-output-invalid','scan-execution-failed']);
export const SELECTION_SCAN_CODES = Object.freeze([...OCR_SCAN_CODES,'not-scanned','scan-loop-failed','scan-context-ineligible','scan-context-changed','scan-proposals-incomplete','scan-offer-owned','scan-offer-consumed','scan-capture-stale']);
const allowed = new Set(SELECTION_SCAN_CODES);
export const sanitizeScanCode = (value, fallback = 'ocr-unavailable') => allowed.has(value) ? value : allowed.has(fallback) ? fallback : 'ocr-unavailable';
