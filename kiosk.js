import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asset, integer, json, matches, readJson } from './lib/http.js';
import { CheckIn } from './lib/check-in.js';
import { defaultCheckInUrl, targetName } from './lib/fleet-store.js';
import { mediaType, serveMedia } from './lib/media.js';
import { openKioskCache } from './lib/kiosk-cache.js';
import { systemMetrics } from './lib/metrics.js';
import appPackage from './package.json' with { type: 'json' };
import { activeSchedule } from './lib/schedule.js';
import { startUsbPir } from './lib/usb-pir.js';
import { displayItems, playlistFiles } from './lib/presentation.js';

const id = process.env.KIOSK_ID;
const token = process.env.KIOSK_TOKEN;
if (!targetName(id) || !token) throw new Error('Set KIOSK_ID and KIOSK_TOKEN');
const sensor = process.env.KIOSK_SENSOR_MODE || 'simulation';
const sensorToken = process.env.KIOSK_SENSOR_TOKEN;
if (!['simulation', 'local', 'usb-pir'].includes(sensor) || (sensor === 'local' && !sensorToken)) {
  throw new Error('Use KIOSK_SENSOR_MODE=simulation, local with KIOSK_SENSOR_TOKEN, or usb-pir on Windows.');
}

const serverUrl = new URL(process.env.SERVER_URL || 'http://127.0.0.1:8080');
const production = process.env.KIOSK_MODE === 'production';
if (!['http:', 'https:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password ||
    (production && serverUrl.protocol !== 'https:')) {
  throw new Error('Set SERVER_URL to the management server. Production kiosks require HTTPS.');
}
const endpoint = new URL('/api/kiosk/heartbeat', serverUrl);
const authorization = `Bearer ${token}`;
const port = integer(process.env.KIOSK_PORT, 8090, 1, 65535);
const displayUrl = `http://127.0.0.1:${port}`;
const displaySecret = randomUUID();
const manual = process.argv.includes('--manual-display');
const require = createRequire(import.meta.url);
let executable = process.env.KIOSK_ELECTRON_PATH;
if (!manual && !executable) {
  try { executable = require('electron'); } catch { /* Report the missing runtime in the dashboard. */ }
}
const desktop = fileURLToPath(new URL('./desktop.cjs', import.meta.url));
const dataDir = resolve(process.env.KIOSK_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'SmartSelfCheck', id));
const cache = await openKioskCache(dataDir);
const mediaDir = process.env.KIOSK_MEDIA_DIR && resolve(process.env.KIOSK_MEDIA_DIR);
const localMedia = mediaDir
  ? (await readdir(mediaDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && mediaType(entry.name))
      .map(entry => entry.name).sort()
  : [];

const initial = cache.configuration;
let settings = initial?.settings ?? { url: defaultCheckInUrl, absenceSeconds: 12, abandonSeconds: 120, imageSeconds: 7, muted: true };
let playlist = initial?.playlist ?? [];
let schedules = initial?.schedules ?? [];
let proof = initial?.proof ?? [];
let enabled = initial?.enabled ?? false;
let appliedRestart = initial?.restart ?? 0;
let requestedRestart = appliedRestart;
let flow = new CheckIn(settings.absenceSeconds * 1000, settings.abandonSeconds * 1000);
let child;
let closingDisplay;
let displayRunning = false;
let lastDisplay = 0;
let browserError;
let websiteError;
let displayCount;
let syncError;
let playback;
let latestReading = false;
let sensorSeen = 0;
let sensorConnected;
let stopSensor;
let latencyMs;
let connectionError;
let heartbeatDelay = 1000;
let nextLaunch = 0;
let stopping = false;
let targetContent = { playlist, schedules };
let playlistKey = JSON.stringify(targetContent);
let syncKey = playlistKey;
let retryMediaAt = 0;
let syncing = false;
let savedConfig = JSON.stringify(initial);

function saveConfig() {
  const config = { settings, playlist, schedules, proof, enabled, restart: appliedRestart };
  const key = JSON.stringify(config);
  if (key === savedConfig) return;
  savedConfig = key;
  cache.save(config).catch(error => {
    if (savedConfig === key) savedConfig = undefined;
    console.error(`Kiosk cache: ${error.message}`);
  });
}

async function syncPlaylist() {
  if (syncing || syncKey === playlistKey || Date.now() < retryMediaAt) return;
  syncing = true;
  const target = targetContent;
  try {
    const items = new Map(playlistFiles([...target.playlist, ...target.schedules.flatMap(schedule => schedule.playlist)])
      .map(item => [item.id, item]));
    for (const item of items.values()) {
      if (target !== targetContent) return;
      await cache.fetch(item, endpoint, { Authorization: authorization, 'X-Kiosk-ID': id });
    }
    if (target !== targetContent) return;
    ({ playlist, schedules } = target);
    playlistKey = syncKey;
    syncError = undefined;
    saveConfig();
  } catch (error) {
    syncError = error.message;
    retryMediaAt = Date.now() + 5000;
  } finally {
    syncing = false;
  }
}

function applySensorReading(present) {
  latestReading = present;
  if (!displayRunning || !(enabled || flow.session?.phase === 'active')) return;
  if (present && flow.mode === 'marketing') {
    flow.setPresence(true);
    flow.session.url = settings.url;
    recordProof('Proximity check-in triggered', 'check-in');
  } else {
    flow.setPresence(present);
  }
}

function recordProof(name, state) {
  proof = [...proof.slice(-499), { id: randomUUID(), name: name.slice(0, 160), state, at: Date.now(),
    schedule: activeSchedule(schedules)?.name ?? null }];
  saveConfig();
}

function stopDisplay() {
  displayRunning = false;
  lastDisplay = 0;
  browserError = undefined;
  websiteError = undefined;
  playback = undefined;
  flow = new CheckIn(settings.absenceSeconds * 1000, settings.abandonSeconds * 1000);
  if (child) {
    closingDisplay = child;
    child.kill();
  }
}

function reconcile() {
  flow.tick();
  if (!flow.session) websiteError = undefined;
  const restartPending = appliedRestart !== requestedRestart;
  if (flow.session?.phase !== 'active') {
    if ((!enabled || restartPending) && displayRunning) stopDisplay();
    if (restartPending) {
      appliedRestart = requestedRestart;
      nextLaunch = 0;
      saveConfig();
    }
  }
  if (enabled && !displayRunning) {
    displayRunning = true;
    applySensorReading(latestReading);
  }
  if (manual || child || Date.now() < nextLaunch || !displayRunning) return;
  nextLaunch = Date.now() + 4000;
  if (!executable || !existsSync(executable)) {
    browserError = 'Kiosk desktop runtime missing. Run npm ci on this device.';
    return;
  }
  const bundled = process.env.KIOSK_BUNDLED_DESKTOP === '1';
  const env = { ...process.env, KIOSK_DISPLAY_URL: displayUrl, KIOSK_DISPLAY_SECRET: displaySecret, KIOSK_DISPLAY_DATA: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.KIOSK_TOKEN;
  child = spawn(executable, [bundled ? '--smart-kiosk-display' : desktop], {
    stdio: process.env.KIOSK_DEBUG_DESKTOP === '1' ? 'inherit' : 'ignore', windowsHide: true,
    env,
  });
  child.once('error', error => { browserError = `Display launch failed: ${error.message}`; });
  const launched = child;
  child.once('close', (code, signal) => {
    child = undefined;
    lastDisplay = 0;
    if (closingDisplay === launched) {
      closingDisplay = undefined;
    } else if (displayRunning && !stopping) {
      browserError ??= `Display closed (${signal ?? code ?? 'unknown exit'}). Retrying.`;
      console.error(browserError);
    }
  });
}

function status() {
  if (!displayRunning) return 'stopped';
  if (browserError) return 'error';
  if (Date.now() - lastDisplay >= 4000) return 'starting';
  return enabled && appliedRestart === requestedRestart ? 'running' : 'finishing check-in';
}

async function heartbeat() {
  if (stopping) return;
  try {
    const metrics = await systemMetrics(dataDir, latencyMs);
    const batch = proof.slice(0, 10);
    const started = performance.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2500),
      body: JSON.stringify({
        id, status: status(), mode: displayRunning ? flow.mode : null,
        session: displayRunning ? flow.session?.phase : null,
        presence: flow.present, error: browserError || websiteError || syncError,
        metrics,
        playback: flow.mode === 'marketing' && lastDisplay > Date.now() - 4000 ? playback : null,
        sensor, sensorSeen: sensorSeen || null, sensorConnected, appliedRestart,
        agentVersion: appPackage.version, agentPlatform: process.platform,
        displayCount,
        activeSchedule: activeSchedule(schedules)?.name,
        proof: batch,
        sync: { pending: syncKey !== playlistKey, items: playlist.length },
      }),
    });
    if (response.status === 401) {
      enabled = false;
      if (sensor === 'simulation') applySensorReading(false);
      reconcile();
      saveConfig();
    }
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    const config = await response.json();
    if (batch.length) {
      const sent = new Set(batch.map(event => event.id));
      proof = proof.filter(event => !sent.has(event.id));
    }
    latencyMs = Math.round(performance.now() - started);
    if (connectionError) console.log('Fleet connection restored.');
    connectionError = undefined;
    heartbeatDelay = 1000;
    const { playlist: nextPlaylist, ...nextSettings } = config.settings;
    settings = nextSettings;
    const nextContent = { playlist: nextPlaylist, schedules: config.schedules ?? [] };
    const nextKey = JSON.stringify(nextContent);
    if (nextKey !== syncKey) {
      targetContent = nextContent;
      syncKey = nextKey;
      syncError = undefined;
      retryMediaAt = 0;
    }
    flow.absenceMs = config.absenceMs;
    flow.abandonMs = config.abandonMs;
    enabled = config.enabled;
    requestedRestart = config.restart;
    if (sensor === 'simulation') applySensorReading(config.presence);
    reconcile();
    saveConfig();
    void syncPlaylist();
  } catch (error) {
    latencyMs = null;
    if (connectionError !== error.message) console.error(`Fleet connection: ${error.message}`);
    connectionError = error.message;
    heartbeatDelay = Math.min(heartbeatDelay * 2, 10000);
  } finally {
    if (!stopping) setTimeout(heartbeat, heartbeatDelay);
  }
}

async function handle(req, res) {
  if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: 'Invalid kiosk address' });
  const path = new URL(req.url, displayUrl).pathname;
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (path === '/') return asset(res, 'display.html', 'text/html; charset=utf-8');
    if (path === '/display.js') return asset(res, 'display.js', 'text/javascript');
    if (path === '/presentation-view.js') return asset(res, 'presentation-view.js', 'text/javascript');
    if (path === '/style.css') return asset(res, 'style.css', 'text/css');
    if (path === '/api/display') {
      if (displayRunning) {
        lastDisplay = Date.now();
        browserError = undefined;
      }
      return json(res, 200, {
        mode: displayRunning ? flow.mode : 'stopped',
        session: displayRunning ? flow.session : null,
        manual, error: websiteError, monitor: settings.television?.monitor ?? 1,
      });
    }
    if (path === '/api/media') {
      const schedule = activeSchedule(schedules);
      const playing = schedule?.playlist ?? playlist;
      const items = playing.length
        ? displayItems(playing)
        : localMedia.map((name, index) => ({ name, type: mediaType(name), url: `/local-media/${index}` }));
      return json(res, 200, { items, imageSeconds: settings.imageSeconds, muted: settings.muted,
        fit: settings.television?.fit ?? 'contain', rotation: settings.television?.rotation ?? 0 });
    }
    const remote = /^\/media\/([a-f0-9-]{36})$/.exec(path);
    const item = remote && playlistFiles([...playlist, ...schedules.flatMap(schedule => schedule.playlist)])
      .find(entry => entry.id === remote[1]);
    if (item) return serveMedia(req, res, cache.path(item.id), item.type);
    const local = /^\/local-media\/(\d+)$/.exec(path);
    const name = local && localMedia[Number(local[1])];
    if (name) return serveMedia(req, res, join(mediaDir, name), mediaType(name));
  }
  if (req.method === 'POST' && path === '/api/sensor' && sensor === 'local' &&
      matches(req.headers.authorization, `Bearer ${sensorToken}`)) {
    const { present } = await readJson(req);
    if (typeof present !== 'boolean') return json(res, 400, { error: 'Set present to true or false' });
    sensorSeen = Date.now();
    applySensorReading(present);
    return json(res, 200, { received: true });
  }
  if (req.method === 'POST' && path === '/api/desktop' &&
      matches(req.headers.authorization, `Bearer ${displaySecret}`)) {
    const { id: sessionId, interaction, error, displays } = await readJson(req);
    if (Number.isInteger(displays) && displays > 0 && displays <= 32) displayCount = displays;
    if (flow.session?.id === sessionId) {
      if (interaction && flow.session.url) flow.setPhase(sessionId, 'active');
      if (typeof error === 'string') websiteError = error.slice(0, 200) || undefined;
    }
    return json(res, 200, { received: true });
  }
  if (req.method === 'POST' && req.headers.origin === displayUrl) {
    if (path === '/api/session') {
      const { id: sessionId, phase } = await readJson(req);
      if (!displayRunning || flow.session?.url || !flow.setPhase(sessionId, phase)) {
        return json(res, 409, { error: 'This demo session has ended or changed' });
      }
      return json(res, 200, { phase });
    }
    if (path === '/api/playback') {
      const { name, state, history } = await readJson(req);
      if (typeof name === 'string' && ['playing', 'error', 'buffering', 'welcome'].includes(state)) {
        playback = { name: name.slice(0, 255), state, at: Date.now() };
        if (displayRunning && flow.mode === 'marketing' && history === true && ['playing', 'error'].includes(state)) {
          recordProof(name, state === 'playing' ? 'played' : 'error');
        }
      }
      return json(res, 200, { received: true });
    }
  }
  return json(res, 404, { error: 'Route not found' });
}

const local = createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  handle(req, res).catch(error => {
    console.error(error.message);
    if (!res.headersSent) json(res, error instanceof SyntaxError ? 400 : 500, { error: 'Request failed' });
    else res.end();
  });
});
const timer = setInterval(reconcile, 250);
local.listen(port, '127.0.0.1', () => {
  console.log(`Kiosk ${id} display at ${displayUrl}`);
  if (sensor === 'usb-pir') {
    stopSensor = startUsbPir(process.env, {
      connection(connected) { sensorConnected = connected; if (connected) sensorSeen = 0; },
      reading(present) { sensorSeen = Date.now(); applySensorReading(present); },
    });
  }
  heartbeat();
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  stopSensor?.();
  clearInterval(timer);
  child?.kill();
  local.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
if (process.env.SMART_LOCAL_MANAGED === '1') process.stdin.once('end', shutdown).resume();
