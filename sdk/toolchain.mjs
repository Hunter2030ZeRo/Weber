import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const sdk = fileURLToPath(new URL('.', import.meta.url));
export const checkout = existsSync(join(root, 'scripts/package.py')) && existsSync(join(root, 'app/package.json'));
export const sdkVersion = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version;
export const runtimePackageName = `@weber/runtime-${process.platform}-${process.arch}`;
export function installedRuntime(project = process.cwd()) {
  for (const base of [resolve(project), sdk]) {
    try { return dirname(createRequire(join(base, 'package.json')).resolve(`${runtimePackageName}/package.json`)); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
  }
}
export function resolveTool(name, project = process.cwd()) {
  const local = createRequire(join(resolve(project), 'package.json'));
  try { return local.resolve(name); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    if (!checkout) throw new Error(`Install ${name.split('/')[0]} in the application project before using Weber`);
    // Prepared-checkout fallback for the original SDK examples.
    return createRequire(join(root, 'app/package.json')).resolve(name);
  }
}
export async function importTool(name, project) {
  return import(pathToFileURL(resolveTool(name, project)).href);
}
export function packageDirectory(name, project) {
  return dirname(resolveTool(`${name}/package.json`, project));
}
