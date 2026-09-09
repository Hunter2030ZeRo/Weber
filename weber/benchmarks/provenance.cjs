'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function identifyFile(filename) {
  if (!filename) return { status: 'missing', requestedPath: null, reason: 'No path was supplied' };
  const requestedPath = path.resolve(filename);
  try {
    const realPath = await fs.promises.realpath(requestedPath);
    const stat = await fs.promises.stat(realPath);
    if (!stat.isFile()) return { status: 'unavailable', requestedPath, realPath, reason: 'Path is not a regular file' };
    const hash = createHash('sha256');
    // Stream executable hashes without loading large V8/Chromium binaries into
    // the benchmark runner's heap. Hashing happens before any timed trial.
    for await (const chunk of fs.createReadStream(realPath)) hash.update(chunk);
    return { status: 'present', requestedPath, realPath, bytes: stat.size, sha256: hash.digest('hex') };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'unavailable', requestedPath,
      reason: error.message };
  }
}

async function applicationFiles(directory) {
  const found = [];
  async function visit(current) {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else {
        const identity = await identifyFile(filename);
        found.push({ path: path.relative(directory, filename).split(path.sep).join('/'), ...identity });
      }
    }
  }
  await visit(directory);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

async function cmakeBuildType(executable) {
  if (executable.status !== 'present') return { status: 'missing', cachePath: null,
    buildType: null, reason: 'The runtime executable was unavailable' };
  let directory = path.dirname(executable.realPath);
  const inspected = [];
  // CMake emits the desktop host into its build directory and the renderer
  // into a child directory. Installed/copy-only packages may have no cache.
  for (let depth = 0; depth < 8; depth++) {
    const filename = path.join(directory, 'CMakeCache.txt');
    inspected.push(filename);
    try {
      const source = await fs.promises.readFile(filename, 'utf8');
      const match = source.match(/^CMAKE_BUILD_TYPE:[^=\r\n]+=(.*)$/m);
      const value = match ? match[1].replace(/\r$/, '') : null;
      const configurations = source.match(/^CMAKE_CONFIGURATION_TYPES:[^=\r\n]+=(.*)$/m);
      return { status: match && value ? 'set' : match ? 'unset' : 'missing-entry',
        cachePath: filename, buildType: value,
        configurations: configurations ? configurations[1].replace(/\r$/, '') : null,
        cacheIdentity: await identifyFile(filename),
        reason: match && value ? null : 'No nonempty CMAKE_BUILD_TYPE is recorded; Release is not assumed' };
    } catch (error) {
      if (error.code !== 'ENOENT') return { status: 'unavailable', cachePath: filename,
        buildType: null, reason: error.message };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { status: 'missing', cachePath: null, buildType: null, inspected,
    reason: 'No CMakeCache.txt exists next to the executable or its inspected ancestors' };
}

async function collectProvenance(config, appDirectory, environment = process.env) {
  const root = path.resolve(path.dirname(config.bootstrap), '../..');
  const host = environment.WEBER_DESKTOP_HOST || path.join(root, 'out/runtime/weber-desktop-host');
  const renderer = environment.WEBER_OBSCURA_RENDERER || path.join(root, 'out/runtime/obscura/weber-obscura-renderer');
  const [electron, node, desktopHost, obscuraRenderer, bootstrap, appFiles] = await Promise.all([
    identifyFile(config.electron), identifyFile(config.node), identifyFile(host),
    identifyFile(renderer), identifyFile(config.bootstrap), applicationFiles(appDirectory),
  ]);
  const [hostCmake, rendererCmake, sourceManifest] = await Promise.all([
    cmakeBuildType(desktopHost), cmakeBuildType(obscuraRenderer),
    identifyFile(path.join(path.dirname(config.bootstrap), 'dist/source-manifest.json')),
  ]);
  return {
    githubSha: environment.GITHUB_SHA === undefined ? { status: 'missing', value: null } :
      { status: 'provided', value: environment.GITHUB_SHA },
    githubRunId: environment.GITHUB_RUN_ID || null,
    applicationFiles: appFiles,
    executables: { electron, node, desktopHost, obscuraRenderer },
    bootstrap,
    compiledElectronSourceManifest: sourceManifest,
    cmake: { desktopHost: hostCmake, obscuraRenderer: rendererCmake },
    hashing: 'All hashes are SHA-256, captured before timed trials. Reading binaries can warm the filesystem cache.',
    limits: 'CMake cache values describe the nearby build configuration; missing/empty values remain explicit. No Release configuration is inferred from filenames.',
  };
}

module.exports = { identifyFile, cmakeBuildType, collectProvenance };
