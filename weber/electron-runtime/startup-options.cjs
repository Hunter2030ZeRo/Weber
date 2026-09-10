// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { readSwitches } = require('./platform-app.cjs');

// These are Chromium tuning hints in VS Code's normal startup. Preserve their
// command-line values, but report that they do not configure Obscura. Security,
// proxy, certificate and arbitrary engine flags are deliberately not on this list.
const hints = new Set(['enable-features', 'disable-features', 'disable-blink-features',
  'xdg-portal-required-version', 'max-active-webgl-contexts']);
function attachStartupOptions(app, { unsupported, env = process.env, argv = () => process.argv,
  ignored = name => process.emitWarning(`Chromium option --${name} is stored but has no Obscura effect`, { code: 'WEBER_ENGINE_OPTION' }) }) {
  const overrides = new Map(), removed = new Set(), warned = new Set();
  function name(value) {
    if (typeof value !== 'string' || !value || value.startsWith('-') || /[\s=\0]/.test(value))
      throw new TypeError('Invalid switch name');
    return value;
  }
  const values = () => {
    const values = readSwitches(argv());
    for (const key of removed) values.delete(key);
    for (const [key, value] of overrides) values.set(key, value);
    return values;
  };
  const mutable = () => { if (app.isReady()) return unsupported('command-line changes after app ready'); };
  app.commandLine = {
    hasSwitch: key => values().has(name(key)),
    getSwitchValue: key => values().get(name(key)) ?? '',
    appendSwitch(key, value = '') {
      name(key); mutable();
      if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 64 * 1024)
        throw new TypeError('Invalid switch value');
      if (key === 'no-sandbox' || key === 'disable-gpu-sandbox') {
        if (env.WEBER_UNSANDBOXED_DEVELOPMENT !== '1') return unsupported('unsandboxed runtime without development opt-in');
      } else if (key === 'password-store') {
        if (!['basic', 'gnome-libsecret'].includes(value)) return unsupported('password store ' + value);
      } else if (key === 'lang') {
        try { if (!Intl.getCanonicalLocales(value).length) throw Error(); }
        catch { throw new TypeError('Invalid locale'); }
      } else if (!hints.has(key)) return unsupported('runtime switch --' + key);
      if (!overrides.has(key) && overrides.size >= 128) throw new RangeError('Too many runtime switches');
      overrides.set(key, value); removed.delete(key);
      if (hints.has(key) && !warned.has(key)) { warned.add(key); ignored(key); }
    },
    removeSwitch(key) {
      name(key); mutable();
      if (key.includes('sandbox')) return unsupported('sandbox policy mutation');
      if (!removed.has(key) && removed.size >= 128) throw new RangeError('Too many removed runtime switches');
      overrides.delete(key); removed.add(key);
    },
    appendArgument() { return unsupported('commandLine.appendArgument'); },
  };
  app.getLocale = () => app.commandLine.getSwitchValue('lang') || app.getPreferredSystemLanguages()[0] || 'en-US';
  app.getLocaleCountryCode = () => new Intl.Locale(app.getLocale()).region || '';
  app.enableSandbox = () => unsupported('app.enableSandbox: OS sandbox is not implemented');
  app.disableHardwareAcceleration = () => unsupported('app.disableHardwareAcceleration');
}
module.exports = { attachStartupOptions };
