import path from 'node:path';
import {runMaintenance} from './maintenance.mjs';
const args=process.argv.slice(2),options={};
const names={'--state-dir':'stateDirectory','--feed-dir':'feedDirectory','--env-file':'envFile','--model':'model'};
try {
  for(let i=0;i<args.length;i+=2) {
    if(!names[args[i]] || !args[i+1] || args[i+1].startsWith('--') || options[names[args[i]]])throw new Error('Invalid arguments.');
    options[names[args[i]]]=args[i+1];
  }
  if(!options.stateDirectory || !options.feedDirectory)throw new Error('Usage: node tools/version-maintenance/run.mjs --state-dir <directory> --feed-dir <directory> [--env-file <file>] [--model <model>]');
  options.stateDirectory=path.resolve(options.stateDirectory);options.feedDirectory=path.resolve(options.feedDirectory);
  console.log(JSON.stringify(await runMaintenance(options)));
} catch(error) {
  const message=String(error.message).replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,700);
  console.error(JSON.stringify({status:'failed',message}));process.exitCode=1;
}
