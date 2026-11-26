'use strict';

function isValidPhoneNumber(value) {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
}

function isValidUsername(value) {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    (/^[a-zA-Z0-9._-]+$/.test(value) || /^\d+$/.test(value) || isValidPhoneNumber(value));
}

module.exports = { isValidPhoneNumber, isValidUsername };
