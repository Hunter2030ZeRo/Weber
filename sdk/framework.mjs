import { readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

// Inspect the app itself: checkout tool fallbacks must not select its renderer.
export async function projectDependencies(project) {
  try {
    const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Pre-package.json SDK examples explicitly imported this Solid adapter.
  // Preserve that compatibility without assuming every JSX app uses Solid.
  try {
    const config = JSON.parse(await readFile(join(project, 'weber.json'), 'utf8'));
    if (typeof config.entry !== 'string') return {};
    const entry = resolve(project, config.entry), part = relative(project, entry);
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) return {};
    const source = await readFile(entry, 'utf8');
    return /from\s*['"]@weber\/solid['"]/.test(source) ? { 'solid-js': true } : {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}
