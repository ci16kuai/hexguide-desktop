// Minimal public markup contract observed on OP.GG /items, 2026-10-27.
export const rightChevron = '<svg><path d="M13.2 12 9 7.5 10.4 6l5.6 6-5.6 6L9 16.5z"></path></svg>';
export function coreRow(ids = [6655, 4646, 4645], extra = {}) {
  return {ids, play:'3,053', pick_rate:15.76, win_rate:49.1320013101867,
    metaBuildItems:ids.map(id => ({id, name:`Fixture ${id}`})), ...extra};
}
export function coreTable(rows = [coreRow()], {patch = '16.21', arrow = rightChevron, title = 'Core builds'} = {}) {
  return `<section><div>${title}</div><table><caption>Core Items Table</caption><tbody>${rows.map(row => `<tr><td>${row.ids.map(id =>
    `<div><img src="https://opgg-static.akamaized.net/meta/images/lol/${patch}.1/item/${id}.png"/></div>`).join(arrow)}</td><td><span>${row.pick_rate.toFixed(2)}%</span><span>${row.play} Games</span></td><td><strong>${row.win_rate.toFixed(2)}%</strong></td></tr>`).join('')}</tbody></table></section>`;
}
