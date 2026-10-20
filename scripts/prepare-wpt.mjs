import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const bytes = await readFile('compatibility/profile.json');
const hash = createHash('sha256').update(bytes).digest('hex');
const lock = (await readFile('compatibility/profile.sha256', 'utf8')).trim();
if (hash !== lock) throw new Error('Compatibility profile changed without a new version');
const profile = JSON.parse(bytes);
for (const file of profile.files) {
  const path = `vendor/wpt/${file.path}`;
  let data;
  try { data = await readFile(path); } catch {}
  if (!data || createHash('sha256').update(data).digest('hex') !== file.sha256) {
    // Downloads only the fixed public revision. Tests are never patched locally.
    const response = await fetch(`https://raw.githubusercontent.com/web-platform-tests/wpt/${profile.wpt.sha}/${file.path}`);
    if (!response.ok) throw new Error(`${file.path}: HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`WPT hash mismatch: ${file.path}`);
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(path, data);
  }
}
console.log(`Verified ${profile.files.length} original WPT files, profile ${hash}`);
