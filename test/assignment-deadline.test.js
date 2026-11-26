'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeadlinePassed, isValidDueDate, isValidDueTime } = require('../assignment-deadline');

test('submission stays open until the configured due minute', () => {
  assert.equal(isDeadlinePassed('2026-11-25', '16:00', new Date('2026-11-25T15:59:59')), false);
  assert.equal(isDeadlinePassed('2026-11-25', '16:00', new Date('2026-11-25T16:00:00')), true);
  assert.equal(isDeadlinePassed('2026-11-25', '16:00', new Date('2026-11-25T16:00:01')), true);
});

test('a date without a time remains open through the end of that day', () => {
  assert.equal(isDeadlinePassed('2026-11-25', null, new Date('2026-11-25T23:59:59.999')), true);
  assert.equal(isDeadlinePassed('2026-11-25', null, new Date('2026-11-25T23:59:59.998')), false);
  assert.equal(isDeadlinePassed('2026-11-25', null, new Date('2026-11-26T00:00:00')), true);
  assert.equal(isDeadlinePassed(null, null, new Date('2026-11-26T00:00:00')), false);
});

test('due date and time validation rejects impossible or malformed values', () => {
  assert.equal(isValidDueDate('2026-11-25'), true);
  assert.equal(isValidDueDate('2026-02-30'), false);
  assert.equal(isValidDueDate('25-11-2026'), false);
  assert.equal(isValidDueTime('16:00'), true);
  assert.equal(isValidDueTime('24:00'), false);
  assert.equal(isValidDueTime('4:00'), false);
});
