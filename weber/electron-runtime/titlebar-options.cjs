// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
function titleBarOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Title bar overlay options must be an object');
  const result = {};
  for (const key of ['color', 'symbolColor']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 256 || !value[key].trim()) throw new TypeError(`Invalid ${key}`);
      result[key] = value[key];
    }
  }
  if (value.height !== undefined) {
    if (!Number.isInteger(value.height) || value.height < 0 || value.height > 512) throw new RangeError('Overlay height must be an integer from 0 to 512');
    result.height = value.height;
  }
  return result;
}
function windowTitleBarOptions(options) {
  const style = options.titleBarStyle ?? 'default';
  if (!['default', 'hidden'].includes(style)) throw new TypeError('Unsupported Linux titleBarStyle');
  const overlay = options.titleBarOverlay;
  if (overlay !== undefined && typeof overlay !== 'boolean' && (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay))) {
    throw new TypeError('titleBarOverlay must be a boolean or object');
  }
  const enabled = overlay === true || (overlay !== null && typeof overlay === 'object');
  if (enabled && style !== 'hidden') throw new TypeError('Title bar overlay requires titleBarStyle: hidden on Linux');
  return { frame: options.frame !== false, titleBarStyle: style,
    titleBarOverlay: enabled ? titleBarOptions(overlay === true ? {} : overlay) : false };
}
module.exports = { titleBarOptions, windowTitleBarOptions };
