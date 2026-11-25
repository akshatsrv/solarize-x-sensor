const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consoleConnection', {
  defaults: () => ipcRenderer.invoke('console:defaults'),
  connect: input => ipcRenderer.invoke('console:connect', input),
  register: input => ipcRenderer.invoke('console:register', input),
  local: () => ipcRenderer.invoke('console:local'),
  activateLocalOwner: password => ipcRenderer.invoke('console:local-owner', password),
});
