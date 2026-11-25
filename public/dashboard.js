import { createOperations, renderPlaylist } from './operations.js';
import { createDesigner } from './designer.js';
import { presentationType } from './presentation-view.js';

const byId = id => document.getElementById(id);
const settingsDialog = byId('settings');
const preview = byId('preview');
const textDialog = byId('text-dialog');
const passwordDialog = byId('password-dialog');
const devices = new Map();
let fleet;
let online = false;
let editorId;
let editorPlaylist = [];
let renderedMedia;
byId('media-category').onchange = () => { if (fleet) renderLibrary(); };
const panels = new Set(['servers', 'fleet', 'designer', 'scheduler', 'library', 'playback', 'system', 'setup']);
const systemTabs = new Set(['permissions', 'licenses', 'television']);
const pageLinks = [...document.querySelectorAll('.sidebar nav a')];
const systemLinks = [...document.querySelectorAll('.section-tabs a')];
let currentPage;
let designer;

const sidebarToggle = byId('sidebar-toggle');
const navigation = byId('console-navigation');
const sidebarPreference = 'smart-self-check-sidebar';

function showSidebar(expanded) {
  document.body.classList.toggle('sidebar-collapsed', !expanded);
  navigation.hidden = !expanded;
  sidebarToggle.setAttribute('aria-expanded', String(expanded));
  sidebarToggle.setAttribute('aria-label', expanded ? 'Collapse navigation' : 'Expand navigation');
}

try { showSidebar(localStorage.getItem(sidebarPreference) !== 'collapsed'); } catch { showSidebar(true); }
sidebarToggle.onclick = () => {
  const expanded = sidebarToggle.getAttribute('aria-expanded') === 'false';
  showSidebar(expanded);
  try { localStorage.setItem(sidebarPreference, expanded ? 'expanded' : 'collapsed'); } catch { /* Storage is optional. */ }
};

function openPage() {
  const requested = location.hash.slice(1);
  const page = systemTabs.has(requested) ? 'system' : requested;
  const admin = !fleet || fleet.role === 'admin';
  const target = panels.has(page) && (admin || page !== 'system') ? page : 'fleet';
  const section = systemTabs.has(requested) ? requested : 'permissions';
  for (const panel of document.querySelectorAll('[data-page]')) panel.hidden = panel.id !== target;
  for (const card of document.querySelectorAll('[data-system]')) card.hidden = card.dataset.system !== section;
  for (const link of pageLinks) {
    const name = link.hash.slice(1);
    link.hidden = name === 'system' && !admin;
    if (name === target) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const link of systemLinks) {
    if (link.hash.slice(1) === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (currentPage !== target) {
    currentPage = target;
    document.querySelector('.workspace').scrollTop = 0;
    window.scrollTo(0, 0);
    if (target === 'setup') void designer?.checkSetup();
    if (target === 'playback') void designer?.refreshProof();
  }
}
window.addEventListener('hashchange', openPage);
openPage();

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { 'X-Kiosk-Admin': '1', ...options.headers };
  let body = options.body;
  if (body && !(body instanceof File)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(path, {
    method, headers, body,
    signal: AbortSignal.timeout(body instanceof File ? 180000 : 6000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  }
  return response.json();
}

function say(id, message, failed = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle('error', failed);
}

async function command(path, success, body) {
  try {
    await request(path, { method: 'POST', body });
    say('message', success);
  } catch (error) {
    say('message', error.message, true);
  }
}

const kioskPath = (device, action) => `/api/kiosk/${encodeURIComponent(device.id)}/${action}`;
byId('start').onclick = () => command('/api/fleet/start', 'Start sent to the fleet.');
byId('stop').onclick = () => command('/api/fleet/stop', 'Stop sent to the fleet.');
byId('defaults').onclick = () => openEditor(null);
byId('television-defaults').onclick = () => openEditor(null);

function makeButton(label, click) {
  const button = document.createElement('button');
  button.textContent = label;
  button.type = 'button';
  button.className = 'secondary compact';
  button.onclick = click;
  return button;
}

const operations = createOperations({ request, makeButton, say });
designer = createDesigner({ request, makeButton, say, schedule(item) {
  if (!fleet.media.some(entry => entry.id === item.id)) fleet.media.push(item);
  operations.schedulePresentation(item.id);
} });
if (currentPage === 'setup') void designer.checkSetup();
byId('device-search').oninput = filterDevices;
byId('device-filter').onchange = filterDevices;

function filterDevices() {
  if (!fleet) return;
  const text = byId('device-search').value.trim().toLowerCase();
  const status = byId('device-filter').value;
  let matches = 0;
  for (const device of fleet.kiosks) {
    const contains = [device.id, device.label, device.site].join(' ').toLowerCase().includes(text);
    const visible = contains && (status === 'all' || (status === 'online') === device.online);
    devices.get(device.id).tr.hidden = !visible;
    if (visible) matches += 1;
  }
  const empty = byId('empty');
  empty.hidden = matches > 0;
  empty.textContent = fleet.kiosks.length ? 'No kiosks match these filters.' : 'Enroll a kiosk to connect its device.';
}

function pair(parent) {
  const main = document.createElement('div');
  main.className = 'cell-main';
  const detail = document.createElement('div');
  detail.className = 'detail';
  parent.append(main, detail);
  return { main, detail };
}

function renderDevice(device) {
  let row = devices.get(device.id);
  if (!row) {
    const tr = byId('kiosks').insertRow();
    const name = document.createElement('th');
    name.scope = 'row';
    tr.append(name);
    const identity = pair(name);
    const display = pair(tr.insertCell());
    const network = pair(tr.insertCell());
    const sensor = pair(tr.insertCell());
    const controls = tr.insertCell();
    controls.className = 'device-controls';
    const settings = makeButton('Configure', () => openEditor(device.id));
    const restart = makeButton('Restart', () => command(kioskPath(device, 'restart'), 'Display restart requested.'));
    const toggle = makeButton('Start', null);
    const access = makeButton('Access', null);
    controls.append(settings, toggle, restart, access);
    row = { tr, identity, display, network, sensor, restart, toggle, access, settings };
    devices.set(device.id, row);
  }
  row.identity.main.textContent = device.label;
  const canManage = fleet.role === 'admin';
  const canOperate = canManage || fleet.role === 'operator';
  const license = { enrolled: 'Licensed', revoked: 'Seat released', shared: 'Demo access', unenrolled: 'Unlicensed' }[device.enrollment];
  row.identity.detail.textContent = [device.label !== device.id ? device.id : '', device.site,
    device.settings ? 'Custom playlist' : 'Fleet defaults', license].filter(Boolean).join(' · ');
  row.settings.hidden = row.access.hidden = !canManage;
  row.toggle.hidden = row.restart.hidden = !canOperate;
  row.access.onclick = () => operations.openAccess(device);
  const label = device.online ? (device.status || 'Connecting') : device.enrollment === 'revoked' ? 'Access revoked' : 'Offline';
  row.display.main.textContent = label;
  row.display.main.dataset.state = device.online ? device.status || '' : 'offline';
  row.display.detail.textContent = device.online
    ? device.error || (device.sync?.pending ? 'Syncing playlist' : device.mode === 'check-in'
      ? 'Check-in website' : device.playback?.state === 'welcome' ? 'Welcome screen · No media assigned'
        : device.playback ? `${device.playback.name} · ${device.playback.state}` : device.mode || 'Display stopped')
    : device.seen ? `Last seen ${new Date(device.seen).toLocaleString()}` : 'Awaiting first connection';
  if (device.online && device.activeSchedule && device.mode === 'marketing' && !device.error) {
    row.display.detail.textContent += ` · ${device.activeSchedule}`;
  }

  const metrics = device.metrics;
  const percent = value => Number.isFinite(value) ? `${value}%` : '—';
  row.network.main.textContent = device.online && Number.isFinite(metrics?.latencyMs) ? `${metrics.latencyMs} ms to server` : '—';
  const disk = Number.isFinite(metrics?.diskFree) ? ` · ${(metrics.diskFree / 1024 ** 3).toFixed(1)} GB free` : '';
  const displays = device.displayCount ? ` · ${device.displayCount} ${device.displayCount === 1 ? 'display' : 'displays'}` : '';
  row.network.detail.textContent = device.online && metrics ? `CPU ${percent(metrics.cpu)} · RAM ${percent(metrics.memory)}${disk}${displays}` : '';
  row.network.main.title = [device.agentPlatform, device.agentVersion && `Agent ${device.agentVersion}`].filter(Boolean).join(' · ');
  row.sensor.main.textContent = device.online ? (device.presence ? 'Visitor present' : 'No visitor') : '—';
  if (device.online && device.sensor === 'usb-pir') {
    row.sensor.detail.textContent = device.sensorSeen ? `USB PIR · Last signal ${new Date(device.sensorSeen).toLocaleTimeString()}` : 'USB PIR';
    if (device.sensorConnected !== true) row.sensor.main.textContent = 'Sensor disconnected';
    else if (!device.sensorSeen) row.sensor.main.textContent = 'Sensor connected · Awaiting signal';
  } else if (device.online && device.sensor === 'local') {
    row.sensor.detail.textContent = device.sensorSeen ? `Last reading ${new Date(device.sensorSeen).toLocaleTimeString()}` : 'Waiting for sensor data';
    if (!device.sensorSeen || Date.now() - device.sensorSeen > 15000) row.sensor.main.textContent = 'Sensor signal unavailable';
  } else if (device.online && canOperate) {
    row.sensorButton ??= makeButton('', null);
    row.sensorButton.textContent = device.simulatedPresence ? 'Simulate departure' : 'Simulate arrival';
    row.sensorButton.onclick = () => command(kioskPath(device, 'presence'), 'Simulated sensor updated.', { present: !device.simulatedPresence });
    if (!row.sensor.detail.contains(row.sensorButton)) row.sensor.detail.replaceChildren(row.sensorButton);
  } else {
    row.sensor.detail.textContent = '';
  }
  row.toggle.textContent = device.requested ? 'Stop' : 'Start';
  row.toggle.onclick = () => command(kioskPath(device, device.requested ? 'stop' : 'start'), 'Kiosk command saved.');
  row.restart.disabled = !device.requested;
  if (device.online && device.restart !== device.appliedRestart && device.requested) {
    row.restart.textContent = 'Restart pending';
    row.restart.disabled = true;
  } else {
    row.restart.textContent = 'Restart';
  }
}

function renderFleet() {
  const { kiosks } = fleet;
  byId('connection').textContent = 'Server connected';
  byId('connection').dataset.online = 'true';
  byId('status-server').textContent = fleet.server?.name ?? '';
  byId('my-account').hidden = !fleet.account;
  byId('fleet-state').textContent = fleet.enabled
    ? 'Fleet playback is enabled. Individual kiosks can be controlled below.'
    : 'Fleet playback is paused. Individual kiosks can still be started below.';
  byId('registered').textContent = kiosks.length;
  byId('online').textContent = kiosks.filter(device => device.online).length;
  byId('playing').textContent = kiosks.filter(device => device.online && device.status === 'running').length;
  byId('attention').textContent = kiosks.filter(device => !device.online || device.error || device.playback?.state === 'error').length;
  byId('defaults').disabled = fleet.role !== 'admin';
  byId('start').disabled = byId('stop').disabled = !['admin', 'operator'].includes(fleet.role);
  if (!uploading) byId('upload').disabled = !['admin', 'publisher'].includes(fleet.role);
  byId('new-text').disabled = !['admin', 'publisher'].includes(fleet.role);
  kiosks.forEach(renderDevice);
  filterDevices();
  operations.render(fleet);
  designer.render(fleet);
  openPage();
  void designer.refreshProof();
  renderLibrary();
}

byId('my-account').onclick = () => {
  byId('password-form').reset();
  const bootstrap = fleet.account === 'admin';
  byId('password-fields').hidden = byId('password-actions').hidden = bootstrap;
  byId('password-fields').disabled = bootstrap;
  byId('bootstrap-account').hidden = !bootstrap;
  byId('account-identity').textContent = 'Signed in as ' + fleet.account;
  say('password-message', '');
  passwordDialog.showModal();
};
byId('close-password').onclick = () => passwordDialog.close();
passwordDialog.onclose = () => byId('password-form').reset();
byId('password-form').onsubmit = async event => {
  event.preventDefault();
  const password = byId('new-password').value;
  if (password !== byId('confirm-password').value) {
    say('password-message', 'The new passwords do not match.', true);
    return;
  }
  const button = byId('change-password');
  button.disabled = true;
  try {
    await request('/api/auth/password', {
      method: 'POST', body: { current: byId('current-password').value, password },
    });
    byId('password-form').reset();
    byId('password-fields').disabled = true;
    byId('password-actions').hidden = true;
    say('password-message', 'Password changed. Reconnect or open a new sign-in window with your new password.');
  } catch (error) {
    say('password-message', error.message, true);
  } finally {
    button.disabled = false;
  }
};

function mediaElement(entry, previewing) {
  if (entry.type === presentationType) {
    const tile = document.createElement('div');
    tile.className = 'text-preview presentation-tile';
    tile.textContent = `${entry.slides.length} ${entry.slides.length === 1 ? 'slide' : 'slides'}`;
    return tile;
  }
  if (entry.type.startsWith('text/')) {
    const text = document.createElement('div');
    text.className = 'text-preview';
    text.textContent = previewing ? 'Loading…' : 'Text';
    if (previewing) void fetch(`/api/media/${entry.id}`, { signal: AbortSignal.timeout(6000) })
      .then(response => {
        if (!response.ok) throw new Error('Could not load this text.');
        return response.text();
      })
      .then(value => { text.textContent = value; })
      .catch(() => { text.textContent = 'Could not load this text.'; });
    return text;
  }
  const video = entry.type.startsWith('video/');
  const element = document.createElement(video ? 'video' : 'img');
  if (video) {
    element.controls = previewing;
    element.muted = !previewing;
    element.preload = 'metadata';
  } else {
    element.alt = entry.name;
    if (!previewing) element.loading = 'lazy';
  }
  element.src = `/api/media/${entry.id}`;
  return element;
}

function renderLibrary() {
  const filter = byId('media-category');
  const category = filter.value;
  const key = JSON.stringify([fleet.role, fleet.media, category]);
  if (key === renderedMedia) return;
  renderedMedia = key;
  const categories = [...new Set(fleet.media.map(entry => entry.category).filter(Boolean))].sort();
  filter.replaceChildren(new Option('All categories', ''), ...categories.map(name => new Option(name, name)));
  filter.value = categories.includes(category) ? category : '';
  const visible = fleet.media.filter(entry => !filter.value || entry.category === filter.value);
  byId('no-media').hidden = visible.length > 0;
  byId('media-library').replaceChildren(...visible.map(entry => {
    const card = document.createElement('article');
    const name = document.createElement('h3');
    name.textContent = entry.name;
    const details = document.createElement('p');
    const presentation = entry.type === presentationType;
    const kind = presentation ? 'Presentation' : entry.type.startsWith('video/') ? 'Video' : entry.type.startsWith('text/') ? 'Text' : 'Image';
    const size = presentation || kind === 'Text' ? '' : ` · ${(entry.size / 1024 ** 2).toFixed(2)} MB`;
    details.textContent = `${kind}${size}${entry.category ? ' · ' + entry.category : ''}`;
    card.append(mediaElement(entry, false), name, details, makeButton(presentation ? 'Open in Designer' : 'Preview', () => {
      if (presentation) return designer.show(entry);
      byId('preview-title').textContent = entry.name;
      byId('preview-content').replaceChildren(mediaElement(entry, true));
      preview.showModal();
    }));
    if (['admin', 'publisher'].includes(fleet.role)) card.append(makeButton('Category', async () => {
      const category = prompt('Media category', entry.category || '');
      if (category === null) return;
      try {
        await request(`/api/media/${entry.id}/category`, { method: 'PUT', body: { category } });
        say('upload-status', 'Media category saved.');
      } catch (error) {
        say('upload-status', error.message, true);
      }
    }));
    if (['admin', 'publisher'].includes(fleet.role)) card.append(makeButton('Delete', async () => {
      if (!confirm(`Delete ${entry.name} from the media library?`)) return;
      try {
        await request(`/api/media/${entry.id}`, { method: 'DELETE' });
        say('upload-status', 'Media deleted.');
      } catch (error) {
        say('upload-status', error.message, true);
      }
    }));
    return card;
  }));
  if (settingsDialog.open) fillMediaOptions();
}

byId('close-preview').onclick = () => preview.close();
preview.onclose = () => byId('preview-content').replaceChildren();

byId('new-text').onclick = () => {
  byId('text-form').reset();
  say('text-message', '');
  textDialog.showModal();
};
byId('close-text').onclick = () => textDialog.close();
byId('text-form').onsubmit = async event => {
  event.preventDefault();
  const button = byId('save-text');
  button.disabled = true;
  try {
    await request('/api/media/text', {
      method: 'POST', body: { title: byId('content-title').value, text: byId('content-text').value },
    });
    byId('media-category').value = '';
    textDialog.close();
    say('upload-status', 'Text saved. Add it to a destination playlist or schedule.');
  } catch (error) {
    say('text-message', error.message, true);
  } finally {
    button.disabled = false;
  }
};

let uploading = false;
byId('upload').onchange = async event => {
  const input = event.currentTarget;
  const files = Array.from(input.files);
  if (!files.length) return;
  uploading = input.disabled = true;
  const failures = [];
  let uploaded = 0;
  for (const file of files) {
    say('upload-status', `Uploading ${file.name}…`);
    try {
      if (file.size < 1 || file.size > 100 * 1024 * 1024) throw new Error('Select a file up to 100 MB.');
      await request('/api/media', { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      uploaded += 1;
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
    }
  }
  say('upload-status', [uploaded ? `Uploaded ${uploaded} ${uploaded === 1 ? 'file' : 'files'}.` : '', ...failures].filter(Boolean).join(' '), failures.length > 0);
  input.value = '';
  uploading = false;
  input.disabled = !online;
};

function fillMediaOptions() {
  const select = byId('media-select');
  select.replaceChildren(...fleet.media.map(entry => new Option(entry.name, entry.id)));
  byId('add-media').disabled = !fleet.media.length || editorPlaylist.length >= 40;
}

function renderEditorPlaylist() {
  renderPlaylist(editorPlaylist, fleet.media, byId('editor-playlist'), byId('add-media'), makeButton,
    'The kiosk will show its welcome screen when the playlist is empty.', renderEditorPlaylist);
}

function openEditor(id) {
  if (!fleet || fleet.role !== 'admin') return;
  editorId = id;
  const kiosk = id && fleet.kiosks.find(device => device.id === id);
  const config = kiosk?.settings ?? fleet.defaults;
  byId('settings-title').textContent = kiosk ? `Configure ${kiosk.label}` : 'Fleet defaults';
  byId('label-field').hidden = byId('inherit-field').hidden = byId('site-field').hidden = !kiosk;
  byId('label').value = kiosk?.label || '';
  byId('label').required = !!kiosk;
  byId('site').value = kiosk?.site || '';
  byId('inherit').checked = !!kiosk && !kiosk.settings;
  byId('custom-settings').disabled = byId('inherit').checked;
  for (const field of ['url', 'absenceSeconds', 'abandonSeconds', 'imageSeconds']) byId(field).value = config[field];
  byId('muted').checked = config.muted;
  byId('tv-monitor').value = config.television?.monitor ?? 1;
  byId('tv-fit').value = config.television?.fit ?? 'contain';
  byId('tv-rotation').value = config.television?.rotation ?? 0;
  editorPlaylist = [...config.playlist];
  renderEditorPlaylist();
  fillMediaOptions();
  say('settings-message', '');
  settingsDialog.showModal();
}

byId('close-settings').onclick = () => settingsDialog.close();
byId('inherit').onchange = event => { byId('custom-settings').disabled = event.target.checked; };
byId('add-media').onclick = () => {
  editorPlaylist.push(byId('media-select').value);
  renderEditorPlaylist();
};
byId('settings-form').onsubmit = async event => {
  event.preventDefault();
  const id = editorId;
  const button = byId('save-settings');
  button.disabled = true;
  say('settings-message', '');
  try {
    await request(id ? kioskPath({ id }, 'settings') : '/api/settings', {
      method: 'PUT',
      body: {
        label: byId('label').value, site: byId('site').value, inherit: byId('inherit').checked,
        url: byId('url').value, absenceSeconds: Number(byId('absenceSeconds').value),
        abandonSeconds: Number(byId('abandonSeconds').value), imageSeconds: Number(byId('imageSeconds').value),
        muted: byId('muted').checked, playlist: editorPlaylist,
        television: { monitor: Number(byId('tv-monitor').value), fit: byId('tv-fit').value, rotation: Number(byId('tv-rotation').value) },
      },
    });
    settingsDialog.close();
    say('message', 'Configuration published. Connected kiosks will sync it automatically.');
  } catch (error) {
    say('settings-message', error.message, true);
  } finally {
    button.disabled = false;
  }
};

async function refresh() {
  try {
    fleet = await request('/api/fleet');
    online = true;
    renderFleet();
  } catch {
    online = false;
    operations.disconnected();
    byId('connection').textContent = 'Server unavailable';
    byId('connection').dataset.online = 'false';
    byId('fleet-state').textContent = 'Waiting to reconnect…';
    byId('defaults').disabled = byId('start').disabled = byId('stop').disabled = byId('upload').disabled = true;
    byId('new-text').disabled = true;
  } finally {
    setTimeout(refresh, 1500);
  }
}

refresh();
