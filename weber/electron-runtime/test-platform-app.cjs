// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { attachPlatformApp, preferredSystemLanguages } = require('./platform-app.cjs');

test('command-line getters parse values, duplicates and the literal-argument boundary', () => {
  const argv = ['/runtime', '/app', '--verbose', '--port=0', '--locale', 'ko_KR',
    '--port=9222', '--empty=', '--url=https://example.test/?q=a=b', '--', '--ignored=yes'];
  const unsupported = () => { throw new Error('unsupported'); };
  const app = attachPlatformApp({ commandLine: { appendSwitch: unsupported } }, { argv });
  assert.equal(app.commandLine.hasSwitch('verbose'), true);
  assert.equal(app.commandLine.hasSwitch('port'), true);
  assert.equal(app.commandLine.getSwitchValue('port'), '9222');
  assert.equal(app.commandLine.getSwitchValue('locale'), 'ko_KR');
  assert.equal(app.commandLine.getSwitchValue('verbose'), '');
  assert.equal(app.commandLine.hasSwitch('empty'), true);
  assert.equal(app.commandLine.getSwitchValue('empty'), '');
  assert.equal(app.commandLine.getSwitchValue('url'), 'https://example.test/?q=a=b');
  assert.equal(app.commandLine.hasSwitch('ignored'), false);
  assert.equal(app.commandLine.getSwitchValue('absent'), '');
  assert.throws(() => app.commandLine.hasSwitch('--port'), TypeError);
  assert.throws(() => app.commandLine.getSwitchValue(null), TypeError);
  assert.equal(app.commandLine.appendSwitch, unsupported);
  assert.throws(() => app.commandLine.appendSwitch('disable-gpu'), /unsupported/);
});

test('language preferences use Linux precedence and canonical locale fallbacks', () => {
  assert.deepEqual(preferredSystemLanguages({ LANGUAGE: 'ko_KR.UTF-8:fr_CA:ko', LANG: 'de_DE' }),
    ['ko-KR', 'ko', 'fr-CA', 'fr']);
  assert.deepEqual(preferredSystemLanguages({ LANGUAGE: '', LC_ALL: 'sr_RS.UTF-8@latin', LANG: 'de_DE' }),
    ['sr-Latn-RS', 'sr-Latn', 'sr']);
  assert.deepEqual(preferredSystemLanguages({ LC_MESSAGES: 'zh_Hant_TW', LANG: 'en_US' }),
    ['zh-Hant-TW', 'zh-Hant', 'zh']);
  assert.deepEqual(preferredSystemLanguages({ LANG: 'en_US.UTF-8' }), ['en-US', 'en']);
  assert.deepEqual(preferredSystemLanguages({ LANG: 'C.UTF-8' }), []);
  assert.deepEqual(preferredSystemLanguages({ LANGUAGE: 'POSIX:invalid_locale_name:en_GB' }), ['en-GB', 'en']);
  assert.deepEqual(preferredSystemLanguages({}, 'fr-CA'), ['fr-CA', 'fr']);
});

test('paths honor XDG config without executing shell content and preserve valid overrides', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weber-platform-app-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, '.settings');
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'user-dirs.dirs'), [
    'XDG_DOWNLOAD_DIR="$HOME/Incoming files"',
    'XDG_DESKTOP_DIR="/custom/Workspace" # comment',
    'XDG_MUSIC_DIR="$OTHER/Music"',
    'XDG_PICTURES_DIR="$(touch /must-not-exist)"',
  ].join('\n'));
  const executable = path.join(home, 'weber');
  fs.writeFileSync(executable, 'executable');
  let name = 'Example';
  const app = attachPlatformApp({}, { home, temp: home, execPath: executable,
    getName: () => name, env: { XDG_CONFIG_HOME: config, XDG_CACHE_HOME: 'relative-invalid' } });
  assert.equal(app.getPath('appData'), config);
  assert.equal(app.getPath('userData'), path.join(config, name));
  assert.equal(app.getPath('sessionData'), app.getPath('userData'));
  assert.equal(app.getPath('cache'), path.join(home, '.cache'));
  assert.equal(app.getPath('downloads'), path.join(home, 'Incoming files'));
  assert.equal(app.getPath('desktop'), '/custom/Workspace');
  assert.equal(app.getPath('userDesktop'), '/custom/Workspace');
  assert.equal(app.getPath('music'), path.join(home, 'Music'));
  assert.equal(app.getPath('pictures'), path.join(home, 'Pictures'));
  assert.equal(app.getPath('exe'), executable);
  assert.equal(app.getPath('module'), executable);
  assert.equal(app.getPath('assets'), home);
  name = 'Renamed';
  assert.equal(app.getPath('userData'), path.join(config, 'Renamed'));
  for (const invalid of ['constructor', '__proto__', 'recent', 'unknown']) {
    assert.throws(() => app.getPath(invalid), /Failed to get/);
    assert.throws(() => app.setPath(invalid, home), /Failed to set/);
  }
  assert.throws(() => app.setPath('userData', 'relative'), /absolute/);
  assert.throws(() => app.setPath('userData', path.join(home, 'missing')), /Failed to set/);
  assert.throws(() => app.setPath('userData', executable), /Failed to set/);
  assert.throws(() => app.setPath('exe', home), /Failed to set/);
  app.setPath('userData', home);
  assert.equal(app.getPath('sessionData'), home);
  assert.throws(() => app.setPath('userData', path.join(home, 'missing')), /Failed to set/);
  assert.equal(app.getPath('userData'), home);
  assert.equal(app.getPath('logs'), path.join(home, 'logs'));
  assert.ok(fs.statSync(app.getPath('logs')).isDirectory());
  const customLogs = path.join(home, 'nested', 'logs');
  app.setAppLogsPath(customLogs);
  assert.equal(app.getPath('logs'), customLogs);
  assert.ok(fs.statSync(customLogs).isDirectory());
  app.setPath('userDesktop', home);
  assert.equal(app.getPath('desktop'), home);
});
