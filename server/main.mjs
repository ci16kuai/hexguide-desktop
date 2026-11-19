import {readFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {LiveCollector} from './collector.mjs';
import {createLocalServer} from './http.mjs';
import {createOcrScanner} from './ocr.mjs';
import {BackgroundSidebar} from './sidebar.mjs';
import {AppearanceStore} from './appearance.mjs';
import {LayoutStore} from './layout.mjs';
import {RecommendationRepository} from './recommendation-repository.mjs';
import {StatisticsUpdater} from './statistics-updater.mjs';
import {RulesUpdater} from './rules.mjs';
import {AnnouncementStore} from './announcements.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

function catalogSnapshot(dataset) {
  const content = JSON.stringify(dataset);
  return {revision:createHash('sha256').update(content).digest('hex'), augmentPatch:dataset.meta.augmentPatch, content};
}

try {
  const requestedPort = argument('--port') ?? '0';
  if (!/^\d+$/.test(requestedPort) || Number(requestedPort) > 65535) throw new Error('Invalid port.');
  const dataDirectory = argument('--data-dir');
  if (dataDirectory) await mkdir(path.resolve(dataDirectory), {recursive:true});
  const [bundledData, championResource, ca, itemsCatalog, statisticsSnapshot] = await Promise.all([
    readFile(path.join(directory, '../dist/data.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'resources/champions-16.21.1.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'resources/riotgames.pem')),
    readFile(path.join(directory, '../dist/items.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, '../dist/statistics.json'), 'utf8').then(JSON.parse).catch(() => null),
  ]);
  const rules = await new RulesUpdater({catalog:bundledData, dataDirectory, onUpdate:next => {
    const snapshot = catalogSnapshot(next);
    browsingCatalog = snapshot;
    statistics?.replaceAugments(next.augments);
    sidebar.stageCatalog(next.augments, () => {
      collector.replaceAugments(next.augments);
      scanner.replaceAugments(next.augments);
      recommendationRepository.replaceAugments(next.augments);
      matchCatalog = snapshot;
    });
  }}).load();
  const dataset = rules.getSnapshot();
  let browsingCatalog = catalogSnapshot(dataset), matchCatalog = browsingCatalog;
  const collector = new LiveCollector({champions:dataset.champions, officialChampions:championResource.champions, augments:dataset.augments, ca});
  const scanner = createOcrScanner({applicationDirectory:path.resolve(directory, '..'), dataDirectory, augments:dataset.augments});
  const appearance = await new AppearanceStore({dataDirectory}).load();
  const layout = await new LayoutStore({dataDirectory}).load();
  const announcements = await new AnnouncementStore({dataDirectory,bundledDirectory:path.join(directory,'../dist/announcements')}).load();
  let recommendationRepository;
  let statistics;
  try {
    statistics = await new StatisticsUpdater({dataDirectory, bundledSnapshot:statisticsSnapshot, gameData:{...dataset,meta:bundledData.meta},
      championCatalog:championResource, onUpdate:snapshot => recommendationRepository?.replaceStatistics(snapshot)}).load();
  } catch { /* Optional statistics must never prevent the assistant from opening. */ }
  recommendationRepository = await new RecommendationRepository({dataDirectory, statisticsSnapshot:statistics?.getSnapshot() ?? statisticsSnapshot,
    champions:dataset.champions, augments:dataset.augments,
    patch:statistics?.getSnapshot().meta.patch ?? dataset.meta.clientDataVersion ?? '16.21'}).load();
  const sidebar = await new BackgroundSidebar({collector, scanner, data:dataset, itemsCatalog, dataDirectory, appearance, recommendationRepository}).load();
  const local = await createLocalServer({collector, scanner, sidebar, appearance, layout, statistics, announcements,
    getCatalog:scope => scope === 'match' ? matchCatalog : browsingCatalog,
    staticDirectory:path.join(directory, '../dist'), port:Number(requestedPort)});
  // This is the sole stdout bootstrap line; the native parent owns the token.
  process.stdout.write(JSON.stringify({port:local.port, token:local.token}) + '\n');
  collector.start();
  sidebar.start();
  statistics?.start();
  announcements.start();
  rules.start();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await rules.close();
    await statistics?.close();
    await announcements.close();
    await local.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  process.stderr.write('本地服务未能启动，请检查程序文件是否完整、端口是否可用。\n');
  process.exitCode = 1;
}
