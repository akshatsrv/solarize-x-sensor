import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckIn } from '../lib/check-in.js';

test('a visitor can return during absence and complete the same registration', () => {
  const flow = new CheckIn(1000, 10000);
  flow.setPresence(true, 0);
  const { id } = flow.session;
  assert.equal(flow.setPhase(id, 'active'), true);
  flow.setPresence(false, 1000);
  flow.tick(8000);
  assert.equal(flow.mode, 'check-in');
  flow.setPresence(true, 9000);
  flow.tick(25000);
  assert.deepEqual(flow.session, { id, phase: 'active' });
  assert.equal(flow.setPhase(id, 'complete'), true);
  flow.setPresence(false, 26000);
  flow.tick(26999);
  assert.equal(flow.mode, 'check-in');
  flow.tick(27000);
  assert.equal(flow.mode, 'marketing');
  flow.setPresence(true, 28000);
  assert.notEqual(flow.session.id, id);
  assert.equal(flow.setPhase(id, 'active'), false);
});

test('inactive and abandoned registrations use different absence timers', () => {
  const flow = new CheckIn(1000, 10000);
  flow.setPresence(true, 0);
  flow.setPresence(false, 1000);
  flow.tick(2000);
  assert.equal(flow.mode, 'marketing');

  flow.setPresence(true, 3000);
  flow.setPhase(flow.session.id, 'active');
  flow.setPresence(false, 4000);
  flow.tick(13999);
  assert.equal(flow.mode, 'check-in');
  flow.tick(14000);
  assert.equal(flow.mode, 'marketing');
  assert.equal(flow.session, null);
});
