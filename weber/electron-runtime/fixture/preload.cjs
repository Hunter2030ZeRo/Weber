const { contextBridge, ipcRenderer } = require('electron');
globalThis.__preloadSecret = 'visible only inside the isolated preload context';
contextBridge.exposeInMainWorld('weberTest', {
  add: (left, right) => ipcRenderer.invoke('test:add', left, right),
  fail: () => ipcRenderer.invoke('test:failure'),
  secret: () => globalThis.__preloadSecret,
});
