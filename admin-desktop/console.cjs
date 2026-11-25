const { app, BrowserWindow, dialog, ipcMain, Menu, net, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { connectionInput, serverOrigin } = require('./connection.cjs');
const { createLocalSystem } = require('./local-system.cjs');

const title = 'Smart Self Check Console';
const authFile = join(__dirname, 'connect.html');
const authUrl = pathToFileURL(authFile).href;
const sections = [
  ['Servers', 'servers'], ['Destinations', 'fleet'], ['Content library', 'library'],
  ['Designer', 'designer'], ['Scheduler', 'scheduler'], ['Playback history', 'playback'],
  ['System management', 'system'], ['Setup', 'setup'],
];
let connectionWindow;
let desk;
let consoleOrigin;
let connecting = false;
let quitting = false;
let closingLocal = false;
let lastServer = 'http://127.0.0.1:8080';
let preferLocal = false;
let localSystem;

app.setName(title);
if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0);
if (process.platform === 'win32') app.setAppUserModelId('com.solarizex.smartselfcheck.console');
const icon = join(__dirname, 'console.png');
const secure = { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false };

function nativeMenu() {
  const connected = !!desk && !desk.isDestroyed();
  const connection = {
    label: 'Connection',
    submenu: [
      { label: 'Connect to server…', accelerator: 'CmdOrCtrl+Shift+C', click: () => openConnection() },
      { label: 'Disconnect', enabled: connected, click: () => disconnect() },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };
  const view = {
    label: 'View',
    submenu: [
      ...sections.map(([label, hash], index) => ({
        label, accelerator: 'CmdOrCtrl+' + (index + 1), enabled: connected, click: () => navigate(hash),
      })),
      { type: 'separator' },
      { label: 'Refresh', accelerator: 'CmdOrCtrl+R', enabled: connected, click: () => desk?.reload() },
      { role: 'togglefullscreen' },
    ],
  };
  const help = {
    role: 'help',
    submenu: [{
      label: 'About Smart Self Check',
      click: () => dialog.showMessageBox({
        type: 'info', title, message: title, detail: 'Version ' + require('./package.json').version,
      }),
    }],
  };
  const template = [connection, { role: 'editMenu' }, view, help];
  if (process.platform === 'darwin') template.unshift({ role: 'appMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trustedWindowOptions() {
  return { title, icon, backgroundColor: '#f4f6f9', show: false };
}

function openConnection() {
  if (connectionWindow && !connectionWindow.isDestroyed()) {
    connectionWindow.show();
    connectionWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    ...trustedWindowOptions(), width: 540, height: 695, minWidth: 450, minHeight: 500,
    resizable: false, maximizable: false, parent: desk || undefined,
    webPreferences: { ...secure, preload: join(__dirname, 'preload.cjs') },
  });
  connectionWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.on('closed', () => { if (connectionWindow === win) connectionWindow = undefined; });
  win.loadFile(authFile).catch(error => console.error(error.message));
}

function disconnect() {
  const window = desk;
  desk = undefined;
  consoleOrigin = undefined;
  if (window && !window.isDestroyed()) window.close();
  nativeMenu();
  openConnection();
}

function navigate(hash) {
  if (!desk || desk.isDestroyed()) return;
  desk.loadURL(consoleOrigin + '/#' + hash).catch(error => console.error(error.message));
  desk.show();
  desk.focus();
}

function urlInOrigin(address, origin) {
  try {
    return new URL(address).origin === origin;
  } catch {
    return false;
  }
}

async function verifyServer(account) {
  const auth = Buffer.from(account.username + ':' + account.password).toString('base64');
  let response;
  try {
    response = await net.fetch(account.origin + '/api/fleet', {
      headers: { Authorization: 'Basic ' + auth },
      redirect: 'error', signal: AbortSignal.timeout(7000),
      credentials: 'omit',
    });
  } catch {
    throw new Error('Could not reach that server. Check the address, network, and TLS certificate.');
  }
  if (response.status === 401 || response.status === 403) throw new Error('The server rejected those sign-in details.');
  if (!response.ok) throw new Error('The server returned HTTP ' + response.status + '.');
  const fleet = await response.json().catch(() => null);
  if (!fleet?.server?.name || !Array.isArray(fleet.kiosks)) {
    throw new Error('That address did not return a Smart Self Check fleet.');
  }
  return fleet.server.name;
}

async function launchConsole(account, serverName) {
  const window = new BrowserWindow({
    ...trustedWindowOptions(), width: 1390, height: 875, minWidth: 860, minHeight: 600,
    webPreferences: { ...secure, partition: 'console-' + randomUUID() },
  });
  const origin = account.origin;
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);

  const restrict = (event, legacyUrl) => {
    if (!urlInOrigin(event.url ?? legacyUrl, origin)) event.preventDefault();
  };
  window.webContents.on('will-navigate', restrict);
  window.webContents.on('will-redirect', restrict);
  window.webContents.on('will-frame-navigate', restrict);
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url).catch(error => console.error(error.message));
    } catch { /* Chromium supplied an invalid address. */ }
    return { action: 'deny' };
  });
  let challenges = 0;
  window.webContents.on('login', (event, details, authInfo, callback) => {
    event.preventDefault();
    if (!authInfo.isProxy && authInfo.scheme.toLowerCase() === 'basic' &&
        urlInOrigin(details.url, origin) && challenges++ < 3) {
      callback(account.username, account.password);
    } else callback();
  });
  window.on('page-title-updated', event => { event.preventDefault(); window.setTitle(title + ' — ' + serverName); });
  try {
    await window.loadURL(origin + '/#fleet');
  } catch {
    window.destroy();
    throw new Error('Connected to the server, but the console window could not load.');
  }
  if (window.isDestroyed()) throw new Error('The console window was closed before connecting.');
  const previous = desk;
  desk = window;
  consoleOrigin = origin;
  if (previous && !previous.isDestroyed()) previous.close();
  window.on('closed', () => {
    account.password = '';
    void session.clearAuthCache().catch(error => console.error(error.message));
    if (desk === window) {
      desk = undefined;
      consoleOrigin = undefined;
      nativeMenu();
      if (!quitting) openConnection();
    }
  });
  window.setTitle(title + ' — ' + serverName);
  nativeMenu();
  window.show();
  window.focus();
}

function fromConnection(event) {
  return connectionWindow && event.sender === connectionWindow.webContents && event.senderFrame?.url === authUrl;
}

async function connectAccount(account) {
  const serverName = await verifyServer(account);
  await launchConsole(account, serverName);
  lastServer = account.origin;
  preferLocal = account.origin === localSystem.address();
  const directory = app.getPath('userData');
  const preference = JSON.stringify({ address: lastServer, local: preferLocal });
  await mkdir(directory, { recursive: true }).then(() => writeFile(join(directory, 'server.json'), preference))
    .catch(error => console.error(error.message));
  if (connectionWindow && !connectionWindow.isDestroyed()) connectionWindow.hide();
  return { connected: true };
}

ipcMain.handle('console:defaults', event => fromConnection(event) ? { address: lastServer, preferLocal } : null);
ipcMain.handle('console:local', async event => {
  if (!fromConnection(event) || connecting) return { error: 'The local setup request is unavailable.' };
  connecting = true;
  try { return await localSystem.start(); }
  catch (error) { return { error: error.message }; }
  finally { connecting = false; }
});
ipcMain.handle('console:local-owner', async (event, password) => {
  if (!fromConnection(event) || connecting) return { error: 'The local setup request is unavailable.' };
  connecting = true;
  try { return await connectAccount(await localSystem.activate(password)); }
  catch (error) { return { error: error.message }; }
  finally { connecting = false; }
});
ipcMain.handle('console:register', async (event, input) => {
  if (!fromConnection(event) || connecting) return { error: 'The registration request is unavailable.' };
  connecting = true;
  try {
    const account = connectionInput(input);
    const invitation = typeof input.invitation === 'string' ? input.invitation.trim() : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(invitation) || account.password.length < 12 || account.password.length > 128) {
      throw new Error('Enter your invitation code and a password of at least 12 characters.');
    }
    const response = await net.fetch(account.origin + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
      redirect: 'error', signal: AbortSignal.timeout(7000),
      body: JSON.stringify({ username: account.username, invitation, password: account.password }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.registered) throw new Error(data?.error || 'The server could not activate this invitation.');
    return { registered: true };
  } catch (error) {
    return { error: error.message };
  } finally {
    connecting = false;
  }
});
ipcMain.handle('console:connect', async (event, input) => {
  if (!fromConnection(event) || connecting) return { error: 'The connection request is unavailable.' };
  connecting = true;
  try {
    return await connectAccount(connectionInput(input));
  } catch (error) {
    return { error: error.message };
  } finally {
    connecting = false;
  }
});

app.whenReady().then(async () => {
  localSystem = createLocalSystem({
    application: process.execPath,
    root: app.isPackaged ? join(process.resourcesPath, 'local-system') : join(__dirname, '..'),
    profile: app.getPath('userData'), bundled: app.isPackaged,
  });
  try {
    const { address, local } = JSON.parse(await readFile(join(app.getPath('userData'), 'server.json'), 'utf8'));
    lastServer = serverOrigin(address);
    preferLocal = local === true;
  } catch { /* Use the local demo address on first launch. */ }
  nativeMenu();
  openConnection();
});
function focusConsole() {
  if (desk && !desk.isDestroyed()) desk.show();
  else openConnection();
}
app.on('activate', focusConsole);
app.on('second-instance', focusConsole);
app.on('before-quit', event => {
  quitting = true;
  if (!closingLocal && !localSystem?.running()) return;
  event.preventDefault();
  if (closingLocal) return;
  closingLocal = true;
  void localSystem.stop().finally(() => {
    closingLocal = false;
    app.quit();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
