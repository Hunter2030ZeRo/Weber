const { contextBridge, ipcRenderer } = require('electron');
globalThis.__preloadSecret = 'visible only inside the isolated preload context';
const pushes = [];
const duplicated = (_event, value) => pushes.push(value);
ipcRenderer.once('test:push', duplicated);
ipcRenderer.on('test:push', duplicated);
const removed = () => { throw new Error('Removed IPC listener ran'); };
ipcRenderer.on('test:push', removed);
ipcRenderer.removeListener('test:push', removed);
contextBridge.exposeInMainWorld('weberTest', {
  ping: value => new Promise(resolve => {
    ipcRenderer.once('test:pong', (_event, answer) => resolve(answer));
    ipcRenderer.send('test:ping', value);
  }),
  pushes: () => pushes.slice(),

  add: (left, right) => ipcRenderer.invoke('test:add', left, right),
  fail: () => ipcRenderer.invoke('test:failure'),
  secret: () => globalThis.__preloadSecret,
});
