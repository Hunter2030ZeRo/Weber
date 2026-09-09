// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';

// Linux platform state for Electron's app API. No Chromium command-line option
// is silently accepted here: runtime option mutation remains the caller's job.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIRECTORY_NAMES = new Set(['home', 'appData', 'assets', 'userData',
  'sessionData', 'temp', 'desktop', 'documents', 'downloads', 'music',
  'pictures', 'videos', 'logs', 'crashDumps', 'cache', 'userCache']);
const FILE_NAMES = new Set(['exe', 'module']);
const USER_DIRS = { desktop: ['DESKTOP', 'Desktop'], documents: ['DOCUMENTS', 'Documents'],
  downloads: ['DOWNLOAD', 'Downloads'], music: ['MUSIC', 'Music'],
  pictures: ['PICTURES', 'Pictures'], videos: ['VIDEOS', 'Videos'] };

function string(value, description) {
  if (typeof value !== 'string') throw new TypeError(`${description} must be a string`);
  return value;
}

function switchName(value) {
  string(value, 'Switch name');
  if (!value || value.startsWith('-') || /[\s=\0]/.test(value)) {
    throw new TypeError('Switch name must not contain a prefix, whitespace, = or NUL');
  }
  return value;
}

function readSwitches(argv) {
  const switches = new Map();
  // Skip the executable. The Weber bootstrap replaces process.argv with the
  // Electron application's argv before executing its entry module.
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') break;
    if (typeof token !== 'string' || !token.startsWith('--') || token.length === 2) continue;
    const equals = token.indexOf('=');
    const name = token.slice(2, equals < 0 ? undefined : equals);
    if (!name || /[\s\0]/.test(name)) continue;
    let value = equals < 0 ? '' : token.slice(equals + 1);
    if (equals < 0 && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('-')) {
      value = argv[++index];
    }
    // Like Electron's native command-line map, the last occurrence wins.
    switches.set(name, value);
  }
  return switches;
}

function preferredSystemLanguages(env = process.env, intlLocale) {
  // GLib's documented Linux precedence. Encoding suffixes are not languages;
  // include less specific fallbacks, and return canonical BCP 47 tags. This is
  // an environment/Intl implementation, not a claim to call GLib from Node.
  const configured = ['LANGUAGE', 'LC_ALL', 'LC_MESSAGES', 'LANG']
    .map(key => env[key]).find(value => typeof value === 'string' && value.length > 0);
  const input = configured === undefined ?
    [intlLocale ?? Intl.DateTimeFormat().resolvedOptions().locale] : configured.split(':');
  const languages = new Set();
  for (const entry of input) {
    const [raw, modifier] = entry.trim().split('@');
    let tag = raw.replace(/\..*$/, '').replace(/_/g, '-');
    if (!tag || /^(C|POSIX)$/i.test(tag)) continue;
    const script = { latin: 'Latn', cyrillic: 'Cyrl' }[modifier];
    if (script && !/^[^-]+-[A-Za-z]{4}(?:-|$)/.test(tag)) {
      const parts = tag.split('-');
      parts.splice(1, 0, script);
      tag = parts.join('-');
    }
    try {
      const canonical = Intl.getCanonicalLocales(tag)[0];
      languages.add(canonical);
      const locale = new Intl.Locale(canonical);
      if (locale.script) languages.add(`${locale.language}-${locale.script}`);
      languages.add(locale.language);
    } catch { /* A malformed locale must not break application startup. */ }
  }
  return [...languages];
}

function readUserDirs(configHome, home) {
  let contents;
  try { contents = fs.readFileSync(path.join(configHome, 'user-dirs.dirs'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const dirs = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*XDG_([A-Z]+)_DIR="((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const encoded = match[2];
    const homePrefix = encoded.startsWith('$HOME/') || encoded === '$HOME';
    const suffix = homePrefix ? encoded.slice(5) : encoded;
    // This is a config parser, never a shell. Unknown expansion and command
    // substitution remain invalid even if the resulting string looks absolute.
    if (/(^|[^\\])[$`]/.test(suffix)) continue;
    const value = (homePrefix ? home : '') + suffix.replace(/\\([\\"$`])/g, '$1');
    if (path.isAbsolute(value) && !value.includes('\0')) dirs[match[1]] = value;
  }
  return dirs;
}

function attachPlatformApp(app, options = {}) {
  const env = options.env ?? process.env;
  const getName = options.getName ?? (() => app.getName());
  const home = options.home ?? os.homedir();
  const temporary = options.temp ?? os.tmpdir();
  const executable = options.execPath ?? process.execPath;
  const getArgv = typeof options.argv === 'function' ? options.argv :
    () => options.argv ?? process.argv;
  const overrides = new Map();
  const absoluteEnv = (key, fallback) => typeof env[key] === 'string' && path.isAbsolute(env[key]) ? env[key] : fallback;
  const configHome = () => absoluteEnv('XDG_CONFIG_HOME', path.join(getPath('home'), '.config'));
  const cacheHome = () => absoluteEnv('XDG_CACHE_HOME', path.join(getPath('home'), '.cache'));

  function checkedName(key, operation) {
    string(key, 'Path name');
    if (key === 'userDesktop') key = 'desktop';
    if (!DIRECTORY_NAMES.has(key) && !FILE_NAMES.has(key)) {
      throw new Error(operation === 'get' ? `Failed to get '${key}' path` : 'Failed to set path');
    }
    return key;
  }

  function getPath(input) {
    const key = checkedName(input, 'get');
    if (overrides.has(key)) return overrides.get(key);
    switch (key) {
      case 'home': return home;
      case 'temp': return temporary;
      case 'exe': case 'module': return executable;
      case 'assets': return path.dirname(executable);
      case 'appData': return configHome();
      case 'cache': return cacheHome();
      case 'userData': return path.join(getPath('appData'), getName());
      case 'userCache': return path.join(getPath('cache'), getName());
      case 'sessionData': return getPath('userData');
      case 'logs':
        setAppLogsPath();
        return overrides.get('logs');
      case 'crashDumps': return path.join(getPath('userData'), 'Crashpad');
      default: {
        const [xdgKey, fallback] = USER_DIRS[key];
        return readUserDirs(configHome(), getPath('home'))[xdgKey] ?? path.join(getPath('home'), fallback);
      }
    }
  }

  function setPath(input, value) {
    string(value, 'Path');
    if (!path.isAbsolute(value)) throw new Error('Path must be absolute');
    const key = checkedName(input, 'set');
    let stat;
    try { stat = fs.statSync(value); } catch { throw new Error('Failed to set path'); }
    if (DIRECTORY_NAMES.has(key) ? !stat.isDirectory() : !stat.isFile()) throw new Error('Failed to set path');
    overrides.set(key, value);
  }

  function setAppLogsPath(value) {
    if (value === undefined) value = path.join(getPath('userData'), 'logs');
    string(value, 'Path');
    if (!path.isAbsolute(value)) throw new Error('Path must be absolute');
    fs.mkdirSync(value, { recursive: true });
    setPath('logs', value);
  }

  app.getPath = getPath;
  app.setPath = setPath;
  app.setAppLogsPath = setAppLogsPath;
  app.getPreferredSystemLanguages = () => preferredSystemLanguages(env, options.intlLocale);
  app.commandLine ??= {};
  app.commandLine.hasSwitch = name => readSwitches(getArgv()).has(switchName(name));
  app.commandLine.getSwitchValue = name => readSwitches(getArgv()).get(switchName(name)) ?? '';
  return app;
}

module.exports = { attachPlatformApp, preferredSystemLanguages, readSwitches };
