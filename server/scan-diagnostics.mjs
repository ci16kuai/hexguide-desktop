// Fixed, bounded machine codes shared by capture matching and session diagnostics.
// Never derive a public code from exception text, paths, window titles or OCR text.
export const NATIVE_OCR_STAGES = Object.freeze(['initializing','native-window','foreground-check','winrt-runtime','ocr-language','ocr-engine','window-bounds','capture','resize','encode','stream-write','decode','software-bitmap','recognize','result']);
export const NATIVE_OCR_CODES = Object.freeze(['ok','game-not-foreground','foreground-changed','ocr-language-missing','ocr-engine-unavailable','window-bounds-unavailable','window-size-unsupported','ocr-passes-incomplete',...NATIVE_OCR_STAGES.map(stage=>`ocr-${stage}-failed`)]);
export const OCR_SCAN_CODES = Object.freeze(['title-layout-confirmed','capture-size-invalid','ocr-no-text','title-name-unmatched','title-layout-incomplete','title-layout-ambiguous',...NATIVE_OCR_CODES.filter(code=>code!=='ok'),'ocr-unavailable','scan-busy','scan-platform-unsupported','scan-output-too-large','scan-output-invalid','scan-execution-failed']);
export const SELECTION_SCAN_CODES = Object.freeze([...OCR_SCAN_CODES,'not-scanned','scan-loop-failed','scan-context-ineligible','scan-context-changed','scan-proposals-incomplete','scan-offer-owned','scan-offer-consumed','scan-capture-stale']);
const allowed = new Set(SELECTION_SCAN_CODES);
export const sanitizeScanCode = (value, fallback = 'ocr-unavailable') => allowed.has(value) ? value : allowed.has(fallback) ? fallback : 'ocr-unavailable';

// Fixed measurements only: never retain OCR words, geometry lists, frame IDs,
// paths, exceptions or a free-form locale string in product diagnostics.
export function sanitizeOcrMeasurements(raw) {
  const diagnostics = {};
  const limits = {width:8192,height:8192,dpi:960,dpiAwareness:2,ocrMaxDimension:16384,
    lineCount:10000,passCount:20,titleRegionCount:60,exactTitleCount:300,layoutCount:100000,
    passesCompleted:20,passesFailed:20};
  for (const [key,max] of Object.entries(limits)) {
    if (Number.isSafeInteger(raw?.[key]) && raw[key] >= 0 && raw[key] <= max) diagnostics[key] = raw[key];
  }
  for (const key of ['elapsedMs','initializationMs','captureMs','recognitionMs','totalMs']) {
    if (Number.isFinite(raw?.[key]) && raw[key] >= 0 && raw[key] <= 60000) diagnostics[key] = raw[key];
  }
  for (const key of ['budgetReached','runtimeReused']) if (typeof raw?.[key] === 'boolean') diagnostics[key] = raw[key];
  if (['zh-Hans','zh-Hant','en','other'].includes(raw?.language)) diagnostics.language = raw.language;
  else if (typeof raw?.language === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(raw.language)) {
    diagnostics.language = /^zh-(?:Hans|CN|SG)(?:-|$)/i.test(raw.language) ? 'zh-Hans'
      : /^zh-(?:Hant|TW|HK|MO)(?:-|$)/i.test(raw.language) ? 'zh-Hant'
        : /^en(?:-|$)/i.test(raw.language) ? 'en' : 'other';
  }
  return diagnostics;
}
