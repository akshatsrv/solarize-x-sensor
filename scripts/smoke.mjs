import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const dir = await mkdtemp(join(tmpdir(), 'smart-self-check-'));
const ports = new Set();
async function newPort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  if (ports.has(port)) return newPort();
  ports.add(port);
  return port;
}
const serverPort = await newPort();
const alphaPort = await newPort();
const betaPort = await newPort();
const serverBase = `http://127.0.0.1:${serverPort}`;
const alpha = `http://127.0.0.1:${alphaPort}`;
const beta = `http://127.0.0.1:${betaPort}`;

const children = new Set();
function launch(file, overrides, args = []) {
  const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...overrides }, stdio: 'inherit' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
async function stop(child) {
  if (!children.has(child)) return;
  child.kill();
  await once(child, 'exit');
}
const serverEnv = {
  SERVER_HOST: '127.0.0.1',
  SERVER_MODE: 'demo',
  SERVER_PORT: serverPort,
  SERVER_DATA_DIR: join(dir, 'server'),
  ADMIN_TOKEN: 'integration-admin',
  KIOSK_TOKEN: 'integration-kiosk',
  CHECK_IN_URL: 'https://solarizedigitech.com/',
};
const agentEnv = { SERVER_URL: serverBase, KIOSK_TOKEN: serverEnv.KIOSK_TOKEN };
const alphaEnv = { ...agentEnv, KIOSK_ID: 'lobby', KIOSK_PORT: alphaPort, KIOSK_DATA_DIR: join(dir, 'lobby'), KIOSK_SENSOR_MODE: 'simulation' };
const betaEnv = {
  ...agentEnv, KIOSK_ID: 'reception', KIOSK_PORT: betaPort, KIOSK_DATA_DIR: join(dir, 'reception'),
  KIOSK_SENSOR_MODE: 'local', KIOSK_SENSOR_TOKEN: 'integration-sensor',
};
const adminHeaders = {
  Authorization: 'Basic ' + Buffer.from('admin:integration-admin').toString('base64'),
  'X-Kiosk-Admin': '1',
};
function get(base, path, options = {}) {
  return fetch(base + path, { ...options, signal: AbortSignal.timeout(2000) });
}
async function json(base, path, options) {
  const response = await get(base, path, options);
  assert.ok(response.ok, `HTTP ${response.status} at ${path}: ${response.statusText}`);
  return response.json();
}
const state = () => json(serverBase, '/api/fleet', { headers: adminHeaders });
const display = base => json(base, '/api/display');
const media = base => json(base, '/api/media');
const action = (path, body, method = 'POST') => json(serverBase, path, {
  method, headers: { ...adminHeaders, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const simulation = present => action('/api/kiosk/lobby/presence', { present });
const sensor = present => json(beta, '/api/sensor', {
  method: 'POST', headers: { Authorization: 'Bearer integration-sensor', 'Content-Type': 'application/json' },
  body: JSON.stringify({ present }),
});
const phase = (id, value) => json(beta, '/api/session', {
  method: 'POST', headers: { Origin: beta, 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, phase: value }),
});
async function eventually(description, check) {
  let error;
  for (let iteration = 0; iteration < 100; iteration++) {
    try {
      const result = await check();
      if (result) return result;
    } catch (caught) {
      error = caught;
    }
    await delay(125);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: error });
}
function upload(name, bytes) {
  return json(serverBase, '/api/media', {
    method: 'POST', headers: { ...adminHeaders, 'X-File-Name': encodeURIComponent(name) }, body: bytes,
  });
}

try {
  const server = launch('server.js', serverEnv);
  let first = launch('kiosk.js', alphaEnv, ['--manual-display']);
  let second = launch('kiosk.js', betaEnv, ['--manual-display']);
  await eventually('both kiosks to enroll', async () => (await state()).kiosks.length === 2);
  assert.equal((await get(serverBase, '/api/fleet')).status, 401);
  assert.equal((await display(alpha)).mode, 'stopped');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+7n9wAAAAASUVORK5CYII=', 'base64');
  const lobbyImage = await upload('Lobby sign.png', png);
  const receptionClip = await upload('Reception clip.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const newSettings = { url: serverEnv.CHECK_IN_URL, playlist: [lobbyImage.id], imageSeconds: 5, absenceSeconds: 1, abandonSeconds: 10, muted: true };
  await action('/api/settings', newSettings, 'PUT');
  await action('/api/kiosk/reception/settings', { ...newSettings, label: 'Reception', url: '', playlist: [receptionClip.id] }, 'PUT');
  assert.equal((await get(serverBase, `/api/media/${lobbyImage.id}`, { method: 'DELETE', headers: adminHeaders })).status, 409);
  await action('/api/fleet/start');
  await eventually('both kiosks to start', async () =>
    (await display(alpha)).mode === 'marketing' && (await display(beta)).mode === 'marketing');
  await eventually('different playlists to sync', async () => {
    const [a, b] = await Promise.all([media(alpha), media(beta)]);
    return a.items[0]?.id === lobbyImage.id && b.items[0]?.id === receptionClip.id;
  });
  const bytes = await get(alpha, `/media/${lobbyImage.id}`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(bytes.status, 206);
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png.subarray(0, 8));
  await json(alpha, '/api/playback', {
    method: 'POST', headers: { Origin: alpha, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: lobbyImage.name, state: 'playing' }),
  });
  await eventually('playback and metrics reporting', async () => (await state()).kiosks.some(
    device => device.id === 'lobby' && device.playback?.name === lobbyImage.name && Number.isFinite(device.metrics?.memory),
  ));
  await simulation(true);
  const opened = await eventually('live website request', async () => (await display(alpha)).session);
  assert.equal(opened.url, 'https://solarizedigitech.com/');
  assert.equal((await display(beta)).mode, 'marketing');
  await simulation(false);
  await eventually('lobby to return to signage', async () => (await display(alpha)).mode === 'marketing');

  await sensor(true);
  const visit = await eventually('sensor opening demo', async () => (await display(beta)).session);
  await phase(visit.id, 'active');
  await action('/api/kiosk/reception/restart');
  const queue = await eventually('restart to wait for active check-in', async () => {
    await display(beta);
    return (await state()).kiosks.find(device => device.id === 'reception' && device.status === 'finishing check-in');
  });
  assert.notEqual(queue.restart, queue.appliedRestart);
  await sensor(false);
  await delay(1200);
  assert.equal((await display(beta)).session.id, visit.id);
  await phase(visit.id, 'complete');
  await eventually('restart acknowledged after check-in', async () => {
    await display(beta);
    return (await state()).kiosks.find(device => device.id === 'reception' && device.restart === 1 && device.appliedRestart === 1);
  });

  await delay(250);
  await stop(server);
  await stop(first);
  first = launch('kiosk.js', alphaEnv, ['--manual-display']);
  await eventually('kiosk to start with cached media while server is offline', async () =>
    (await display(alpha)).mode === 'marketing' && (await media(alpha)).items[0]?.id === lobbyImage.id,
  );
  const restoredServer = launch('server.js', serverEnv);
  const restarted = await eventually('persisted fleet data to restore', state);
  assert.equal(restarted.kiosks.length, 2);
  assert.equal(restarted.media.length, 2);
  assert.equal(restarted.enabled, true);
  assert.equal(restarted.kiosks.find(device => device.id === 'reception').label, 'Reception');
  await action('/api/fleet/stop');
  await eventually('both kiosks to stop', async () =>
    (await display(alpha)).mode === 'stopped' && (await display(beta)).mode === 'stopped',
  );

  const text = 'Welcome to reception.\nPlease approach the kiosk. नमस्ते';
  const textAsset = await action('/api/media/text', { title: 'Reception greeting', text });
  const schedule = {
    name: 'Reception campaign', target: 'device', targetValue: 'reception', zone: 'UTC', start: '00:00', end: '00:00',
    days: [0, 1, 2, 3, 4, 5, 6], priority: 5, enabled: true, playlist: [textAsset.id, lobbyImage.id],
  };
  const savedSchedule = await action('/api/schedules', schedule);
  await eventually('only the destination kiosk gets the scheduled media', async () =>
    (await media(beta)).items[0]?.id === textAsset.id && (await media(alpha)).items[0]?.id === lobbyImage.id &&
    (await state()).kiosks.some(device => device.id === 'reception' && device.activeSchedule === schedule.name) &&
    !(await state()).kiosks.some(device => device.id === 'lobby' && device.activeSchedule === schedule.name),
  );
  await stop(restoredServer);
  await stop(second);
  second = launch('kiosk.js', betaEnv, ['--manual-display']);
  await eventually('scheduled media remains selected while the server is offline', async () =>
    (await media(beta)).items[0]?.id === textAsset.id);
  const cachedText = await get(beta, '/media/' + textAsset.id);
  assert.equal(cachedText.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await cachedText.text(), text);
  launch('server.js', serverEnv);
  await eventually('scheduler persists across server restart', async () => (await state()).schedules.some(item => item.id === savedSchedule.id));
  await action('/api/schedules/' + savedSchedule.id, { ...schedule, enabled: false }, 'PUT');
  await eventually('pausing a schedule restores the default playlist', async () =>
    (await media(beta)).items[0]?.id === receptionClip.id);

  const presentation = await action('/api/presentations', { name: 'Visitor welcome', slides: [
    { headline: 'Welcome', message: 'Step closer.', assetId: lobbyImage.id, theme: 'green', seconds: 6 },
    { headline: 'Reception', message: 'We are here to help.', assetId: '', theme: 'midnight', seconds: 8 },
  ] });
  await action('/api/schedules/' + savedSchedule.id, { ...schedule, playlist: [presentation.id] }, 'PUT');
  await action('/api/kiosk/reception/start');
  await eventually('presentation and its nested media reach the assigned kiosk', async () => {
    const { items } = await media(beta);
    return items.length === 2 && items[0].slide?.asset?.id === lobbyImage.id &&
      items[1].slide?.headline === 'Reception' && (await display(beta)).mode === 'marketing';
  });
  assert.equal((await get(beta, '/media/' + lobbyImage.id)).status, 200);
  await json(beta, '/api/playback', {
    method: 'POST', headers: { Origin: beta, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Visitor welcome · Slide 1', state: 'playing', history: true }),
  });
  await eventually('presentation produces persisted proof of play', async () => {
    const { entries } = await json(serverBase, '/api/playback?kiosk=reception', { headers: adminHeaders });
    return entries.some(event => event.state === 'played' && event.name === 'Visitor welcome · Slide 1') &&
      entries.some(event => event.state === 'check-in');
  });

  const productionPort = await newPort();
  const production = `http://127.0.0.1:${productionPort}`;
  const productionPassword = 'integration-admin-production-strong';
  launch('server.js', { ...serverEnv,
    SERVER_MODE: 'production', ADMIN_TOKEN: productionPassword, SERVER_PORT: productionPort,
    SERVER_DATA_DIR: join(dir, 'production'), SERVER_PUBLIC_URL: 'https://signage.example.test', SERVER_LICENSE_SEATS: 1,
  });
  await eventually('production readiness', async () => (await json(production, '/readyz')).status === 'ready');
  assert.equal((await get(production, '/api/fleet')).status, 403);
  const productionHeaders = (id, password) => ({
    'X-Forwarded-Proto': 'https', 'X-Kiosk-Admin': '1', 'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(id + ':' + password).toString('base64'),
  });
  const admin = productionHeaders('admin', productionPassword);
  const ops = (path, body, method = 'POST', headers = admin) => get(production, path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const enroll = id => ops('/api/enroll', { id, name: id, site: 'Office' });
  const firstSeat = await (await enroll('licensed')).json();
  assert.ok(firstSeat.token);
  assert.equal((await enroll('extra')).status, 409);
  const heartbeat = (id, token) => ops('/api/kiosk/heartbeat', { id, status: 'running' }, 'POST', {
    'X-Forwarded-Proto': 'https', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
  });
  const probeHeaders = { 'X-Forwarded-Proto': 'https', Authorization: 'Bearer ' + firstSeat.token, 'Content-Type': 'application/json' };
  assert.equal((await ops('/api/kiosk/preflight', { id: 'other' }, 'POST', probeHeaders)).status, 401);
  assert.equal((await (await ops('/api/kiosk/preflight', { id: 'licensed' }, 'POST', probeHeaders)).json()).enrolled, true);
  assert.equal((await heartbeat('licensed', serverEnv.KIOSK_TOKEN)).status, 401);
  assert.equal((await heartbeat('other', firstSeat.token)).status, 401);
  assert.equal((await heartbeat('licensed', firstSeat.token)).status, 200);
  const viewer = await (await ops('/api/accounts', { id: 'watch', role: 'viewer' })).json();
  const watch = productionHeaders('watch', viewer.password);
  const readonly = await (await ops('/api/fleet', undefined, 'GET', watch)).json();
  assert.equal(readonly.role, 'viewer');
  assert.deepEqual(readonly.accounts, []);
  assert.equal(readonly.kiosks[0].credential, undefined);
  assert.equal(readonly.server.url, 'https://signage.example.test');
  assert.equal(readonly.kiosks[0].online, true);
  assert.equal((await ops('/api/fleet/start', undefined, 'POST', watch)).status, 403);
  assert.equal((await ops('/api/schedules', schedule, 'POST', watch)).status, 403);
  assert.equal((await ops('/api/media/text', { title: 'Restricted', text: 'Read-only users cannot publish' }, 'POST', watch)).status, 403);
  const invite = await (await ops('/api/accounts/invite', { id: 'site-manager', role: 'admin' })).json();
  assert.ok(invite.token);
  assert.equal((await ops('/api/fleet', undefined, 'GET', productionHeaders('site-manager', invite.token))).status, 401);
  const firstPassword = 'Test manager password 2026';
  const activation = username => ops('/api/auth/register', { username, invitation: invite.token, password: firstPassword });
  assert.equal((await activation('other')).status, 400);
  const activated = await Promise.all([activation('site-manager'), activation('site-manager')]);
  assert.equal(activated.filter(response => response.status === 200).length, 1);
  const manager = productionHeaders('site-manager', firstPassword);
  const managerFleet = await (await ops('/api/fleet', undefined, 'GET', manager)).json();
  assert.equal(managerFleet.role, 'admin');
  assert.equal(managerFleet.account, 'site-manager');
  assert.ok(managerFleet.accounts.some(account => account.id === 'site-manager' && account.active && !account.inviteHash));
  assert.equal((await ops('/api/accounts/invite', { id: 'invited-viewer', role: 'viewer' }, 'POST', manager)).status, 201);
  const newPassword = 'Replacement password 2026';
  assert.equal((await ops('/api/auth/password', { current: 'incorrect', password: newPassword }, 'POST', manager)).status, 400);
  assert.equal((await ops('/api/auth/password', { current: firstPassword, password: newPassword }, 'POST', manager)).status, 200);
  assert.equal((await ops('/api/fleet', undefined, 'GET', manager)).status, 401);
  assert.equal((await ops('/api/fleet', undefined, 'GET', productionHeaders('site-manager', newPassword))).status, 200);
  const reset = await (await ops('/api/accounts/site-manager/invite')).json();
  assert.equal((await ops('/api/auth/register', { username: 'site-manager', invitation: reset.token, password: firstPassword })).status, 200);
  assert.equal((await ops('/api/fleet', undefined, 'GET', manager)).status, 200);
  const publisher = await (await ops('/api/accounts', { id: 'editor', role: 'publisher' })).json();
  const editor = productionHeaders('editor', publisher.password);
  assert.equal((await ops('/api/enroll', { id: 'forbidden', name: 'Forbidden', site: '' }, 'POST', editor)).status, 403);
  const productionImage = await (await get(production, '/api/media', { method: 'POST', headers: { ...editor, 'X-File-Name': 'Sign.png' }, body: png })).json();
  assert.ok(productionImage.id);
  assert.equal((await ops('/api/media/' + productionImage.id + '/category', { category: 'Lobby' }, 'PUT', editor)).status, 200);
  const mediaRequest = () => get(production, '/api/media/' + productionImage.id, { headers: {
    'X-Forwarded-Proto': 'https', 'X-Kiosk-ID': 'licensed', Authorization: 'Bearer ' + firstSeat.token,
  } });
  assert.equal((await mediaRequest()).status, 403);
  assert.equal((await ops('/api/kiosk/licensed/settings', {
    ...newSettings, label: 'Licensed', site: 'Office', playlist: [productionImage.id], television: { monitor: 2, fit: 'cover', rotation: 90 },
  }, 'PUT')).status, 200);
  assert.equal((await mediaRequest()).status, 200);
  const licensed = await (await heartbeat('licensed', firstSeat.token)).json();
  assert.deepEqual(licensed.settings.television, { monitor: 2, fit: 'cover', rotation: 90 });
  assert.equal((await ops('/api/kiosk/licensed/revoke')).status, 200);
  assert.equal((await heartbeat('licensed', firstSeat.token)).status, 401);
  assert.equal((await enroll('extra')).status, 201);
  console.log('Two-kiosk integration test passed.');
} finally {
  await Promise.all([...children].map(stop));
  await rm(dir, { recursive: true, force: true });
}
