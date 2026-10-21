import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const field = value => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
// Desktop Entry general escaping is applied AFTER Exec argument quoting.
const argument = value => '"' + value.replace(/%/g, '%%').replace(/[\\"$`]/g, '\\$&') + '"';
export function desktopEntry(bundle, app) {
  if (typeof app.id !== 'string' || !/^[\w.-]{1,200}$/.test(app.id) || typeof app.name !== 'string' || !app.name || app.name.length > 1024 || app.name.includes('\0')) throw new Error('Invalid launcher metadata');
  const directory = resolve(bundle);
  if (directory.includes('\0')) throw new Error('Invalid launcher path');
  // GIO validates the executable BEFORE %% expansion. Use a fixed executable
  // and fixed shell program; all paths remain quoted argv data, never code.
  const command = ['/bin/sh', '-c', 'exec "$@"', 'weber', join(directory, 'weber'), '--app', join(directory, 'application')].map(argument).join(' ');
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${field(app.name)}\nExec=${field(command)}\nTerminal=false\nStartupNotify=true\nCategories=Utility;\n`;
}
/** Generates a launcher only; does not install into the user's desktop. */
export async function launcher(bundle, output) {
  const app = JSON.parse(await readFile(join(bundle, 'application/app.json'), 'utf8'));
  await writeFile(output, desktopEntry(bundle, app), { flag: 'wx' });
  console.log(`Desktop launcher ready: ${output}\nRegenerate after moving the bundle; install it as ${app.id}.desktop.`);
}
