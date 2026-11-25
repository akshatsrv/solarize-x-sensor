import { resolvePlaylist } from './presentation.js';

export const defaultCheckInUrl = 'https://solarizedigitech.com/';

export function targetName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

export function settingsFrom(body, media) {
  let url = typeof body.url === 'string' ? body.url.trim() : '';
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error('Use an HTTPS website URL without credentials.');
    }
    url = parsed.href;
  }
  const { absenceSeconds, abandonSeconds, imageSeconds, playlist, muted } = body;
  if (!Number.isInteger(absenceSeconds) || absenceSeconds < 1 || absenceSeconds > 3600 ||
      !Number.isInteger(abandonSeconds) || abandonSeconds < absenceSeconds || abandonSeconds > 86400 ||
      !Number.isInteger(imageSeconds) || imageSeconds < 1 || imageSeconds > 300 ||
      typeof muted !== 'boolean') {
    throw new Error('Check the image duration, absence timeout, and abandonment timeout.');
  }
  if (!Array.isArray(playlist) || playlist.length > 40 ||
      playlist.some(id => typeof id !== 'string' || !Object.hasOwn(media, id))) {
    throw new Error('A playlist can contain up to 40 items from the media library.');
  }
  const television = body.television ?? { monitor: 1, fit: 'contain', rotation: 0 };
  if (!Number.isInteger(television.monitor) || television.monitor < 1 || television.monitor > 8 ||
      !['contain', 'cover'].includes(television.fit) || ![0, 90, 180, 270].includes(television.rotation)) {
    throw new Error('Check the display number, media fit, and rotation.');
  }
  return { url, absenceSeconds, abandonSeconds, imageSeconds, playlist, muted,
    television: { monitor: television.monitor, fit: television.fit, rotation: television.rotation } };
}

export function deviceSettings(state, device) {
  const settings = device.settings ?? state.defaults;
  return {
    ...settings,
    television: settings.television ?? { monitor: 1, fit: 'contain', rotation: 0 },
    playlist: resolvePlaylist(state, settings.playlist),
  };
}
