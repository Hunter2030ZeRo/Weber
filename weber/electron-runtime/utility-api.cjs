// Static export names support native CJS/ESM imports in a utility process.
// Browser and renderer APIs are intentionally absent from this process surface.
'use strict';
const api = globalThis[Symbol.for('weber.utility.api')];
if (!api) throw new Error('Electron utility API imported before Weber initialization');
exports.net = api.net;
