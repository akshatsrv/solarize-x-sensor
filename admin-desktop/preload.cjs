const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consoleConnection', {
  defaults: () => ipcRenderer.invoke('console:defaults'),
  connect: input => ipcRenderer.invoke('console:connect', input),
  register: input => ipcRenderer.invoke('console:register', input),
});
