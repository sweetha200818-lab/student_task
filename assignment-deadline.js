'use strict';

function isValidDueDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidDueTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isDeadlinePassed(dueDate, dueTime, now = new Date()) {
  if (!dueDate) return false;
  const deadlineTime = dueTime ? `${dueTime}:00` : '23:59:59.999';
  const deadline = new Date(`${dueDate}T${deadlineTime}`);
  return Number.isFinite(deadline.getTime()) && deadline.getTime() <= now.getTime();
}

module.exports = { isDeadlinePassed, isValidDueDate, isValidDueTime };
