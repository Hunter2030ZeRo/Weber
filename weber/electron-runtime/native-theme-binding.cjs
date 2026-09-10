// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { EventEmitter } = require('node:events');

// Observe the GTK appearance actually used by the native host. Forced light or
// dark themes also require renderer media-query/style invalidation, which the
// current engine does not implement. Never acknowledge those overrides here.
function createNativeThemeBinding({ host, unsupported }) {
  const nativeTheme = new EventEmitter();
  const fields = ['shouldUseDarkColors', 'shouldUseHighContrastColors',
    'shouldUseDarkColorsForSystemIntegratedUI', 'shouldUseInvertedColorScheme',
    'inForcedColorsMode'];
  let snapshot;
  let closed = false;
  const read = () => {
    if (closed || host.closed) throw new Error('Native theme host is closed');
    if (!snapshot) {
      const value = host.requestSync('nativeTheme.snapshot');
      if (!value || value.themeSource !== 'system' || fields.some(key => typeof value[key] !== 'boolean'))
        throw new Error('Invalid native theme snapshot');
      snapshot = Object.fromEntries(['themeSource', ...fields].map(key => [key, value[key]]));
    }
    return snapshot;
  };
  for (const key of fields) Object.defineProperty(nativeTheme, key, {
    enumerable: true, get: () => read()[key],
  });
  Object.defineProperty(nativeTheme, 'themeSource', {
    enumerable: true,
    get: () => read().themeSource,
    set(value) {
      if (!['system', 'light', 'dark'].includes(value))
        throw new TypeError('Invalid themeSource: expected system, light or dark');
      if (value !== 'system') return unsupported(`nativeTheme.themeSource=${value} (renderer color-scheme propagation)`);
      // This scoped host never installs an override. Read the real host before
      // acknowledging the already-active system policy, including before ready.
      read();
    },
  });
  Object.defineProperty(nativeTheme, 'prefersReducedTransparency', {
    enumerable: true, get: () => unsupported('nativeTheme.prefersReducedTransparency on GTK'),
  });
  const onEvent = event => {
    if (closed || event.event !== 'native-theme-updated') return;
    // The event stream and synchronous channel can arrive in either order.
    // Invalidate instead of caching an event payload that may already be stale.
    snapshot = undefined;
    nativeTheme.emit('updated');
  };
  host.on('event', onEvent);
  host.once('closed', () => {
    closed = true;
    snapshot = undefined;
    host.removeListener('event', onEvent);
  });
  return { nativeTheme };
}
module.exports = { createNativeThemeBinding };
