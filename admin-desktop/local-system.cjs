const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdir } = require('node:fs/promises');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const kioskId = 'local-kiosk';
const owner = 'owner';

async function openPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function basic(username, password) {
  return 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
}

function createLocalSystem({ application, root, profile, bundled }) {
  const directory = join(profile, 'local-system');
  let origin;
  let bootstrap;
  let server;
  let kiosk;
  let starting;

  function launch(file, settings, expected) {
    const child = spawn(application, [join(root, file)], {
      env: { ...process.env, ...settings, ELECTRON_RUN_AS_NODE: '1', SMART_LOCAL_MANAGED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stdin.on('error', () => {});
    const ready = new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';
      const timeout = setTimeout(() => reject(new Error(`${file} did not start in time.`)), 12000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', () => {
        clearTimeout(timeout);
        reject(new Error(errorOutput.trim().split('\n').at(-1) || `${file} stopped during startup.`));
      });
      child.stderr.on('data', data => { errorOutput = (errorOutput + data).slice(-3000); });
      child.stdout.on('data', data => {
        output = (output + data).slice(-3000);
        if (output.includes(expected)) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    ready.catch(() => {});
    return { child, ready };
  }

  function alive(process) {
    return !!process && process.exitCode === null && process.signalCode === null && !!process.pid;
  }

  async function stopChild(child) {
    if (!alive(child)) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.end();
    await Promise.race([closed, delay(3000)]);
    if (alive(child)) child.kill();
  }

  async function request(path, method = 'GET', body, authorization = basic('admin', bootstrap)) {
    const response = await fetch(origin + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: authorization, 'X-Kiosk-Admin': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || 'The local server returned HTTP ' + response.status + '.');
    return result;
  }

  async function stop() {
    const oldServer = server;
    const oldKiosk = kiosk;
    server = kiosk = origin = bootstrap = undefined;
    await Promise.all([stopChild(oldKiosk), stopChild(oldServer)]);
  }

  async function check() {
    const { accounts } = await request('/api/fleet');
    return { address: origin, configured: accounts.some(account => account.id === owner && account.active) };
  }

  async function start() {
    if (starting) return starting;
    starting = (async () => {
      if (alive(server) && alive(kiosk)) return check();
      await stop();
      await mkdir(directory, { recursive: true });
      const serverPort = await openPort();
      let kioskPort = await openPort();
      while (kioskPort === serverPort) kioskPort = await openPort();
      origin = 'http://127.0.0.1:' + serverPort;
      bootstrap = randomBytes(32).toString('base64url');
      const token = randomBytes(32).toString('base64url');
      try {
        const management = launch('server.js', {
          SERVER_MODE: 'demo', SERVER_HOST: '127.0.0.1', SERVER_PORT: String(serverPort),
          SERVER_NAME: 'Local Smart Self Check', SERVER_DATA_DIR: join(directory, 'server'),
          SERVER_PUBLIC_URL: '', SERVER_PEERS: '', SERVER_LICENSE_SEATS: '',
          ADMIN_TOKEN: bootstrap, KIOSK_TOKEN: token,
        }, 'Fleet dashboard at ' + origin);
        server = management.child;
        await management.ready;
        const agent = launch('kiosk.js', {
          SERVER_URL: origin, KIOSK_MODE: 'demo', KIOSK_ID: kioskId, KIOSK_TOKEN: token,
          KIOSK_SENSOR_MODE: 'simulation', KIOSK_PORT: String(kioskPort), KIOSK_WINDOWED: '1',
          KIOSK_MEDIA_DIR: '', KIOSK_DATA_DIR: join(directory, 'kiosk'),
          KIOSK_ELECTRON_PATH: application, KIOSK_BUNDLED_DESKTOP: bundled ? '1' : '0',
        }, `Kiosk ${kioskId} display at http://127.0.0.1:${kioskPort}`);
        kiosk = agent.child;
        await agent.ready;
        return check();
      } catch (error) {
        await stop();
        throw error;
      }
    })();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }

  async function activate(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128 || !password.trim()) {
      throw new Error('Choose a password of 12–128 characters.');
    }
    const { configured, address } = await start();
    if (configured) throw new Error('The local owner already exists. Sign in as owner.');
    const { accounts } = await request('/api/fleet');
    const invitation = accounts.some(account => account.id === owner)
      ? await request('/api/accounts/owner/invite', 'POST')
      : await request('/api/accounts/invite', 'POST', { id: owner, role: 'admin' });
    await request('/api/auth/register', 'POST', { username: owner, invitation: invitation.token, password }, '');
    return { origin: address, username: owner, password };
  }

  return { start, activate, stop, address: () => origin, running: () => alive(server) || alive(kiosk) };
}

module.exports = { createLocalSystem };
