import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePIRReading } from '../lib/usb-pir.js';

test('level PIR maps only observed active and inactive messages', () => {
  assert.equal(parsePIRReading('  MOTION\r', 'motion', 'clear', false), true);
  assert.equal(parsePIRReading('clear', 'motion', 'clear', false), false);
  assert.equal(parsePIRReading('startup', 'motion', 'clear', false), undefined);
});

test('pulse PIR ignores inactive and unknown messages', () => {
  assert.equal(parsePIRReading('1', '1', '0', true), true);
  assert.equal(parsePIRReading('0', '1', '0', true), undefined);
  assert.equal(parsePIRReading(undefined, '1', '0', true), undefined);
});
