const { app, BaseWindow, WebContentsView, ipcMain, Menu, screen } = require('electron');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const base = process.env.KIOSK_DISPLAY_URL;
const secret = process.env.KIOSK_DISPLAY_SECRET;
if (!base || !secret) throw new Error('Launch the kiosk with node kiosk.js.');
const profile = join(process.env.KIOSK_DISPLAY_DATA, 'desktop');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setName('Smart Self Check Kiosk');
if (process.platform === 'win32') app.setAppUserModelId('com.solarizex.smartselfcheck.kiosk');

const preferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false };
let window;
let player;
let website;
let activeId;
let nextAttempt = 0;
let lastInteraction = 0;
let timer;
let currentDisplay;
let reportedDisplays;
const windowed = process.env.KIOSK_WINDOWED === '1';

async function report(id, data) {
  try {
    await fetch(base + '/api/desktop', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...data }),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* The agent may be restarting. */ }
}

function resize() {
  const [width, height] = window.getContentSize();
  const bounds = { x: 0, y: 0, width, height };
  player.setBounds(bounds);
  website?.setBounds(bounds);
}

function closeWebsite() {
  if (!website) return;
  const contents = website.webContents;
  const partition = contents.session;
  if (!window.isDestroyed()) window.contentView.removeChildView(website);
  website = undefined;
  contents.close();
  void Promise.allSettled([partition.clearStorageData(), partition.clearCache()]);
}

function openWebsite(session) {
  const view = new WebContentsView({
    webPreferences: {
      ...preferences,
      partition: 'visitor-' + session.id,
      preload: join(__dirname, 'desktop-preload.cjs'),
    },
  });
  website = view;
  const contents = view.webContents;
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on('will-download', event => event.preventDefault());
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.resourceType === 'mainFrame' && !details.url.startsWith('https://') });
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });

  window.contentView.addChildView(view);
  view.setVisible(false);
  resize();
  let timeout;
  const failed = () => {
    clearTimeout(timeout);
    if (website !== view) return;
    closeWebsite();
    nextAttempt = Date.now() + 10000;
    void report(session.id, { error: 'Could not open the check-in website. Retrying.' });
  };
  contents.once('render-process-gone', failed);
  contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) failed();
  });
  contents.once('dom-ready', () => {
    clearTimeout(timeout);
    if (website !== view) return;
    view.setVisible(true);
    contents.focus();
    void report(session.id, { error: '' });
  });
  timeout = setTimeout(failed, 25000);
  contents.once('destroyed', () => clearTimeout(timeout));
  void contents.loadURL(session.url).catch(failed);
}

ipcMain.on('visitor-interaction', event => {
  if (!website || event.sender !== website.webContents || event.senderFrame !== event.sender.mainFrame) return;
  if (Date.now() - lastInteraction < 1000) return;
  lastInteraction = Date.now();
  void report(activeId, { interaction: true });
});

function updateMonitor(monitor, session) {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter(display => display.id !== primary.id)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const displays = [primary, ...others];
  if (reportedDisplays !== displays.length) {
    reportedDisplays = displays.length;
    void report(undefined, { displays: displays.length });
  }
  if (session || windowed) return;
  const target = displays[(monitor ?? 1) - 1] ?? primary;
  const signature = JSON.stringify([target.id, target.bounds]);
  if (currentDisplay === signature) return;
  currentDisplay = signature;
  if (screen.getDisplayMatching(window.getBounds()).id !== target.id) {
    window.setKiosk(false);
    window.setBounds(target.bounds);
    window.setKiosk(true);
  }
}

async function poll() {
  if (window.isDestroyed()) return;
  try {
    const headers = window.isVisible() ? { Authorization: 'Bearer ' + secret } : {};
    const response = await fetch(base + '/api/display', { headers, signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Display unavailable');
    const { session, monitor } = await response.json();
    if (window.isDestroyed()) return;
    if (activeId !== session?.id) {
      closeWebsite();
      activeId = session?.id;
      nextAttempt = 0;
      lastInteraction = 0;
    }
    updateMonitor(monitor, session);
    if (session?.url && !website && Date.now() >= nextAttempt) openWebsite(session);
  } catch { /* The agent may be restarting. */ }
  if (!window.isDestroyed()) timer = setTimeout(poll, 350);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  window = new BaseWindow({
    title: 'Smart Self Check Kiosk', width: 1100, height: 700, show: false, kiosk: !windowed,
    backgroundColor: '#0a2727',
  });
  player = new WebContentsView({ webPreferences: { ...preferences, backgroundThrottling: false } });
  const contents = player.webContents;
  window.contentView.addChildView(player);
  resize();
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  window.on('resize', resize);
  window.on('close', closeWebsite);
  window.once('closed', () => {
    clearTimeout(timer);
    if (!contents.isDestroyed()) contents.close();
    app.quit();
  });
  window.show();
  if (windowed) window.moveTop();
  void contents.loadURL(base).catch(error => {
    console.error(`Could not open the kiosk player: ${error.message}`);
    app.exit(1);
  });
  void poll();
});
