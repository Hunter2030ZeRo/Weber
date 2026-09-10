// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { EventEmitter } = require('node:events');
function createDisplayBinding({ host, app }) {
  const call = method => {
    if (!app.isReady()) throw new Error('Native display APIs cannot be used before app is ready');
    return host.requestSync(method);
  };
  const all = () => call('screen.displays');
  const publicDisplay = value => {
    if (!value) throw new Error('Native display is unavailable');
    const { primary, ...display } = value;
    return display;
  };
  const point = value => {
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new TypeError('Invalid screen point');
    return value;
  };
  const nearest = value => {
    point(value);
    return all().sort((a, b) => {
      const distance = ({ bounds: r }) => Math.max(r.x - value.x, 0, value.x - (r.x + r.width)) ** 2 +
        Math.max(r.y - value.y, 0, value.y - (r.y + r.height)) ** 2;
      return distance(a) - distance(b);
    })[0];
  };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => all().map(publicDisplay),
    getPrimaryDisplay: () => publicDisplay(all().find(value => value.primary)),
    getCursorScreenPoint: () => call('screen.cursor'),
    getDisplayNearestPoint: value => publicDisplay(nearest(value)),
    getDisplayMatching(rect) {
      point(rect);
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 0 || rect.height < 0)
        throw new TypeError('Invalid screen rectangle');
      const area = ({ bounds: r }) => Math.max(0, Math.min(r.x + r.width, rect.x + rect.width) - Math.max(r.x, rect.x)) *
        Math.max(0, Math.min(r.y + r.height, rect.y + rect.height) - Math.max(r.y, rect.y));
      const best = all().sort((a, b) => area(b) - area(a))[0];
      return publicDisplay(best && area(best) > 0 ? best : nearest({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }));
    },
  });
  const preferences = Object.assign(new EventEmitter(), {
    getAccentColor: () => call('systemPreferences.snapshot').accentColor,
    getAnimationSettings: () => call('systemPreferences.snapshot').animationSettings,
  });
  host.on('event', event => {
    if (event.event?.startsWith('screen-display-')) {
      screen.emit(event.event.slice(7), {}, publicDisplay(event.display), event.changed);
    } else if (event.event === 'system-accent-color-changed') preferences.emit('accent-color-changed', {}, event.color);
  });
  return { screen: { createScreen: () => { if (!app.isReady()) throw new Error('screen requires app ready'); return screen; } },
    preferences: { systemPreferences: preferences } };
}
module.exports = { createDisplayBinding };
