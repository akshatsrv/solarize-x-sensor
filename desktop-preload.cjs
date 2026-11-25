const { ipcRenderer } = require('electron');

for (const name of ['pointerdown', 'keydown', 'wheel']) {
  window.addEventListener(name, event => {
    if (event.isTrusted) ipcRenderer.send('visitor-interaction');
  }, { capture: true, passive: true });
}
