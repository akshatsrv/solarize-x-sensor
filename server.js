import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, constants, statfs, unlink } from 'node:fs/promises';
import { availableParallelism, hostname, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { asset, integer, json, matches, readJson } from './lib/http.js';
import { defaultCheckInUrl, deviceSettings, settingsFrom, targetName } from './lib/fleet-store.js';
import { openSqliteFleet } from './lib/sqlite-fleet.js';
import { mediaType, serveMediaStream, storeUpload } from './lib/media.js';
import { enrollmentState, kioskAuthorized, newCredential, recordEvent, tokenHash } from './lib/enrollment.js';
import { appliesTo, scheduleFrom } from './lib/schedule.js';
import { monitorServers } from './lib/server-monitor.js';
import { playlistFiles, presentationFrom, presentationType, resolvePlaylist } from './lib/presentation.js';
import { invitationMatches, inviteLifetime, passwordRecord, verifyPassword } from './lib/accounts.js';
import appPackage from './package.json' with { type: 'json' };

const adminToken = process.env.ADMIN_TOKEN;
const kioskToken = process.env.KIOSK_TOKEN;
const mode = process.env.SERVER_MODE || 'demo';
const credentials = 'Basic ' + Buffer.from(`admin:${adminToken}`).toString('base64');
const port = integer(process.env.SERVER_PORT, 8080, 1, 65535);
const host = process.env.SERVER_HOST || '127.0.0.1';
const serverId = process.env.SERVER_ID || hostname();
const serverName = process.env.SERVER_NAME || 'Smart Self Check Server';
const serverZone = new Intl.DateTimeFormat('en', { timeZone: process.env.SERVER_TIME_ZONE }).resolvedOptions().timeZone;
const publicUrl = process.env.SERVER_PUBLIC_URL ? new URL(process.env.SERVER_PUBLIC_URL) : null;
if (!['demo', 'production'].includes(mode) || !adminToken || adminToken === kioskToken) {
  throw new Error('Set SERVER_MODE to demo or production and use distinct admin and kiosk credentials');
}
if (mode === 'demo' && !kioskToken) throw new Error('Set KIOSK_TOKEN for demo enrollment');
if (mode === 'production' && (adminToken.length < 32 || host !== '127.0.0.1' || publicUrl?.protocol !== 'https:' || publicUrl.username || publicUrl.password)) {
  throw new Error('Production requires a 32-character or longer ADMIN_TOKEN, a loopback listener, and SERVER_PUBLIC_URL using HTTPS');
}
const demoToken = mode === 'demo' ? kioskToken : undefined;
const startedAt = Date.now();
const dataDir = resolve(process.env.SERVER_DATA_DIR || 'data');
const absenceSeconds = integer(process.env.KIOSK_ABSENCE_MS, 12000, 500, 3600000) / 1000;
const abandonSeconds = integer(process.env.KIOSK_ABANDON_MS, 120000, absenceSeconds * 1000, 86400000) / 1000;
const fleet = await openSqliteFleet(dataDir, {
  url: process.env.CHECK_IN_URL ?? defaultCheckInUrl,
  absenceSeconds, abandonSeconds, imageSeconds: 7, muted: true, playlist: [],
});
const telemetry = new Map();
const simulatedPresence = new Map();
const validMediaId = /^[a-f0-9-]{36}$/;
const offlineAfterMs = integer(process.env.KIOSK_OFFLINE_AFTER_MS, 10000, 5000, 120000);
const licenseLimit = process.env.SERVER_LICENSE_SEATS ? integer(process.env.SERVER_LICENSE_SEATS, 0, 1, 100000) : null;
const peers = monitorServers(process.env.SERVER_PEERS, publicUrl?.origin);
const roles = ['viewer', 'publisher', 'operator', 'admin'];
const verifiedAccounts = new Map();

function validProof(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 15).filter(event => event && typeof event.id === 'string' && validMediaId.test(event.id) &&
    Number.isSafeInteger(event.at) && event.at > 0 && event.at <= Date.now() + 3600000 &&
    typeof event.name === 'string' && event.name.length <= 160 && ['played', 'error', 'check-in'].includes(event.state))
    .map(event => ({ ...event, schedule: typeof event.schedule === 'string' ? event.schedule.slice(0, 64) : null }));
}

async function signedIn(header) {
  if (matches(header, credentials)) return { id: 'admin', role: 'admin' };
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const id = decoded.slice(0, separator);
  if (separator < 1 || !Object.hasOwn(fleet.state.accounts, id)) return null;
  const account = fleet.state.accounts[id];
  const credential = account.password?.key ?? account.hash;
  if (!credential) return null;
  const fingerprint = tokenHash(header);
  const cached = verifiedAccounts.get(id);
  if (cached?.credential === credential && cached.expires > Date.now() && matches(fingerprint, cached.fingerprint)) {
    return { id, role: account.role };
  }
  if (!await verifyPassword(decoded.slice(separator + 1), account)) return null;
  const latest = Object.hasOwn(fleet.state.accounts, id) && fleet.state.accounts[id];
  if (!latest || (latest.password?.key ?? latest.hash) !== credential) return null;
  verifiedAccounts.set(id, { credential, fingerprint, expires: Date.now() + 120000 });
  return { id, role: latest.role };
}

function mayWrite(role, path) {
  if (role === 'admin') return true;
  if (role === 'publisher') return ['/api/media', '/api/schedules', '/api/presentations'].some(base => path === base || path.startsWith(base + '/'));
  return role === 'operator' && (/^\/api\/fleet\/(start|stop)$/.test(path) || /^\/api\/kiosk\/[a-zA-Z0-9_-]+\/(start|stop|restart|presence)$/.test(path));
}

function seatsUsed(state) {
  return Object.values(state.devices).filter(device => device.credential?.hash).length;
}

function enabledFor(state, device) {
  return device.enabled ?? state.enabled;
}

function knownDevice(state, id) {
  return Object.hasOwn(state.devices, id) ? state.devices[id] : undefined;
}

function schedulesFor(state, id, device) {
  return Object.values(state.schedules).filter(schedule => schedule.enabled && appliesTo(schedule, id, device.site));
}

function addDevice(state, id, fields) {
  Object.defineProperty(state.devices, id, {
    value: { label: id, site: '', enabled: null, settings: null, restart: 0, ...fields },
    enumerable: true, writable: true, configurable: true,
  });
}

function checkpointTelemetry() {
  return fleet.update(state => {
    let changed = false;
    for (const [id, { seen }] of telemetry) {
      const device = knownDevice(state, id);
      if (device && (!device.lastSeen || seen > device.lastSeen)) {
        device.lastSeen = seen;
        changed = true;
      }
    }
    return changed;
  });
}

async function heartbeat(req, res) {
  const { id, status, mode, session, presence, error, metrics, playback, sensor, sensorSeen, sensorConnected, appliedRestart, sync, agentVersion, agentPlatform, activeSchedule, displayCount, proof } = await readJson(req);
  if (!targetName(id)) return json(res, 400, { error: 'Invalid kiosk ID' });
  const current = knownDevice(fleet.state, id);
  const authorization = req.headers.authorization;
  if (!kioskAuthorized(authorization, current, demoToken)) return json(res, 401, { error: 'Kiosk credential rejected' });
  const seen = Date.now();
  if (!current?.lastSeen) {
    await fleet.update(state => {
      const device = knownDevice(state, id);
      if (!kioskAuthorized(authorization, device, demoToken)) return false;
      if (!device) addDevice(state, id, { lastSeen: seen });
      else if (!device.lastSeen) device.lastSeen = seen;
      else return false;
    });
  }
  const state = fleet.state;
  const device = knownDevice(state, id);
  if (!device || !kioskAuthorized(authorization, device, demoToken)) return json(res, 401, { error: 'Kiosk credential rejected' });
  const events = validProof(proof);
  if (events.length) await fleet.appendProof(id, events);
  telemetry.set(id, { status, mode, session, presence, error, metrics, playback, sensor, sensorSeen, sensorConnected, appliedRestart, sync, agentVersion, agentPlatform, activeSchedule, displayCount, seen });
  const settings = deviceSettings(state, device);
  return json(res, 200, {
    enabled: enabledFor(state, device),
    presence: simulatedPresence.get(id) ?? false,
    restart: device.restart,
    settings,
    schedules: schedulesFor(state, id, device).map(schedule => ({
      ...schedule, playlist: resolvePlaylist(state, schedule.playlist),
    })),
    absenceMs: settings.absenceSeconds * 1000,
    abandonMs: settings.abandonSeconds * 1000,
  });
}

async function upload(req, res) {
  let name;
  try {
    name = decodeURIComponent(req.headers['x-file-name'] ?? '');
    if (!name || name.length > 255 || /[\/\\\x00-\x1f]/.test(name)) throw new Error();
  } catch {
    return json(res, 400, { error: 'The filename is invalid.' });
  }
  const type = mediaType(name);
  if (!type) return json(res, 415, { error: 'Use MP4, WebM, JPEG, PNG, or WebP.' });
  const id = randomUUID();
  const temporary = join(fleet.uploadDir, `${id}.upload`);
  try {
    let size;
    try {
      size = await storeUpload(req, temporary);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    const entry = { id, name, type, size };
    await fleet.addMedia(entry, () => createReadStream(temporary, { highWaterMark: 256 * 1024 }),
      state => recordEvent(state, 'Media uploaded', null, req.operator.id));
    return json(res, 201, entry);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') console.error(error.message); });
  }
}

async function createText(req, res) {
  const { title, text } = await readJson(req);
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 ||
      typeof text !== 'string' || !text.trim() || text.trim().length > 3000) {
    return json(res, 400, { error: 'Enter a title and up to 3,000 characters of text.' });
  }
  const bytes = Buffer.from(text.trim(), 'utf8');
  const entry = { id: randomUUID(), name: title.trim(), type: 'text/plain; charset=utf-8', size: bytes.length };
  await fleet.addMedia(entry, () => [bytes], state => recordEvent(state, 'Text content created', null, req.operator.id));
  return json(res, 201, entry);
}

async function savePresentation(req, res, id = randomUUID()) {
  const body = await readJson(req);
  let error;
  let presentation;
  await fleet.update(state => {
    const previous = state.media[id];
    if (req.method === 'PUT' && previous?.type !== presentationType) {
      error = { status: 404, message: 'Presentation not found.' };
      return false;
    }
    try {
      presentation = { ...previous, id, type: presentationType, size: 0, ...presentationFrom(body, state.media) };
    } catch (validation) {
      error = { status: 400, message: validation.message };
      return false;
    }
    state.media[id] = presentation;
    recordEvent(state, previous ? 'Presentation updated' : 'Presentation created', null, req.operator.id);
  });
  if (error) return json(res, error.status, { error: error.message });
  return json(res, req.method === 'POST' ? 201 : 200, presentation);
}

async function updateSettings(req, res, id) {
  const body = await readJson(req);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const site = typeof body.site === 'string' ? body.site.trim() : '';
  if (id && (!label || label.length > 64)) {
    return json(res, 400, { error: 'Enter a kiosk name up to 64 characters.' });
  }
  if (site.length > 64) return json(res, 400, { error: 'Use a site name up to 64 characters.' });
  let validationError;
  await fleet.update(state => {
    let settings;
    try {
      settings = id && body.inherit === true ? null : settingsFrom(body, state.media);
    } catch (error) {
      validationError = error.message;
      return false;
    }
    if (id) Object.assign(state.devices[id], { label, site: body.site === undefined ? state.devices[id].site ?? '' : site, settings });
    else state.defaults = settings;
    recordEvent(state, id ? 'Kiosk settings published' : 'Fleet defaults published', id, req.operator.id);
  });
  if (validationError) return json(res, 400, { error: validationError });
  return json(res, 200, { saved: true });
}

async function enroll(req, res) {
  const { id, name, site } = await readJson(req);
  if (!targetName(id) || typeof name !== 'string' || !name.trim() || name.trim().length > 64 ||
      typeof site !== 'string' || site.trim().length > 64) {
    return json(res, 400, { error: 'Enter a kiosk ID, name, and an optional site. Use up to 64 characters per field.' });
  }
  const { token, hash } = newCredential();
  let error;
  await fleet.update(state => {
    if (knownDevice(state, id)) {
      error = 'That kiosk ID is already registered. Use its credential controls.';
      return false;
    }
    if (licenseLimit !== null && seatsUsed(state) >= licenseLimit) {
      error = 'All kiosk license seats are assigned.';
      return false;
    }
    addDevice(state, id, { label: name.trim(), site: site.trim(), credential: { hash } });
    recordEvent(state, 'Kiosk enrolled', id, req.operator.id);
  });
  if (error) return json(res, 409, { error });
  return json(res, 201, { id, token, serverUrl: publicUrl?.origin });
}

async function manageSchedule(req, res, existingId) {
  const deleting = req.method === 'DELETE';
  const body = deleting ? null : await readJson(req);
  const id = existingId ?? randomUUID();
  let error;
  await fleet.update(state => {
    if (existingId && !Object.hasOwn(state.schedules, id)) {
      error = { status: 404, message: 'Schedule not found.' };
      return false;
    }
    if (!existingId && Object.keys(state.schedules).length >= 100) {
      error = { status: 409, message: 'Remove an existing schedule before adding another.' };
      return false;
    }
    if (deleting) delete state.schedules[id];
    else {
      try {
        state.schedules[id] = { id, ...scheduleFrom(body, state) };
      } catch (validation) {
        error = { status: 400, message: validation.message };
        return false;
      }
    }
    recordEvent(state, deleting ? 'Schedule deleted' : 'Schedule published', null, req.operator.id);
  });
  if (error) return json(res, error.status, { error: error.message });
  return json(res, existingId ? 200 : 201, { id });
}

async function manageAccount(req, res, existingId) {
  const deleting = req.method === 'DELETE';
  const body = deleting ? {} : await readJson(req);
  const id = existingId ?? body.id;
  if (!targetName(id) || id.toLowerCase() === 'admin' || (!deleting && !roles.includes(body.role))) {
    return json(res, 400, { error: 'Enter a unique user name and choose a role.' });
  }
  const credential = existingId ? null : newCredential();
  let error;
  await fleet.update(state => {
    const exists = Object.hasOwn(state.accounts, id);
    if (existingId && !exists) { error = 404; return false; }
    if (!existingId && exists) { error = 409; return false; }
    if (deleting) delete state.accounts[id];
    else if (credential) {
      Object.defineProperty(state.accounts, id, { value: { role: body.role, hash: credential.hash }, enumerable: true, writable: true, configurable: true });
    } else state.accounts[id].role = body.role;
    recordEvent(state, `Account ${id} ${deleting ? 'removed' : credential ? 'created' : 'updated'}`, null, req.operator.id);
  });
  if (error) return json(res, error, { error: error === 404 ? 'Account not found.' : 'This account already exists.' });
  if (deleting) verifiedAccounts.delete(id);
  return json(res, existingId ? 200 : 201, { id, role: body.role, password: credential?.token });
}

async function issueInvite(req, res, existingId) {
  const body = existingId ? {} : await readJson(req);
  const id = existingId ?? body.id;
  if (!targetName(id) || id.toLowerCase() === 'admin' || (!existingId && !roles.includes(body.role))) {
    return json(res, 400, { error: 'Enter a unique user name and choose a role.' });
  }
  const { token, hash } = newCredential();
  const inviteUntil = Date.now() + inviteLifetime;
  let error;
  await fleet.update(state => {
    const exists = Object.hasOwn(state.accounts, id);
    if (existingId && !exists) { error = 404; return false; }
    if (!existingId && exists) { error = 409; return false; }
    if (exists) Object.assign(state.accounts[id], { inviteHash: hash, inviteUntil });
    else Object.defineProperty(state.accounts, id, {
      value: { role: body.role, inviteHash: hash, inviteUntil }, enumerable: true, writable: true, configurable: true,
    });
    recordEvent(state, `Account ${id} invitation issued`, null, req.operator.id);
  });
  if (error) return json(res, error, { error: error === 404 ? 'Account not found.' : 'That user name already exists.' });
  return json(res, existingId ? 200 : 201, { id, token, inviteUntil });
}

async function register(req, res) {
  const { username, invitation, password } = await readJson(req);
  const lookup = state => Object.hasOwn(state.accounts, username) ? state.accounts[username] : undefined;
  if (!targetName(username) || !invitationMatches(lookup(fleet.state), invitation)) {
    return json(res, 400, { error: 'This invitation is invalid, expired, or already used.' });
  }
  let updated;
  try { updated = await passwordRecord(password); }
  catch (error) { return json(res, 400, { error: error.message }); }
  let activated = false;
  await fleet.update(state => {
    const account = lookup(state);
    if (!invitationMatches(account, invitation)) return false;
    account.password = updated;
    delete account.hash;
    delete account.inviteHash;
    delete account.inviteUntil;
    recordEvent(state, `Account ${username} activated its password`, null, username);
    activated = true;
  });
  verifiedAccounts.delete(username);
  return activated ? json(res, 200, { registered: true }) : json(res, 409, { error: 'The invitation was already used.' });
}

async function changePassword(req, res, operator) {
  if (operator.id === 'admin') return json(res, 403, { error: 'The bootstrap administrator password is managed on the server.' });
  const { current, password } = await readJson(req);
  const account = fleet.state.accounts[operator.id];
  if (!await verifyPassword(current, account)) return json(res, 400, { error: 'The current password is incorrect.' });
  let updated;
  try { updated = await passwordRecord(password); }
  catch (error) { return json(res, 400, { error: error.message }); }
  const prior = account.password?.key ?? account.hash;
  let changed = false;
  await fleet.update(state => {
    const next = state.accounts[operator.id];
    if (!next || (next.password?.key ?? next.hash) !== prior) return false;
    next.password = updated;
    delete next.hash;
    delete next.inviteHash;
    delete next.inviteUntil;
    recordEvent(state, `Account ${operator.id} changed its password`, null, operator.id);
    changed = true;
  });
  verifiedAccounts.delete(operator.id);
  return changed ? json(res, 200, { changed: true }) : json(res, 409, { error: 'The account changed. Sign in again.' });
}

async function adminAction(req, res, path) {
  if (req.method === 'POST' && path === '/api/enroll') return enroll(req, res);
  if (req.method === 'POST' && path === '/api/presentations') return savePresentation(req, res);
  const presentation = path.match(/^\/api\/presentations\/([a-f0-9-]{36})$/);
  if (req.method === 'PUT' && presentation) return savePresentation(req, res, presentation[1]);
  if (req.method === 'POST' && path === '/api/accounts') return manageAccount(req, res);
  if (req.method === 'POST' && path === '/api/accounts/invite') return issueInvite(req, res);
  const invite = path.match(/^\/api\/accounts\/([a-zA-Z0-9_-]{1,64})\/invite$/);
  if (req.method === 'POST' && invite) return issueInvite(req, res, invite[1]);
  const account = path.match(/^\/api\/accounts\/([a-zA-Z0-9_-]{1,64})$/);
  if (account && ['PUT', 'DELETE'].includes(req.method)) return manageAccount(req, res, account[1]);
  if (req.method === 'POST' && path === '/api/schedules') return manageSchedule(req, res);
  const schedule = path.match(/^\/api\/schedules\/([a-f0-9-]{36})$/);
  if (schedule && ['PUT', 'DELETE'].includes(req.method)) return manageSchedule(req, res, schedule[1]);
  if (req.method === 'PUT' && path === '/api/settings') return updateSettings(req, res);
  if (req.method === 'POST' && path === '/api/media') return upload(req, res);
  if (req.method === 'POST' && path === '/api/media/text') return createText(req, res);
  const categoryMatch = path.match(/^\/api\/media\/([a-f0-9-]{36})\/category$/);
  if (req.method === 'PUT' && categoryMatch) {
    const { category } = await readJson(req);
    if (typeof category !== 'string' || category.trim().length > 64) {
      return json(res, 400, { error: 'Use a category name up to 64 characters.' });
    }
    const id = categoryMatch[1];
    let found = false;
    await fleet.update(state => {
      if (!Object.hasOwn(state.media, id)) return false;
      state.media[id].category = category.trim();
      recordEvent(state, 'Media category updated', null, req.operator.id);
      found = true;
    });
    return found ? json(res, 200, { saved: true }) : json(res, 404, { error: 'Media not found.' });
  }
  const mediaId = path.startsWith('/api/media/') && path.slice('/api/media/'.length);
  if (req.method === 'DELETE' && mediaId && validMediaId.test(mediaId)) {
    let status = 200;
    await fleet.update(state => {
      if (!Object.hasOwn(state.media, mediaId)) {
        status = 404;
        return false;
      }
      const settings = [state.defaults, ...Object.values(state.devices).map(device => device.settings)];
      if ([...settings, ...Object.values(state.schedules)].some(config => config?.playlist.includes(mediaId)) ||
          Object.values(state.media).some(item => item.slides?.some(slide => slide.assetId === mediaId))) {
        status = 409;
        return false;
      }
      delete state.media[mediaId];
      recordEvent(state, 'Media deleted', null, req.operator.id);
    });
    if (status === 409) return json(res, status, { error: 'Remove this content from playlists and presentations before deleting it.' });
    if (status === 404) return json(res, status, { error: 'Media not found.' });
    return json(res, 200, { deleted: true });
  }
  const all = path.match(/^\/api\/fleet\/(start|stop)$/);
  if (req.method === 'POST' && all) {
    await fleet.update(state => {
      state.enabled = all[1] === 'start';
      for (const device of Object.values(state.devices)) device.enabled = null;
      recordEvent(state, state.enabled ? 'Fleet start requested' : 'Fleet stop requested', null, req.operator.id);
    });
    return json(res, 200, { enabled: fleet.state.enabled });
  }
  const match = path.match(/^\/api\/kiosk\/([a-zA-Z0-9_-]{1,64})\/(settings|start|stop|follow|restart|presence|credential|revoke)$/);
  if (!match) return json(res, 404, { error: 'Route not found' });
  const [, id, action] = match;
  if (!knownDevice(fleet.state, id)) return json(res, 404, { error: 'Unknown kiosk' });
  if (req.method === 'PUT' && action === 'settings') return updateSettings(req, res, id);
  if (req.method !== 'POST' || action === 'settings') return json(res, 405, { error: 'Method not allowed' });
  if (action === 'credential' || action === 'revoke') {
    const credential = action === 'credential' ? newCredential() : null;
    let limited = false;
    await fleet.update(state => {
      if (credential && !state.devices[id].credential?.hash && licenseLimit !== null && seatsUsed(state) >= licenseLimit) {
        limited = true;
        return false;
      }
      state.devices[id].credential = { hash: credential?.hash ?? null };
      recordEvent(state, credential ? 'Kiosk credential issued' : 'Kiosk credential revoked', id, req.operator.id);
    });
    if (limited) return json(res, 409, { error: 'All kiosk license seats are assigned.' });
    telemetry.delete(id);
    if (credential) return json(res, 200, { id, token: credential.token, serverUrl: publicUrl?.origin });
    return json(res, 200, { applied: true });
  }

  if (action === 'presence') {
    const { present } = await readJson(req);
    if (typeof present !== 'boolean') return json(res, 400, { error: 'Set present to true or false' });
    if (['local', 'usb-pir'].includes(telemetry.get(id)?.sensor)) return json(res, 409, { error: 'This kiosk uses hardware sensor input.' });
    simulatedPresence.set(id, present);
  } else {
    await fleet.update(state => {
      const device = state.devices[id];
      if (action === 'restart') device.restart += 1;
      else device.enabled = action === 'follow' ? null : action === 'start';
      const event = {
        restart: 'Kiosk restart requested', start: 'Kiosk start requested', stop: 'Kiosk stop requested', follow: 'Kiosk set to follow fleet',
      }[action];
      recordEvent(state, event, id, req.operator.id);
    });
  }
  return json(res, 200, { applied: true });
}

async function handle(req, res) {
  const { pathname: path, searchParams } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });
  if (req.method === 'GET' && path === '/readyz') {
    try {
      await access(fleet.uploadDir, constants.R_OK | constants.W_OK);
      await access(fleet.databasePath, constants.R_OK | constants.W_OK);
      return json(res, 200, { status: 'ready' });
    } catch {
      return json(res, 503, { status: 'unavailable' });
    }
  }
  if (mode === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return json(res, 403, { error: 'Use the server HTTPS address.' });
  }
  if (mode === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.method === 'GET' && path === '/register') return asset(res, 'register.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && path === '/register.js') return asset(res, 'register.js', 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && path === '/register.css') return asset(res, 'register.css', 'text/css; charset=utf-8');
  if (req.method === 'POST' && path === '/api/auth/register') return register(req, res);
  const operator = await signedIn(req.headers.authorization);
  if (req.method === 'POST' && path === '/api/kiosk/preflight') {
    const { id } = await readJson(req);
    if (!targetName(id)) return json(res, 400, { error: 'Invalid kiosk ID.' });
    const device = knownDevice(fleet.state, id);
    if (!kioskAuthorized(req.headers.authorization, device, demoToken)) return json(res, 401, { error: 'Kiosk credential rejected.' });
    return json(res, 200, { server: serverName, mode, enrolled: !!device, version: appPackage.version });
  }
  if (req.method === 'POST' && path === '/api/kiosk/heartbeat') {
    return heartbeat(req, res);
  }
  const mediaId = path.startsWith('/api/media/') && path.slice('/api/media/'.length);
  if (mediaId && validMediaId.test(mediaId) && (req.method === 'GET' || req.method === 'HEAD')) {
    const id = req.headers['x-kiosk-id'];
    const device = targetName(id) ? knownDevice(fleet.state, id) : undefined;
    const authorization = req.headers.authorization;
    const assigned = device && kioskAuthorized(authorization, device, demoToken) &&
      [deviceSettings(fleet.state, device).playlist, ...schedulesFor(fleet.state, id, device).map(schedule => resolvePlaylist(fleet.state, schedule.playlist))]
        .some(list => playlistFiles(list).some(item => item.id === mediaId));
    const legacy = !id && kioskAuthorized(authorization, null, demoToken);
    if (!operator && !legacy && !assigned) return json(res, 403, { error: 'Media is unavailable to this kiosk.' });
    const entry = fleet.state.media[mediaId];
    if (!entry) return json(res, 404, { error: 'Media not found' });
    return serveMediaStream(req, res, entry.size, entry.type, (start, end) => fleet.streamMedia(entry.id, start, end));
  }
  if (!operator) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Smart Self Check", charset="UTF-8"');
    return json(res, 401, { error: 'Sign in with your console credentials.' });
  }
  if (req.method === 'POST' && path === '/api/auth/password' && req.headers['x-kiosk-admin'] === '1') {
    return changePassword(req, res, operator);
  }
  if (req.method === 'GET' && path === '/') return asset(res, 'dashboard.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && path === '/dashboard.js') return asset(res, 'dashboard.js', 'text/javascript');
  if (req.method === 'GET' && path === '/operations.js') return asset(res, 'operations.js', 'text/javascript');
  if (req.method === 'GET' && path === '/designer.js') return asset(res, 'designer.js', 'text/javascript');
  if (req.method === 'GET' && path === '/presentation-view.js') return asset(res, 'presentation-view.js', 'text/javascript');
  if (req.method === 'GET' && path === '/style.css') return asset(res, 'style.css', 'text/css');
  if (req.method === 'GET' && path === '/console.css') return asset(res, 'console.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && path === '/api/playback') {
    const kiosk = searchParams.get('kiosk');
    if (kiosk && !targetName(kiosk)) return json(res, 400, { error: 'Invalid kiosk ID.' });
    return json(res, 200, { entries: fleet.playback(kiosk, 150) });
  }
  if (req.method === 'GET' && path === '/api/deployment') {
    const disk = await statfs(dataDir).catch(() => null);
    return json(res, 200, {
      platform: process.platform, architecture: process.arch, node: process.version,
      cores: availableParallelism(), memory: totalmem(), diskFree: disk ? disk.bavail * disk.bsize : null,
      mode, port, kioskUrl: publicUrl?.origin ?? null, storage: 'SQLite',
    });
  }
  if (req.method === 'GET' && path === '/api/fleet') {
    const state = fleet.state;
    return json(res, 200, {
      enabled: state.enabled,
      role: operator.role,
      account: operator.id,
      license: { limit: licenseLimit, used: seatsUsed(state) },
      accounts: operator.role === 'admin' ? Object.entries(state.accounts).map(([id, account]) => ({
        id, role: account.role, active: !!(account.hash || account.password), inviteUntil: account.inviteUntil,
      })) : [],
      peers: peers.servers,
      server: { id: serverId, name: serverName, url: publicUrl?.origin ?? null, mode, version: appPackage.version, startedAt, offlineAfterMs, checkedAt: Date.now(), zone: serverZone },
      events: state.events.slice(-20).reverse(),
      schedules: Object.values(state.schedules),
      defaults: state.defaults,
      media: Object.values(state.media),
      kiosks: Object.entries(state.devices).map(([id, device]) => {
        const report = telemetry.get(id);
        const { credential, lastSeen, ...info } = device;
        return {
          id, ...info, ...report, seen: report?.seen ?? lastSeen,
          enrollment: !credential && mode === 'production' ? 'unenrolled' : enrollmentState(device),
          requested: enabledFor(state, device),
          online: !!report && Date.now() - report.seen < offlineAfterMs,
          simulatedPresence: simulatedPresence.get(id) ?? false,
        };
      }),
    });
  }
  if (req.headers['x-kiosk-admin'] === '1' && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (!mayWrite(operator.role, path)) return json(res, 403, { error: 'Your role cannot make this change.' });
    req.operator = operator;
    return adminAction(req, res, path);
  }
  return json(res, 404, { error: 'Route not found' });
}

const server = createServer({ requestTimeout: 210000, headersTimeout: 15000 }, (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  handle(req, res).catch(error => {
    console.error(error.message);
    if (!res.headersSent) json(res, error instanceof SyntaxError ? 400 : 500, { error: 'Request failed' });
    else res.end();
  });
}).listen(port, host, () => console.log(`Fleet dashboard at http://${host}:${port}`));
const checkpoints = setInterval(() => {
  checkpointTelemetry().catch(error => console.error(`Saving last-seen times: ${error.message}`));
}, 30000).unref();

function shutdown() {
  clearInterval(checkpoints);
  peers.stop();
  server.close(async () => {
    try {
      await checkpointTelemetry();
      await fleet.flush();
      fleet.close();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });
  setTimeout(() => server.closeAllConnections(), 10000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
