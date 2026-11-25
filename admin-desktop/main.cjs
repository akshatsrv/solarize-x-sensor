const { app } = require('electron');
const { join } = require('node:path');

if (app.isPackaged && process.argv.includes('--smart-kiosk-display')) {
  require(join(process.resourcesPath, 'local-system', 'desktop.cjs'));
} else {
  require('./console.cjs');
}
