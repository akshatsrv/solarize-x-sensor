import { buildSlide } from './presentation-view.js';

const byId = id => document.getElementById(id);
const marketing = byId('marketing');
const media = byId('media');
const welcome = byId('welcome');
const title = byId('check-in-title');
const copy = byId('check-in-copy');
const button = byId('continue');
const message = byId('display-message');

let session;
let mode;
let config = { items: [], imageSeconds: 7, muted: true };
let configKey;
let item = 0;
let mediaTimer;
let busy = false;
let lastReport;
let consecutiveErrors = 0;

function report(name, state, history = false) {
  const key = `${name}:${state}`;
  if (lastReport === key && !history) return;
  lastReport = key;
  void fetch('/api/playback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, state, history }),
  }).catch(() => { if (lastReport === key) lastReport = undefined; });
}

function advanceMedia() {
  clearTimeout(mediaTimer);
  if (mode !== 'marketing') return;
  if (!config.items.length) {
    welcome.hidden = false;
    report('Welcome screen', 'welcome');
    return;
  }
  const entry = config.items[item++ % config.items.length];
  const slide = entry.slide;
  const video = (slide?.asset?.type ?? entry.type).startsWith('video/');
  const text = entry.type.startsWith('text/');
  const presentation = slide && buildSlide(slide, { muted: config.muted });
  const element = presentation ? presentation.visual : document.createElement(text ? 'div' : video ? 'video' : 'img');
  const node = presentation ? presentation.panel : element;
  const current = () => mode === 'marketing' && media.firstChild === node;
  let confirmed = false;
  const fail = () => {
    if (!current()) return;
    clearTimeout(mediaTimer);
    media.replaceChildren();
    welcome.hidden = false;
    report(entry.name, 'error', true);
    consecutiveErrors += 1;
    mediaTimer = setTimeout(advanceMedia, consecutiveErrors >= config.items.length ? 10000 : 2000);
  };
  const playing = () => {
    if (!current()) return;
    clearTimeout(mediaTimer);
    welcome.hidden = true;
    consecutiveErrors = 0;
    report(entry.name, 'playing', !confirmed);
    confirmed = true;
  };
  function startSlide() {
    if (!current() || confirmed) return;
    playing();
    mediaTimer = setTimeout(advanceMedia, slide.seconds * 1000);
  }
  if (presentation) {
    report(entry.name, 'buffering');
    media.replaceChildren(node);
    if (element) {
      element.onerror = fail;
      if (video) element.onplaying = startSlide;
      else element.onload = startSlide;
      mediaTimer = setTimeout(fail, 15000);
      element.src = slide.asset.url;
    } else startSlide();
    return;
  }
  element.onerror = fail;
  if (text) {
    element.className = 'signage-text';
  } else if (video) {
    element.autoplay = true;
    element.muted = config.muted;
    element.playsInline = true;
    element.onplaying = playing;
    element.onwaiting = () => {
      if (!current()) return;
      report(entry.name, 'buffering');
      clearTimeout(mediaTimer);
      mediaTimer = setTimeout(fail, 15000);
    };
    element.onended = () => { if (current()) advanceMedia(); };
  } else {
    element.alt = '';
    element.onload = () => {
      if (!current()) return;
      playing();
      mediaTimer = setTimeout(advanceMedia, config.imageSeconds * 1000);
    };
  }
  report(entry.name, 'buffering');
  media.replaceChildren(element);
  mediaTimer = setTimeout(fail, 15000);
  if (text) {
    void fetch(entry.url, { signal: AbortSignal.timeout(10000) }).then(response => {
      if (!response.ok) throw new Error('Text is unavailable.');
      return response.text();
    }).then(value => {
      if (!current()) return;
      element.textContent = value;
      playing();
      mediaTimer = setTimeout(advanceMedia, config.imageSeconds * 1000);
    }).catch(fail);
    return;
  }
  element.src = entry.url;
}

function render(state) {
  const website = state.mode === 'check-in' && !!state.session?.url;
  const nextMode = website ? 'website' : state.mode;
  if (mode !== nextMode) {
    mode = nextMode;
    byId('standby').hidden = mode !== 'stopped';
    marketing.hidden = mode !== 'marketing';
    byId('website').hidden = mode !== 'website';
    byId('registration').hidden = mode !== 'check-in';
    clearTimeout(mediaTimer);
    lastReport = undefined;
    if (mode === 'marketing') advanceMedia();
    else media.replaceChildren();
  }
  if (website) {
    byId('website-status').textContent = state.error || 'Opening check-in…';
    const link = byId('website-link');
    link.hidden = !state.manual;
    link.href = state.session.url;
  }
  if (session?.id === state.session?.id && session?.phase === state.session?.phase) return;
  session = state.session;
  message.textContent = '';
  if (!session || website) return;
  const screens = {
    ready: ['Welcome', 'Start your test registration.', 'Start check-in'],
    active: ['Check-in in progress', 'Complete the simulated registration when you’re ready.', 'Complete check-in'],
    complete: ['Check-in complete', 'Thank you. The welcome screen will return once you step away.'],
  };
  const [heading, description, action] = screens[session.phase];
  title.textContent = heading;
  copy.textContent = description;
  button.hidden = !action;
  button.textContent = action || '';
}

button.onclick = async () => {
  if (busy || !session) return;
  busy = button.disabled = true;
  const phase = session.phase === 'ready' ? 'active' : 'complete';
  try {
    const response = await fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: session.id, phase }),
    });
    if (!response.ok) throw new Error('Session changed. Please try again.');
  } catch (error) {
    message.textContent = error.message;
  } finally {
    busy = button.disabled = false;
  }
};

async function refreshDisplay() {
  try {
    const response = await fetch('/api/display');
    if (response.ok) render(await response.json());
  } catch { /* The local agent may be restarting. */ }
  setTimeout(refreshDisplay, 500);
}

async function refreshPlaylist() {
  try {
    const response = await fetch('/api/media');
    if (response.ok) {
      const next = await response.json();
      const key = JSON.stringify(next);
      if (key !== configKey) {
        config = next;
        media.dataset.fit = next.fit ?? 'contain';
        media.dataset.rotation = String(next.rotation ?? 0);
        configKey = key;
        item = consecutiveErrors = 0;
        if (mode === 'marketing') advanceMedia();
      }
    }
  } catch { /* Keep playing the last playlist. */ }
  setTimeout(refreshPlaylist, 1500);
}

refreshDisplay();
refreshPlaylist();
