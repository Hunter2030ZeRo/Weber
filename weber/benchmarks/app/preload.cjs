const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('benchmark', {
  add: (left, right) => ipcRenderer.invoke('benchmark:add', left, right),
});
