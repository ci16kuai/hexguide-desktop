/** Dataset timestamps come from the saved data, never from the visitor's clock. */
export function formatDataTime(value) {
  if (!value) return '时间待核实';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间待核实';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}（${part('timeZoneName').replace('GMT', 'UTC')}）`;
}

export function getVersionInfo(meta = {}) {
  const modeVersion = meta.gameVersion || meta.modeVersion || '';
  const rulesPatch = meta.augmentPatch || meta.rulesPatch || meta.patch || '待核实';
  const statsPatch = meta.statsPatch || meta.statisticsPatch || meta.patch || '待核实';
  const updatedAt = meta.updatedAt || meta.fetchedAt || null;
  return {
    modeVersion, rulesPatch, statsPatch, updatedAt,
    championVersion: meta.championDataVersion || meta.dataDragonVersion || '待核实',
    statsDate: meta.statsDate || '待核实',
    label: modeVersion ? `${modeVersion} · ${rulesPatch}` : rulesPatch,
    updatedLabel: formatDataTime(updatedAt),
    statsLag: statsPatch !== rulesPatch
  };
}
