import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function fingerprint() {
  const git = args => new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [], errors = [];
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(Buffer.concat(errors).toString())));
  });
  const hash = createHash('sha256');
  const files = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'app/package.json', 'app/pnpm-lock.yaml'];
  const walk = async path => { for (const entry of await readdir(path, { withFileTypes: true })) { if (entry.isDirectory() && ['dist', 'node_modules', '__pycache__', '.git', 'target'].includes(entry.name)) continue; const file = `${path}/${entry.name}`; if (entry.isDirectory()) await walk(file); else files.push(file); } };
  for (const path of ['vendor/winit', 'vendor/stylo', 'aot', 'src', 'native', 'patches', 'compatibility', 'app/src', 'scripts', 'sdk', 'examples']) await walk(path);
  for (const entry of await readdir('app')) if (entry.endsWith('.mjs') || entry.startsWith('tsconfig') || entry.startsWith('vite.config')) files.push(`app/${entry}`);
  for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(file)).update('\0');
  const revisions = {};
  const untrackedServo=(await git(['-C','vendor/servo','ls-files','--others','--exclude-standard','-z'])).toString().split('\0').filter(Boolean).sort();
  for(const file of untrackedServo)hash.update(`servo-untracked:${file}`).update('\0').update(await readFile(`vendor/servo/${file}`)).update('\0');
  for (const engine of ['servo', 'hermes']) {
    if (engine === 'hermes') { try { await readdir('vendor/hermes/.git'); } catch { try { await readFile('vendor/hermes/.git'); } catch { revisions[engine] = null; hash.update('hermes-absent'); continue; } } }
    revisions[engine] = (await git(['-C', `vendor/${engine}`, 'rev-parse', 'HEAD'])).toString().trim();
    hash.update(engine).update(revisions[engine]).update(await git(['-C', `vendor/${engine}`, 'diff', '--binary']));
  }
  revisions.stylo = '0.22.0';
  revisions.winit = JSON.parse(await readFile('patches/winit-source.json','utf8')).version;
  return { sourceHash: hash.digest('hex'), revisions };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await fingerprint()));
