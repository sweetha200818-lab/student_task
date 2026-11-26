'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidPhoneNumber, isValidUsername } = require('../account-identifiers');

test('student phone login IDs require international E.164 format', () => {
  assert.equal(isValidPhoneNumber('+919876543210'), true);
  assert.equal(isValidPhoneNumber('+14155552671'), true);
  assert.equal(isValidPhoneNumber('9876543210'), false);
  assert.equal(isValidPhoneNumber('+0123456789'), false);
  assert.equal(isValidPhoneNumber('+1234567890123456'), false);
  assert.equal(isValidPhoneNumber('+91 9876543210'), false);
});

test('teacher usernames and student phone numbers are accepted as login IDs', () => {
  assert.equal(isValidUsername('brightdesk_teacher'), true);
  assert.equal(isValidUsername('+919876543210'), true);
  assert.equal(isValidUsername('bad username'), false);
});
