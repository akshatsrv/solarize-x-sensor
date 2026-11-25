const formatters = new Map();
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatter(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return formatters.get(zone);
}

function dateValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateBefore(value) {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function timeValid(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function appliesTo(scan, id, site) {
  return scan.target === 'fleet' || (scan.target === 'device' && scan.targetValue === id) ||
    (scan.target === 'site' && scan.targetValue === site);
}

export function scheduleFrom(body, state) {
  const { name, target, targetValue = '', zone, from = '', to = '', start, end, days, priority, playlist, enabled } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) throw new Error('Enter a schedule name.');
  if (!['fleet', 'site', 'device'].includes(target) ||
      (target === 'site' && !Object.values(state.devices).some(device => device.site && device.site === targetValue)) ||
      (target === 'device' && (typeof targetValue !== 'string' || !Object.hasOwn(state.devices, targetValue)))) {
    throw new Error('Select a fleet, site, or kiosk.');
  }
  if (typeof zone !== 'string' || !zone || zone.length > 64) throw new Error('Enter a valid time zone.');
  try {
    formatter(zone);
  } catch {
    throw new Error('Enter a valid time zone, such as Asia/Kolkata.');
  }
  if ((from !== '' && !dateValid(from)) || (to !== '' && !dateValid(to)) || (from && to && from > to)) {
    throw new Error('Enter a valid date range.');
  }
  if (!timeValid(start) || !timeValid(end) || !Array.isArray(days) || !days.length ||
      !days.every(day => Number.isInteger(day) && day >= 0 && day <= 6) ||
      !Number.isInteger(priority) || priority < 0 || priority > 100 || typeof enabled !== 'boolean') {
    throw new Error('Check the playback hours, weekdays, and priority.');
  }
  if (!Array.isArray(playlist) || !playlist.length || playlist.length > 40 ||
      playlist.some(id => typeof id !== 'string' || !Object.hasOwn(state.media, id))) {
    throw new Error('Add between 1 and 40 media items.');
  }
  return { name: name.trim(), target, targetValue: target === 'fleet' ? '' : targetValue,
    zone, from, to, start, end, days: [...new Set(days)].sort(), priority, playlist, enabled };
}

function includesTime(schedule, now) {
  const fields = {};
  for (const { type, value } of formatter(schedule.zone).formatToParts(now)) fields[type] = value;
  const clock = fields.hour + ':' + fields.minute;
  let date = fields.year + '-' + fields.month + '-' + fields.day;
  let day = weekdays.indexOf(fields.weekday);

  if (schedule.start < schedule.end && (clock < schedule.start || clock >= schedule.end)) return false;
  if (schedule.start > schedule.end) {
    if (clock < schedule.start && clock >= schedule.end) return false;
    if (clock < schedule.end) {
      date = dateBefore(date);
      day = (day + 6) % 7;
    }
  }
  return (!schedule.from || date >= schedule.from) && (!schedule.to || date <= schedule.to) && schedule.days.includes(day);
}

export function activeSchedule(schedules, now = new Date()) {
  const specificity = { fleet: 0, site: 1, device: 2 };
  return schedules.filter(schedule => schedule.enabled && includesTime(schedule, now)).sort((a, b) =>
    b.priority - a.priority || specificity[b.target] - specificity[a.target] || a.id.localeCompare(b.id))[0];
}
