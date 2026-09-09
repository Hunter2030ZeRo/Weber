// Static export names allow Node's ESM loader to expose Electron named imports.
const api = globalThis[Symbol.for('weber.electron.api')];
if (!api) throw new Error('Electron API was imported before Weber initialization');
exports.app = api.app;
exports.BaseWindow = api.BaseWindow;
exports.BrowserWindow = api.BrowserWindow;
exports.webContents = api.webContents;
exports.View = api.View;
exports.WebContentsView = api.WebContentsView;
exports.ipcMain = api.ipcMain;
exports.session = api.session;
exports.webFrameMain = api.webFrameMain;
exports.dialog = api.dialog;
