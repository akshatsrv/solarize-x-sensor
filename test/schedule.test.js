import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeSchedule, appliesTo, scheduleFrom } from '../lib/schedule.js';

const allDays = [0, 1, 2, 3, 4, 5, 6];
const base = {
  id: 'fleet-a', name: 'Signage', target: 'fleet', zone: 'Asia/Kolkata',
  from: '', to: '', start: '09:00', end: '17:00', days: allDays,
  priority: 0, playlist: ['photo'], enabled: true,
};
const at = time => new Date(time);

test('uses the schedule time zone and excludes the end minute', () => {
  assert.equal(activeSchedule([base], at('2026-11-25T03:29:59Z')), undefined);
  assert.equal(activeSchedule([base], at('2026-11-25T03:30:00Z')), base);
  assert.equal(activeSchedule([base], at('2026-11-25T11:30:00Z')), undefined);
});

test('overnight periods apply the weekday and date of the start', () => {
  const overnight = { ...base, zone: 'UTC', start: '22:00', end: '02:00', from: '2026-11-25', to: '2026-11-25', days: [3] };
  assert.equal(activeSchedule([overnight], at('2026-11-25T23:30:00Z')), overnight);
  assert.equal(activeSchedule([overnight], at('2026-11-26T01:59:00Z')), overnight);
  assert.equal(activeSchedule([overnight], at('2026-11-26T02:00:00Z')), undefined);
  assert.equal(activeSchedule([overnight], at('2026-11-26T23:30:00Z')), undefined);
});

test('uses priority before destination specificity and supports all-day events', () => {
  const allDay = { ...base, start: '00:00', end: '00:00' };
  const site = { ...allDay, id: 'site', target: 'site', targetValue: 'Building A' };
  const kiosk = { ...site, id: 'device', target: 'device', targetValue: 'lobby' };
  const override = { ...allDay, id: 'override', priority: 5 };
  assert.equal(activeSchedule([allDay, site, kiosk], at('2026-11-25T00:00:00Z')), kiosk);
  assert.equal(activeSchedule([allDay, kiosk, override], at('2026-11-25T00:00:00Z')), override);
  assert.equal(appliesTo(site, 'other', 'Building A'), true);
  assert.equal(appliesTo(kiosk, 'other', 'Building A'), false);
});

test('rejects invalid dates, time zones and unavailable media', () => {
  const state = { devices: { lobby: { site: 'Building A' } }, media: { photo: {} } };
  assert.throws(() => scheduleFrom({ ...base, from: '2026-02-31' }, state), /date range/);
  assert.throws(() => scheduleFrom({ ...base, zone: 'Invalid/Zone' }, state), /time zone/);
  assert.throws(() => scheduleFrom({ ...base, playlist: ['missing'] }, state), /media/);
  assert.deepEqual(scheduleFrom({ ...base, days: [3, 1, 1] }, state).days, [1, 3]);
});
