const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mvp', {
  sum: (a, b) => ipcRenderer.invoke('mvp:sum', a, b)
});
