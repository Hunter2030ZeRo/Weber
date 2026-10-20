#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { init, check, command, host } from './project.mjs';
import { build, packageApp } from './build.mjs';
import { dev } from './dev.mjs';
import { sdkVersion } from './toolchain.mjs';

async function main() {
  const [action, location, ...flags] = process.argv.slice(2);
  if (action === 'init') { if (!location || flags.length > 1) throw new Error('Usage: init PROJECT [solid|dom|node|windows|notes]'); await init(resolve(location), flags[0] ?? 'solid'); return; }
  if (action === 'dev') { if (!location || flags.length) throw new Error('Usage: dev PROJECT'); await dev(resolve(location)); return; }
  if (action === 'build') {
    if (!location || flags.some(flag => flag.startsWith('--') && flag !== '--aot') || flags.filter(flag => flag !== '--aot').length > 1) throw new Error('Usage: build PROJECT [OUTPUT] [--aot]');
    await build(resolve(location), resolve(flags.find(flag => flag !== '--aot') ?? join(location, 'dist')), flags.includes('--aot')); return;
  }
  if (action === 'check') { if (!location || flags.length) throw new Error('Usage: check PROJECT'); await check(resolve(location)); return; }
  if (action === 'run') {
    if (!location || flags.some(flag => flag !== '--web')) throw new Error('Usage: run APPLICATION [--web]');
    const manifest = JSON.parse(await readFile(join(resolve(location), 'app.json'), 'utf8'));
    await command(host(Boolean(manifest.nativeUnit)), ['--app', resolve(location), ...flags], { cwd: process.cwd() }); return;
  }
  if (action === 'package') { if (!location || flags.length !== 1) throw new Error('Usage: package APPLICATION OUTPUT'); await packageApp(resolve(location), resolve(flags[0])); return; }
  console.log(`Weber SDK ${sdkVersion} (local preview)\ninit PROJECT [solid|dom|node|windows|notes]\ndev PROJECT\ncheck PROJECT\nbuild PROJECT [OUTPUT] [--aot]\nrun APPLICATION [--web]\npackage APPLICATION OUTPUT`);
  if (action && action !== '--help') throw new Error('Unknown SDK command');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
