import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {LiveCollector} from './collector.mjs';
import {createLocalServer} from './http.mjs';
import {createOcrScanner} from './ocr.mjs';
import {BackgroundSidebar} from './sidebar.mjs';
import {AppearanceStore} from './appearance.mjs';
import {LayoutStore} from './layout.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

try {
  const requestedPort = argument('--port') ?? '0';
  if (!/^\d+$/.test(requestedPort) || Number(requestedPort) > 65535) throw new Error('Invalid port.');
  const dataDirectory = argument('--data-dir');
  if (dataDirectory) await mkdir(path.resolve(dataDirectory), {recursive:true});
  const [dataset, championResource, ca, itemsCatalog] = await Promise.all([
    readFile(path.join(directory, '../dist/data.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'resources/champions-16.21.1.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'resources/riotgames.pem')),
    readFile(path.join(directory, '../dist/items.json'), 'utf8').then(JSON.parse),
  ]);
  const collector = new LiveCollector({champions:dataset.champions, officialChampions:championResource.champions, augments:dataset.augments, ca});
  const scanner = createOcrScanner({applicationDirectory:path.resolve(directory, '..'), dataDirectory, augments:dataset.augments});
  const appearance = await new AppearanceStore({dataDirectory}).load();
  const layout = await new LayoutStore({dataDirectory}).load();
  const sidebar = await new BackgroundSidebar({collector, scanner, data:dataset, itemsCatalog, dataDirectory, appearance}).load();
  const local = await createLocalServer({collector, scanner, sidebar, appearance, layout, staticDirectory:path.join(directory, '../dist'), port:Number(requestedPort)});
  // This is the sole stdout bootstrap line; the native parent owns the token.
  process.stdout.write(JSON.stringify({port:local.port, token:local.token}) + '\n');
  collector.start();
  sidebar.start();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await local.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  process.stderr.write('本地服务未能启动，请检查程序文件是否完整、端口是否可用。\n');
  process.exitCode = 1;
}
