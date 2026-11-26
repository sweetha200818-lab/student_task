const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const { isDeadlinePassed, isValidDueDate, isValidDueTime } = require('./assignment-deadline');
const { isValidPhoneNumber: validPhoneNumber, isValidUsername: validUsername } = require('./account-identifiers');

require('dotenv').config();

const root = __dirname;
const dataDirectory = process.env.PORTAL_DATA_DIR || path.join(root, '.portal-data');
const usersFile = path.join(dataDirectory, 'users.json');
const port = Number(process.env.PORT || 3000);
const databaseConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || '',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || ''
};
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const sessionCookie = 'brightdesk_session';
const sessionStore = new Map();
const defaultPortalData = {
  bd_classes: [],
  bd_attendance: {},
  bd_tasks: [],
  bd_student_names: {},
  bd_teachers: [],
  bd_events: [],
  bd_role: 'student',
  bd_display_name: '',
  bd_roll_number: '',
  bd_email: ''
};

let database;

async function initializeDatabase() {
  const missingSettings = ['DB_USER', 'DB_PASSWORD', 'DB_NAME']
    .filter(name => !process.env[name]);
  if (missingSettings.length) {
    throw new Error(`Set ${missingSettings.join(', ')} in your .env file before starting the portal.`);
  }
  if (!Number.isInteger(databaseConfig.port) || databaseConfig.port < 1 || databaseConfig.port > 65535) {
    throw new Error('DB_PORT must be a valid TCP port.');
  }

  database = mysql.createPool({
    ...databaseConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
  await database.query(`
    CREATE TABLE IF NOT EXISTS portal_users (
      username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      salt CHAR(32) NOT NULL,
      password_hash CHAR(128) NOT NULL,
      portal_data JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS portal_event_status (
      event_id CHAR(36) NOT NULL,
      username VARCHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL,
      penalty VARCHAR(300) NOT NULL DEFAULT '',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, username),
      INDEX idx_event_status_username (username)
    ) ENGINE=InnoDB
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS portal_assignments (
      id CHAR(36) PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      details VARCHAR(1000) NOT NULL DEFAULT '',
      subject VARCHAR(100) NOT NULL DEFAULT '',
      due_date DATE NULL,
      due_time TIME NULL,
      assigned_by VARCHAR(64) NOT NULL,
      recipients JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_assigned_by (assigned_by)
    ) ENGINE=InnoDB
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS portal_assignment_submissions (
      assignment_id CHAR(36) NOT NULL,
      username VARCHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      note VARCHAR(1000) NOT NULL DEFAULT '',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (assignment_id, username),
      INDEX idx_submission_username (username)
    ) ENGINE=InnoDB
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS portal_assignment_files (
      assignment_id CHAR(36) NOT NULL,
      username VARCHAR(64) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_type VARCHAR(120) NOT NULL DEFAULT '',
      file_data MEDIUMTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (assignment_id, username)
    ) ENGINE=InnoDB
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS portal_results (
      id CHAR(36) PRIMARY KEY,
      student_username VARCHAR(64) NOT NULL,
      subject VARCHAR(100) NOT NULL,
      exam_name VARCHAR(120) NOT NULL,
      score DECIMAL(8,2) NOT NULL,
      max_score DECIMAL(8,2) NOT NULL,
      graded_by VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_result_student (student_username),
      INDEX idx_result_teacher (graded_by)
    ) ENGINE=InnoDB
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS portal_notices (
      id CHAR(36) PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      message VARCHAR(3000) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_notice_created (created_at)
    ) ENGINE=InnoDB
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS portal_event_notifications (
      event_id CHAR(36) NOT NULL,
      username VARCHAR(64) NOT NULL,
      title VARCHAR(160) NOT NULL,
      event_date DATE NOT NULL,
      event_time VARCHAR(10) NOT NULL,
      viewed_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, username),
      INDEX idx_event_notification_username (username)
    ) ENGINE=InnoDB
  `);

  const bootstrapUsername = process.env.BOOTSTRAP_TEACHER_USERNAME;
  const bootstrapPassword = process.env.BOOTSTRAP_TEACHER_PASSWORD;
  if (bootstrapUsername && bootstrapPassword && validUsername(bootstrapUsername) && bootstrapPassword.length >= 10 && bootstrapPassword.length <= 128) {
    const [existing] = await database.execute('SELECT username, portal_data FROM portal_users');
    const configuredAccount = existing.find(row => row.username === bootstrapUsername);
    if (!configuredAccount && !existing.some(row => {
      const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
      return data.bd_role === 'teacher';
    })) {
      const { salt, hash } = hashPassword(bootstrapPassword);
      await database.execute(
        'INSERT INTO portal_users (username, salt, password_hash, portal_data) VALUES (?, ?, ?, ?)',
        [bootstrapUsername, salt, hash, JSON.stringify(normalizePortalData({ bd_role: 'teacher', bd_display_name: 'Teacher Account' }))]
      );
      console.log(`Created bootstrap teacher account: ${bootstrapUsername}`);
    } else if (configuredAccount) {
      const data = normalizePortalData(typeof configuredAccount.portal_data === 'string'
        ? JSON.parse(configuredAccount.portal_data)
        : configuredAccount.portal_data);
      data.bd_role = 'teacher';
      await database.execute('UPDATE portal_users SET portal_data = ? WHERE username = ?', [JSON.stringify(data), bootstrapUsername]);
    }
  }

  if (!fs.existsSync(usersFile)) return;
  const legacyUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  if (!isRecord(legacyUsers)) throw new Error('Legacy account data must be a JSON object.');
  for (const [username, user] of Object.entries(legacyUsers)) {
    if (!isRecord(user) || typeof user.salt !== 'string' || typeof user.passwordHash !== 'string' || !validPortalData(user.data)) {
      throw new Error(`Legacy account data for "${username}" has an invalid format.`);
    }
    await database.execute(
      'INSERT IGNORE INTO portal_users (username, salt, password_hash, portal_data) VALUES (?, ?, ?, ?)',
      [username, user.salt, user.passwordHash, JSON.stringify(normalizePortalData(user.data))]
    );
  }
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(value));
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function cookieHeader(token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function getSessionToken(request) {
  const cookies = (request.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === sessionCookie) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return '';
}

async function getSessionUser(request) {
  const token = getSessionToken(request);
  const session = sessionStore.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessionStore.delete(token);
    return null;
  }
  const [rows] = await database.execute(
    'SELECT username, salt, password_hash, portal_data FROM portal_users WHERE username = ?',
    [session.username]
  );
  const user = rows[0];
  if (!user) return null;
  const data = normalizePortalData(typeof user.portal_data === 'string' ? JSON.parse(user.portal_data) : user.portal_data);
  return {
    username: user.username,
    salt: user.salt,
    passwordHash: user.password_hash,
    role: validRole(data.bd_role) ? data.bd_role : 'student',
    displayName: data.bd_display_name || '',
    rollNumber: data.bd_roll_number || '',
    email: data.bd_email || '',
    data
  };
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessionStore.set(token, { username, expiresAt: Date.now() + sessionLifetime });
  return token;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const actual = crypto.scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    throw error;
  }
}

function validRole(value) {
  return value === 'student' || value === 'teacher' || value === 'admin';
}

function validEmail(value) {
  return typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPortalData(value) {
  return isRecord(value) &&
    Array.isArray(value.bd_classes) &&
    isRecord(value.bd_attendance) &&
    Array.isArray(value.bd_tasks) &&
    isRecord(value.bd_student_names) &&
    (value.bd_teachers === undefined || Array.isArray(value.bd_teachers)) &&
    (value.bd_events === undefined || Array.isArray(value.bd_events));
}

function normalizePortalData(value) {
  return {
    ...defaultPortalData,
    ...value,
    bd_teachers: Array.isArray(value.bd_teachers) ? value.bd_teachers : [],
    bd_events: Array.isArray(value.bd_events) ? value.bd_events : []
  };
}

function normalizeRollNumber(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^\d+$/.test(raw)) return '';
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : '';
}

function mysqlDateValue(value) {
  if (!value) return null;
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function mysqlTimeValue(value) {
  if (!value) return null;
  if (!(value instanceof Date)) return String(value).slice(0, 5);
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

function getMailService() {
  const host = process.env.SMTP_HOST || '';
  const username = process.env.SMTP_USER || '';
  const password = process.env.SMTP_PASSWORD || '';
  if (!host || !username || !password) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('SMTP_PORT must be a valid TCP port.');
    error.status = 503;
    throw error;
  }
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  return {
    from: process.env.MAIL_FROM || username,
    transport: nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user: username, pass: password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    })
  };
}

async function studentRollExists(rollNumber) {
  const [rows] = await database.execute('SELECT portal_data FROM portal_users');
  return rows.some(row => {
    const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
    return data.bd_role === 'student' && normalizeRollNumber(data.bd_roll_number) === rollNumber;
  });
}

function sendStatic(request, response, filename) {
  const file = path.join(root, filename);
  const contentTypes = {
    'index.html': 'text/html; charset=utf-8',
    'script.js': 'text/javascript; charset=utf-8',
    'style.css': 'text/css; charset=utf-8'
  };
  response.writeHead(200, {
    'Content-Type': contentTypes[filename],
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self';"
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(file).pipe(response);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/register-teacher' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const body = await readJson(request);
    if (!isRecord(body)) return sendJson(response, 400, { error: 'Enter valid teacher account details.' });
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 100) : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 100) : '';
    if (!/^[A-Za-z][A-Za-z0-9._-]{2,63}$/.test(username) ||
      typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128 ||
      !displayName || (email && !validEmail(email))) {
      return sendJson(response, 400, { error: 'Enter a name, valid teacher username, password, and optional valid email.' });
    }
    const { salt, hash } = hashPassword(body.password);
    try {
      await database.execute(
        'INSERT INTO portal_users (username, salt, password_hash, portal_data) VALUES (?, ?, ?, ?)',
        [username, salt, hash, JSON.stringify(normalizePortalData({
          bd_role: 'teacher',
          bd_display_name: displayName,
          bd_email: email,
          bd_subject: subject
        }))]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return sendJson(response, 409, { error: 'This username is already in use.' });
      }
      throw error;
    }
    const token = createSession(username);
    return sendJson(response, 201, { authenticated: true }, { 'Set-Cookie': cookieHeader(token, sessionLifetime / 1000) });
  }

  if (url.pathname === '/api/register' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128) {
      return sendJson(response, 400, { error: 'Enter a valid student password.' });
    }
    if (body.data !== undefined && !validPortalData(body.data)) {
      return sendJson(response, 400, { error: 'Existing portal data has an invalid format.' });
    }
    const role = validRole(body.role) ? body.role : 'student';
    if (role !== 'student') {
      return sendJson(response, 403, { error: 'Only student accounts can be registered from this screen.' });
    }
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 100) : '';
    const rollNumber = normalizeRollNumber(body.rollNumber);
    const username = rollNumber;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!displayName || !rollNumber || !validEmail(email)) {
      return sendJson(response, 400, { error: 'Enter the student name, roll number, and a valid email address.' });
    }
    if (await studentRollExists(rollNumber)) {
      return sendJson(response, 409, { error: 'A student account already uses this roll number.' });
    }
    const { salt, hash } = hashPassword(body.password);
    try {
      await database.execute(
        'INSERT INTO portal_users (username, salt, password_hash, portal_data) VALUES (?, ?, ?, ?)',
        [username, salt, hash, JSON.stringify(normalizePortalData({
          ...(body.data || {}),
          bd_role: role,
          bd_display_name: displayName,
          bd_roll_number: rollNumber,
          bd_email: email
        }))]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return sendJson(response, 409, { error: 'An account with this username already exists.' });
      }
      throw error;
    }
    const token = createSession(username);
    return sendJson(response, 201, { authenticated: true }, { 'Set-Cookie': cookieHeader(token, sessionLifetime / 1000) });
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const body = await readJson(request);
    const username = isRecord(body) && typeof body.username === 'string' ? body.username.trim() : '';
    const requestedRole = isRecord(body) && (body.role === 'student' || body.role === 'teacher') ? body.role : null;
    let user = null;
    if (validUsername(username)) {
      if (/^\d+$/.test(username)) {
        const [rows] = await database.execute(
          'SELECT username, salt, password_hash, portal_data FROM portal_users'
        );
        const matched = rows.find(row => {
          const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
          return data.bd_role === 'student' && normalizeRollNumber(data.bd_roll_number) === username;
        });
        if (matched) {
          user = { username: matched.username, salt: matched.salt, password_hash: matched.password_hash, role: 'student' };
        }
      } else {
        const [rows] = await database.execute(
          'SELECT username, salt, password_hash, portal_data FROM portal_users WHERE username = ?',
          [username]
        );
        if (rows[0]) {
          const data = normalizePortalData(typeof rows[0].portal_data === 'string' ? JSON.parse(rows[0].portal_data) : rows[0].portal_data);
          user = { ...rows[0], role: data.bd_role };
        }
      }
    }
    if (!user || (requestedRole && user.role !== requestedRole) || !isRecord(body) || typeof body.password !== 'string' ||
      !verifyPassword(body.password, { salt: user.salt, passwordHash: user.password_hash })) {
      return sendJson(response, 401, { error: 'Invalid username or password.' });
    }
    const sessionUsername = user && user.username ? user.username : username;
    const token = createSession(sessionUsername);
    return sendJson(response, 200, { authenticated: true }, { 'Set-Cookie': cookieHeader(token, sessionLifetime / 1000) });
  }

  if (url.pathname === '/api/session' && request.method === 'GET') {
    const user = await getSessionUser(request);
    return sendJson(response, 200, {
      authenticated: !!user,
      username: user ? user.username : '',
      role: user ? user.role : '',
      displayName: user ? user.displayName : '',
      rollNumber: user ? user.rollNumber : '',
      email: user ? user.email : ''
    });
  }

  if (url.pathname === '/api/account' && request.method === 'PUT') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to update your account.' });
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.currentPassword !== 'string' ||
      !verifyPassword(body.currentPassword, { salt: user.salt, passwordHash: user.passwordHash })) {
      return sendJson(response, 401, { error: 'Enter your current password to confirm these changes.' });
    }

    const username = typeof body.username === 'string' && body.username.trim()
      ? body.username.trim()
      : user.username;
    const password = typeof body.password === 'string' ? body.password : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : user.email;
    if (user.role === 'student') {
      if (username !== user.username) {
        return sendJson(response, 400, { error: 'Student login ID must remain your roll number.' });
      }
    }
    const validLoginId = validUsername(username);
    if (!validLoginId) {
      return sendJson(response, 400, {
        error: user.role === 'student'
          ? 'Use an international phone number with +country code for a new student login.'
          : 'Username must be 3–64 letters, numbers, dots, underscores, or hyphens.'
      });
    }
    if (password && (password.length < 1 || password.length > 128)) {
      return sendJson(response, 400, { error: 'New password must be 1–128 characters.' });
    }
    if (email && !validEmail(email)) {
      return sendJson(response, 400, { error: 'Enter a valid email address.' });
    }
    if (username === user.username && !password && email === user.email) {
      return sendJson(response, 400, { error: 'Enter a new username, password, or email address.' });
    }

    const passwordHash = password ? hashPassword(password) : null;
    const updatedData = { ...user.data, bd_email: email };
    const connection = await database.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'UPDATE portal_users SET username = ?, salt = ?, password_hash = ?, portal_data = ? WHERE username = ?',
        [username, passwordHash ? passwordHash.salt : user.salt,
         passwordHash ? passwordHash.hash : user.passwordHash, JSON.stringify(updatedData), user.username]
      );
      if (username !== user.username) {
        await connection.execute('UPDATE portal_assignments SET assigned_by = ? WHERE assigned_by = ?', [username, user.username]);
        await connection.execute('UPDATE portal_results SET student_username = ? WHERE BINARY student_username = BINARY ?', [username, user.username]);
        await connection.execute('UPDATE portal_results SET graded_by = ? WHERE BINARY graded_by = BINARY ?', [username, user.username]);
        await connection.execute('UPDATE portal_notices SET created_by = ? WHERE BINARY created_by = BINARY ?', [username, user.username]);
        const [assignmentRows] = await connection.execute('SELECT id, recipients FROM portal_assignments');
        for (const assignment of assignmentRows) {
          const recipients = typeof assignment.recipients === 'string'
            ? JSON.parse(assignment.recipients)
            : assignment.recipients;
          if (Array.isArray(recipients) && recipients.includes(user.username)) {
            await connection.execute(
              'UPDATE portal_assignments SET recipients = ? WHERE id = ?',
              [JSON.stringify(recipients.map(recipient => recipient === user.username ? username : recipient)), assignment.id]
            );
          }
        }
        await connection.execute(
          'UPDATE portal_assignment_submissions SET username = ? WHERE username = ?',
          [username, user.username]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return sendJson(response, 409, { error: 'That username is already in use.' });
      }
      throw error;
    } finally {
      connection.release();
    }
    const session = sessionStore.get(getSessionToken(request));
    if (session) session.username = username;
    return sendJson(response, 200, { updated: true, username, email });
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    sessionStore.delete(getSessionToken(request));
    return sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': cookieHeader('', 0) });
  }

  if (url.pathname === '/api/data' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to access your portal data.' });
    return sendJson(response, 200, user.data);
  }

  if (url.pathname === '/api/data' && request.method === 'PUT') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to save your portal data.' });
    const data = await readJson(request);
    if (!validPortalData(data)) return sendJson(response, 400, { error: 'Portal data has an invalid format.' });
    if (user.role === 'student' &&
      JSON.stringify(normalizePortalData(data).bd_attendance) !== JSON.stringify(normalizePortalData(user.data).bd_attendance)) {
      return sendJson(response, 403, { error: 'Students cannot mark or change attendance.' });
    }
    await database.execute(
      'UPDATE portal_users SET portal_data = ? WHERE username = ?',
      [JSON.stringify(normalizePortalData(data)), user.username]
    );
    return sendJson(response, 200, { saved: true });
  }

  if (url.pathname === '/api/students' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to access student accounts.' });
    if (user.role === 'student') return sendJson(response, 403, { error: 'Students cannot view the full student directory.' });
    const [rows] = await database.execute(
      'SELECT username, portal_data, updated_at FROM portal_users'
    );
    return sendJson(response, 200, rows.map(row => {
      const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
      return {
        username: row.username,
        displayName: data.bd_display_name || '',
        rollNumber: data.bd_roll_number || '',
        role: data.bd_role || 'student',
        updatedAt: row.updated_at
      };
    }).filter(student => student.role === 'student')
      .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber) || a.username.localeCompare(b.username)));
  }

  if (url.pathname === '/api/teachers' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to view the teacher directory.' });
    const [rows] = await database.execute('SELECT portal_data FROM portal_users');
    const accounts = rows.map(row =>
      normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data)
    ).filter(data => data.bd_role === 'teacher').map(data => ({
      displayName: data.bd_display_name || '',
      subject: data.bd_subject || ''
    }));
    return sendJson(response, 200, accounts);
  }

  if (url.pathname === '/api/events' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to view events.' });
    const [rows] = await database.execute('SELECT username, portal_data FROM portal_users');
    const eventsById = new Map();
    const viewedEventIds = [];
    const accountRows = rows.map(row => ({
      username: row.username,
      data: normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data)
    }));
    rows.forEach(row => {
      const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
      if (data.bd_role !== 'teacher') return;
      data.bd_events.forEach(event => {
        if (!isRecord(event) || typeof event.id !== 'string') return;
        const recipients = Array.isArray(event.recipients) ? event.recipients : [];
        if (user.role === 'student' && !recipients.includes(user.username)) return;
        if (user.role === 'student') {
          event.viewedBy = Array.isArray(event.viewedBy) ? event.viewedBy : [];
          if (!event.viewedBy.includes(user.username)) event.viewedBy.push(user.username);
          viewedEventIds.push(event.id);
        }
        const recipientDetails = recipients.map(username => {
          const account = accountRows.find(item => item.username === username);
          const rollNumber = account ? normalizeRollNumber(account.data.bd_roll_number) : '';
          return {
            username,
            rollNumber,
            viewed: Array.isArray(event.viewedBy) && event.viewedBy.includes(username)
          };
        });
        eventsById.set(event.id, { ...event, recipientDetails });
      });
    });
    if (user.role === 'student') {
      for (const row of rows) {
        const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
        if (data.bd_role !== 'teacher') continue;
        let changed = false;
        data.bd_events = (data.bd_events || []).map(event => {
          if (!Array.isArray(event.recipients) || !event.recipients.includes(user.username)) return event;
          const viewedBy = Array.isArray(event.viewedBy) ? event.viewedBy : [];
          if (viewedBy.includes(user.username)) return event;
          changed = true;
          return { ...event, viewedBy: [...viewedBy, user.username] };
        });
        if (changed) {
          await database.execute(
            'UPDATE portal_users SET portal_data = ? WHERE username = ?',
            [JSON.stringify(data), row.username]
          );
        }
      }
    }
    if (user.role === 'student' && viewedEventIds.length) {
      const placeholders = viewedEventIds.map(() => '?').join(', ');
      await database.execute(
        `UPDATE portal_event_notifications SET viewed_at = COALESCE(viewed_at, CURRENT_TIMESTAMP)
         WHERE username = ? AND event_id IN (${placeholders})`,
        [user.username, ...viewedEventIds]
      );
    }
    const eventValues = [...eventsById.values()];
    const eventIds = eventValues.map(event => event.id);
    const statusByEvent = new Map();
    if (eventIds.length) {
      const statusPlaceholders = eventIds.map(() => '?').join(', ');
      const [statusRows] = await database.execute(
        `SELECT event_id, username, status, penalty FROM portal_event_status
         WHERE event_id IN (${statusPlaceholders})`,
        eventIds
      );
      statusRows.forEach(row => {
        if (!statusByEvent.has(row.event_id)) statusByEvent.set(row.event_id, new Map());
        statusByEvent.get(row.event_id).set(row.username, row);
      });
    }
    return sendJson(response, 200, eventValues.map(event => {
      const statuses = statusByEvent.get(event.id);
      if (user.role === 'student') {
        const ownStatus = statuses ? statuses.get(user.username) : null;
        return { ...event, status: ownStatus ? ownStatus.status : 'pending', penalty: ownStatus ? ownStatus.penalty : '' };
      }
      return {
        ...event,
        recipientDetails: (event.recipientDetails || []).map(recipient => {
          const row = statuses ? statuses.get(recipient.username) : null;
          return { ...recipient, status: row ? row.status : 'pending', penalty: row ? row.penalty : '' };
        })
      };
    }));
  }

  if (url.pathname === '/api/events' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user || user.role !== 'teacher') return sendJson(response, 403, { error: 'Only teachers can add events.' });
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.title !== 'string' || !body.title.trim() ||
      typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) ||
      typeof body.time !== 'string' || !body.time.trim()) {
      return sendJson(response, 400, { error: 'Enter an event title, date, and time.' });
    }
    if (isDeadlinePassed(body.date, body.time)) {
      return sendJson(response, 400, { error: 'Event date and time must be in the future.' });
    }
    if (!Array.isArray(body.recipients) || body.recipients.length === 0 ||
      body.recipients.some(username => typeof username !== 'string')) {
      return sendJson(response, 400, { error: 'Select at least one student.' });
    }
    const placeholders = [...new Set(body.recipients)].map(() => '?').join(', ');
    const [studentRows] = await database.execute(
      `SELECT username, portal_data FROM portal_users WHERE username IN (${placeholders})`,
      [...new Set(body.recipients)]
    );
    const recipients = studentRows.filter(row => {
      const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
      return data.bd_role === 'student';
    }).map(row => row.username);
    if (recipients.length !== new Set(body.recipients).size) {
      return sendJson(response, 400, { error: 'Events can only be assigned to existing student accounts.' });
    }
    const event = {
      id: crypto.randomUUID(),
      title: body.title.trim().slice(0, 120),
      date: body.date,
      time: body.time.trim().slice(0, 10),
      audience: typeof body.audience === 'string' ? body.audience.trim().slice(0, 100) : '',
      description: typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '',
      recipients,
      viewedBy: []
    };
    const updatedData = { ...user.data, bd_events: [...(user.data.bd_events || []), event] };
    await database.execute(
      'UPDATE portal_users SET portal_data = ? WHERE username = ?',
      [JSON.stringify(normalizePortalData(updatedData)), user.username]
    );
    for (const username of recipients) {
      await database.execute(
        `INSERT INTO portal_event_notifications (event_id, username, title, event_date, event_time)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), event_date = VALUES(event_date), event_time = VALUES(event_time), viewed_at = NULL`,
        [event.id, username, event.title, event.date, event.time]
      );
    }
    return sendJson(response, 201, event);
  }

  if (url.pathname.startsWith('/api/events/') && url.pathname.endsWith('/status') && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user || user.role !== 'student') return sendJson(response, 403, { error: 'Only students can update event completion.' });
    const eventId = url.pathname.slice('/api/events/'.length, -'/status'.length);
    const body = await readJson(request);
    if (!isRecord(body) || !['completed', 'incomplete'].includes(body.status)) {
      return sendJson(response, 400, { error: 'Choose completed or incomplete.' });
    }
    const [rows] = await database.execute('SELECT portal_data FROM portal_users');
    let recipient = false;
    rows.forEach(row => {
      const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
      if (data.bd_role !== 'teacher') return;
      recipient = recipient || data.bd_events.some(event =>
        event.id === eventId && Array.isArray(event.recipients) && event.recipients.includes(user.username));
    });
    if (!recipient) return sendJson(response, 403, { error: 'This event was not assigned to you.' });
    const status = body.status;
    const penalty = status === 'incomplete' ? 'Penalty will be applied.' : '';
    await database.execute(
      `INSERT INTO portal_event_status (event_id, username, status, penalty)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), penalty = VALUES(penalty)`,
      [eventId, user.username, status, penalty]
    );
    return sendJson(response, 200, {
      status,
      message: status === 'completed' ? 'Successfully you completed.' : 'Penalty will be applied.'
    });
  }

  if (url.pathname === '/api/events' && request.method === 'DELETE') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user || user.role !== 'teacher') return sendJson(response, 403, { error: 'Only teachers can delete events.' });
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.id !== 'string') return sendJson(response, 400, { error: 'Event ID is required.' });
    const updatedData = { ...user.data, bd_events: (user.data.bd_events || []).filter(event => event.id !== body.id) };
    await database.execute(
      'UPDATE portal_users SET portal_data = ? WHERE username = ?',
      [JSON.stringify(normalizePortalData(updatedData)), user.username]
    );
    return sendJson(response, 200, { deleted: true });
  }

  if (url.pathname === '/api/attendance' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to view attendance.' });
    if (user.role !== 'student') return sendJson(response, 403, { error: 'This attendance view is for student accounts.' });
    const rollNumber = normalizeRollNumber(user.rollNumber);
    if (!rollNumber) return sendJson(response, 400, { error: 'Your account does not have a valid roll number.' });
    const [teacherRows] = await database.execute(
      'SELECT portal_data FROM portal_users ORDER BY updated_at DESC'
    );
    const attendanceByDate = new Map();
    teacherRows.forEach(row => {
      const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
      if (data.bd_role !== 'teacher' || !isRecord(data.bd_attendance)) return;
      const attendanceEntries = Object.entries(data.bd_attendance);
      const hasDateBuckets = attendanceEntries.some(([date, attendance]) =>
        /^\d{4}-\d{2}-\d{2}$/.test(date) && isRecord(attendance));
      if (!hasDateBuckets && Object.prototype.hasOwnProperty.call(data.bd_attendance, rollNumber)) {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        if (!attendanceByDate.has(today)) {
          attendanceByDate.set(today, { date: today, present: Boolean(data.bd_attendance[rollNumber]) });
        }
        return;
      }
      attendanceEntries.forEach(([date, attendance]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(attendance) ||
          !Object.prototype.hasOwnProperty.call(attendance, rollNumber) || attendanceByDate.has(date)) return;
        attendanceByDate.set(date, {
          date,
          present: Boolean(attendance[rollNumber])
        });
      });
    });
    return sendJson(response, 200, [...attendanceByDate.values()].sort((first, second) => second.date.localeCompare(first.date)));
  }

  if (url.pathname === '/api/results' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to view exam results.' });
    const [rows] = user.role === 'student'
      ? await database.execute(
        'SELECT id, student_username, subject, exam_name, score, max_score, graded_by, created_at FROM portal_results WHERE BINARY student_username = BINARY ? ORDER BY created_at DESC',
        [user.username]
      )
      : await database.execute(
        'SELECT id, student_username, subject, exam_name, score, max_score, graded_by, created_at FROM portal_results ORDER BY created_at DESC'
      );
    return sendJson(response, 200, rows.map(row => ({
      id: row.id,
      studentUsername: row.student_username,
      subject: row.subject,
      examName: row.exam_name,
      score: Number(row.score),
      maxScore: Number(row.max_score),
      gradedBy: row.graded_by,
      createdAt: row.created_at
    })));
  }

  if (url.pathname === '/api/results' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user || user.role !== 'teacher') return sendJson(response, 403, { error: 'Only teachers can record exam results.' });
    const body = await readJson(request);
    if (!isRecord(body)) return sendJson(response, 400, { error: 'Enter valid exam result details.' });
    const studentUsername = typeof body.studentUsername === 'string' ? body.studentUsername.trim() : '';
    const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 100) : '';
    const examName = typeof body.examName === 'string' ? body.examName.trim().slice(0, 120) : '';
    const score = typeof body.score === 'number' || (typeof body.score === 'string' && body.score.trim())
      ? Number(body.score)
      : NaN;
    const maxScore = typeof body.maxScore === 'number' || (typeof body.maxScore === 'string' && body.maxScore.trim())
      ? Number(body.maxScore)
      : NaN;
    if (!validUsername(studentUsername) || !subject || !examName ||
      !Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0 ||
      score < 0 || score > maxScore || maxScore > 100000) {
      return sendJson(response, 400, { error: 'Enter a student, subject, exam name, and valid score.' });
    }
    const storedScore = Number.isFinite(score) ? Number(score.toFixed(2)) : NaN;
    const storedMaxScore = Number.isFinite(maxScore) ? Number(maxScore.toFixed(2)) : NaN;
    if (storedMaxScore <= 0 || storedScore > storedMaxScore) {
      return sendJson(response, 400, { error: 'Enter a student, subject, exam name, and valid score.' });
    }
    const [studentRows] = await database.execute(
      'SELECT portal_data FROM portal_users WHERE username = ?',
      [studentUsername]
    );
    const studentData = studentRows[0]
      ? normalizePortalData(typeof studentRows[0].portal_data === 'string' ? JSON.parse(studentRows[0].portal_data) : studentRows[0].portal_data)
      : null;
    if (!studentData || studentData.bd_role !== 'student') {
      return sendJson(response, 400, { error: 'Choose an existing student account.' });
    }
    const id = crypto.randomUUID();
    await database.execute(
      'INSERT INTO portal_results (id, student_username, subject, exam_name, score, max_score, graded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, studentUsername, subject, examName, storedScore.toFixed(2), storedMaxScore.toFixed(2), user.username]
    );
    return sendJson(response, 201, { id });
  }

  if (url.pathname === '/api/notices' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to view school notices.' });
    const [rows] = await database.execute(
      'SELECT id, title, message, created_by, created_at FROM portal_notices ORDER BY created_at DESC LIMIT 100'
    );
    return sendJson(response, 200, rows.map(row => ({
      id: row.id,
      title: row.title,
      message: row.message,
      createdBy: row.created_by,
      createdAt: row.created_at
    })));
  }

  if (url.pathname === '/api/event-notifications' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to view notifications.' });
    if (user.role !== 'student') return sendJson(response, 200, []);
    const [rows] = await database.execute(
      'SELECT event_id, title, event_date, event_time, viewed_at, created_at FROM portal_event_notifications WHERE username = ? ORDER BY created_at DESC',
      [user.username]
    );
    return sendJson(response, 200, rows.map(row => ({
      eventId: row.event_id,
      title: row.title,
      date: mysqlDateValue(row.event_date),
      time: row.event_time,
      viewed: !!row.viewed_at,
      createdAt: row.created_at
    })));
  }

  if (url.pathname === '/api/event-notifications/read' && request.method === 'POST') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to update notifications.' });
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const body = await readJson(request);
    if (isRecord(body) && typeof body.eventId === 'string') {
      await database.execute(
        'UPDATE portal_event_notifications SET viewed_at = COALESCE(viewed_at, CURRENT_TIMESTAMP) WHERE event_id = ? AND username = ?',
        [body.eventId, user.username]
      );
    }
    return sendJson(response, 200, { read: true });
  }

  if (url.pathname === '/api/notices' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user || user.role !== 'teacher') return sendJson(response, 403, { error: 'Only teachers can publish school notices.' });
    const body = await readJson(request);
    const title = isRecord(body) && typeof body.title === 'string' ? body.title.trim().slice(0, 160) : '';
    const message = isRecord(body) && typeof body.message === 'string' ? body.message.trim().slice(0, 3000) : '';
    if (!title || !message) return sendJson(response, 400, { error: 'Enter a notice title and message.' });
    const id = crypto.randomUUID();
    await database.execute(
      'INSERT INTO portal_notices (id, title, message, created_by) VALUES (?, ?, ?, ?)',
      [id, title, message, user.username]
    );
    return sendJson(response, 201, { id });
  }

  if (url.pathname === '/api/accounts' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user || user.role !== 'teacher') return sendJson(response, 403, { error: 'Only teachers can create login accounts.' });
    const body = await readJson(request);
    const role = validRole(body.role) && body.role !== 'admin' ? body.role : 'student';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 100) : '';
    const rollNumber = role === 'student' ? normalizeRollNumber(body.rollNumber) : '';
    const subject = role === 'teacher' && typeof body.subject === 'string' ? body.subject.trim().slice(0, 100) : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isRecord(body) || typeof body.password !== 'string') {
      return sendJson(response, 400, { error: 'Enter valid account details.' });
    }
    if (role === 'student' && (!rollNumber || body.username !== rollNumber || body.password.length < 1 || body.password.length > 128)) {
      return sendJson(response, 400, { error: 'Student username must be the roll number and password is required.' });
    }
    if (role !== 'student' && (!validUsername(body.username) || body.password.length < 10 || body.password.length > 128)) {
      return sendJson(response, 400, { error: 'Enter a valid username and password of at least 10 characters.' });
    }
    if (!displayName || (role === 'student' && (!rollNumber || !validEmail(email))) ||
      (email && !validEmail(email))) {
      return sendJson(response, 400, { error: 'Enter the account holder name and valid student roll number/email.' });
    }
    if (role === 'student' && await studentRollExists(rollNumber)) {
      return sendJson(response, 409, { error: 'A student account already uses this roll number.' });
    }
    const { salt, hash } = hashPassword(body.password);
    try {
      await database.execute(
        'INSERT INTO portal_users (username, salt, password_hash, portal_data) VALUES (?, ?, ?, ?)',
        [body.username.trim(), salt, hash, JSON.stringify(normalizePortalData({
          bd_role: role,
          bd_display_name: displayName,
          bd_roll_number: rollNumber,
          bd_email: email,
          bd_subject: subject
        }))]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return sendJson(response, 409, { error: 'This username already exists.' });
      throw error;
    }
    return sendJson(response, 201, { username: body.username.trim(), role, displayName, rollNumber, subject });
  }

  if (url.pathname === '/api/assignments' && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to view assignments.' });
    let rows;
    if (user.role === 'student') {
      [rows] = await database.execute(
        `SELECT a.*, s.status AS submission_status, s.note AS submission_note,
                f.file_name AS submission_file_name, f.file_type AS submission_file_type
         FROM portal_assignments a
         LEFT JOIN portal_assignment_submissions s ON s.assignment_id = a.id AND s.username = ?
         LEFT JOIN portal_assignment_files f ON f.assignment_id = a.id AND f.username = ?
         WHERE JSON_CONTAINS(a.recipients, JSON_QUOTE(?))
         ORDER BY (a.due_date IS NULL), a.due_date, a.due_time, a.created_at DESC`,
        [user.username, user.username, user.username]
      );
    } else {
      [rows] = await database.execute(
        'SELECT * FROM portal_assignments WHERE assigned_by = ? ORDER BY created_at DESC',
        [user.username]
      );
      const [submissionRows] = await database.execute(
        `SELECT s.assignment_id, s.username, s.status, f.file_name, s.updated_at
         FROM portal_assignment_submissions s
         INNER JOIN portal_assignments a ON a.id = s.assignment_id
         LEFT JOIN portal_assignment_files f ON f.assignment_id = s.assignment_id AND f.username = s.username
         WHERE a.assigned_by = ?`,
        [user.username]
      );
      const [accountRows] = await database.execute('SELECT username, portal_data FROM portal_users');
      const accountByUsername = new Map(accountRows.map(account => {
        const data = normalizePortalData(typeof account.portal_data === 'string' ? JSON.parse(account.portal_data) : account.portal_data);
        return [account.username, {
          displayName: data.bd_display_name || account.username,
          rollNumber: data.bd_roll_number || ''
        }];
      }));
      const submissionsByAssignment = new Map();
      submissionRows.forEach(submission => {
        if (!submissionsByAssignment.has(submission.assignment_id)) {
          submissionsByAssignment.set(submission.assignment_id, new Map());
        }
        submissionsByAssignment.get(submission.assignment_id).set(submission.username, submission);
      });
      rows.forEach(row => {
        const recipients = typeof row.recipients === 'string' ? JSON.parse(row.recipients) : row.recipients;
        const submissionMap = submissionsByAssignment.get(row.id) || new Map();
        row.recipientDetails = recipients.map(username => {
          const account = accountByUsername.get(username);
          const submission = submissionMap.get(username);
          return {
            username,
            displayName: account ? account.displayName : username,
            rollNumber: account ? account.rollNumber : '',
            status: submission ? submission.status : 'pending',
            fileName: submission ? submission.file_name : '',
            updatedAt: submission ? submission.updated_at : null
          };
        });
      });
    }
    return sendJson(response, 200, rows.map(row => ({
      id: row.id,
      title: row.title,
      details: row.details,
      subject: row.subject,
      dueDate: mysqlDateValue(row.due_date),
      dueTime: mysqlTimeValue(row.due_time),
      deadlinePassed: isDeadlinePassed(mysqlDateValue(row.due_date), mysqlTimeValue(row.due_time)),
      assignedBy: row.assigned_by,
      recipients: typeof row.recipients === 'string' ? JSON.parse(row.recipients) : row.recipients,
      submissionStatus: row.submission_status || 'pending',
      submissionNote: row.submission_note || '',
      submissionFileName: row.submission_file_name || '',
      submissionFileType: row.submission_file_type || '',
      recipientDetails: row.recipientDetails || [],
      submittedCount: row.recipientDetails ? row.recipientDetails.filter(recipient => recipient.status === 'submitted').length : 0,
      createdAt: row.created_at
    })));
  }

  if (url.pathname === '/api/assignments' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user || user.role === 'student') return sendJson(response, 403, { error: 'Only teachers can assign work.' });
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.title !== 'string' || !body.title.trim()) {
      return sendJson(response, 400, { error: 'Assignment title is required.' });
    }
    const dueDate = body.dueDate === undefined || body.dueDate === null || body.dueDate === '' ? null : body.dueDate;
    const dueTime = body.dueTime === undefined || body.dueTime === null || body.dueTime === '' ? null : body.dueTime;
    if ((dueDate !== null && !isValidDueDate(dueDate)) ||
      (dueTime !== null && (!isValidDueTime(dueTime) || dueDate === null))) {
      return sendJson(response, 400, { error: 'Enter a valid due date and, optionally, a due time.' });
    }
    if (isDeadlinePassed(dueDate, dueTime)) {
      return sendJson(response, 400, { error: 'Assignment deadline must be in the future.' });
    }
    if (!Array.isArray(body.recipients) || body.recipients.length === 0 ||
      body.recipients.some(username => typeof username !== 'string')) {
      return sendJson(response, 400, { error: 'Select at least one student.' });
    }
    const recipients = [...new Set(body.recipients)];
    const placeholders = recipients.map(() => '?').join(', ');
    const [recipientRows] = await database.execute(
      `SELECT username, portal_data FROM portal_users WHERE username IN (${placeholders})`,
      recipients
    );
    const validStudentUsernames = new Set(recipientRows.filter(row => {
      const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
      return data.bd_role === 'student';
    }).map(row => row.username));
    if (validStudentUsernames.size !== recipients.length) {
      return sendJson(response, 400, { error: 'Assignments can only be sent to existing student accounts.' });
    }
    const selectedStudents = recipientRows.map(row => {
      const data = normalizePortalData(typeof row.portal_data === 'string' ? JSON.parse(row.portal_data) : row.portal_data);
      return {
        username: row.username,
        name: data.bd_display_name || row.username,
        email: typeof data.bd_email === 'string' ? data.bd_email : ''
      };
    });
    if (selectedStudents.some(student => !validEmail(student.email))) {
      return sendJson(response, 400, { error: 'Add a valid email address to every selected student account before assigning work.' });
    }
    let mailService;
    try {
      mailService = getMailService();
    } catch (error) {
      return sendJson(response, error.status || 503, { error: error.message });
    }
    if (!mailService) {
      return sendJson(response, 503, { error: 'Assignment email is not configured. Set SMTP settings in .env and restart the portal.' });
    }
    try {
      await mailService.transport.verify();
    } catch (error) {
      console.error('Assignment email server check failed:', error.code || error.name);
      return sendJson(response, 503, { error: 'Cannot connect to the email server. Check SMTP settings; the assignment was not saved.' });
    }
    const id = crypto.randomUUID();
    const title = body.title.trim().slice(0, 160);
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 1000) : '';
    const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 100) : '';
    await database.execute(
      'INSERT INTO portal_assignments (id, title, details, subject, due_date, due_time, assigned_by, recipients) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, title, details, subject, dueDate, dueTime, user.username, JSON.stringify(recipients)]
    );
    const emailSubject = `New assignment: ${title.replace(/[\r\n]/g, ' ')}`;
    const emailFailures = [];
    for (let index = 0; index < selectedStudents.length; index += 10) {
      const batch = selectedStudents.slice(index, index + 10);
      const results = await Promise.allSettled(batch.map(student => {
        const lines = [
          `Hello ${student.name},`,
          '',
          `${user.displayName || user.username} assigned you new work.`,
          `Assignment: ${title}`,
          subject ? `Subject: ${subject}` : '',
          dueDate ? `Due: ${dueDate}${dueTime ? ` at ${dueTime}` : ''}` : '',
          details ? `Instructions: ${details}` : '',
          '',
          'Sign in to BrightDesk to view the assignment and mark it submitted.'
        ].filter(Boolean);
        return mailService.transport.sendMail({
          from: mailService.from,
          to: student.email,
          subject: emailSubject,
          text: lines.join('\n')
        });
      }));
      results.forEach((result, batchIndex) => {
        if (result.status === 'rejected') emailFailures.push(batch[index + batchIndex].username);
      });
    }
    if (emailFailures.length) {
      console.error(`Assignment ${id}: email delivery failed for ${emailFailures.length} recipient(s).`);
      return sendJson(response, 201, {
        id,
        emailSent: false,
        warning: `Assignment saved, but email delivery failed for ${emailFailures.length} selected student(s). Check SMTP settings and contact them directly if needed.`
      });
    }
    return sendJson(response, 201, { id, emailSent: true, emailCount: selectedStudents.length });
  }

  if (url.pathname.startsWith('/api/assignments/') && url.pathname.endsWith('/file') && request.method === 'GET') {
    const user = await getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to download assignment files.' });
    const assignmentId = url.pathname.slice('/api/assignments/'.length, -'/file'.length);
    const [rows] = await database.execute(
      'SELECT file_name, file_type, file_data FROM portal_assignment_files WHERE assignment_id = ? AND username = ?',
      [assignmentId, user.username]
    );
    if (!rows.length || !rows[0].file_data) return sendJson(response, 404, { error: 'Submission file not found.' });
    const match = /^data:([^;]+);base64,(.*)$/.exec(rows[0].file_data);
    if (!match) return sendJson(response, 404, { error: 'Submission file is unavailable.' });
    const fileBuffer = Buffer.from(match[2], 'base64');
    response.writeHead(200, {
      'Content-Type': rows[0].file_type || match[1] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${String(rows[0].file_name).replace(/[\r\n"]/g, '_')}"`
    });
    response.end(fileBuffer);
    return;
  }

  if (url.pathname.startsWith('/api/assignments/') && request.method === 'PUT') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = await getSessionUser(request);
    if (!user || user.role !== 'student') return sendJson(response, 403, { error: 'Only students can update assignment status.' });
    const assignmentId = url.pathname.slice('/api/assignments/'.length);
    const body = await readJson(request);
    if (!isRecord(body)) return sendJson(response, 400, { error: 'Invalid assignment submission.' });
    const status = body.status === 'submitted' ? 'submitted' : 'pending';
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim().slice(0, 255) : '';
    const fileType = typeof body.fileType === 'string' ? body.fileType.trim().slice(0, 120) : '';
    const fileData = typeof body.fileData === 'string' ? body.fileData : '';
    if (status === 'submitted' && (!fileName || !fileData)) {
      return sendJson(response, 400, { error: 'Upload a file before submitting the assignment.' });
    }
    if (fileData && fileData.length > 7 * 1024 * 1024) {
      return sendJson(response, 413, { error: 'The assignment file must be 5 MB or smaller.' });
    }
    const [recipient] = await database.execute(
      'SELECT id, recipients, due_date, due_time FROM portal_assignments WHERE id = ?',
      [assignmentId]
    );
    if (!recipient.length) return sendJson(response, 404, { error: 'Assignment not found.' });
    const recipients = typeof recipient[0].recipients === 'string'
      ? JSON.parse(recipient[0].recipients)
      : recipient[0].recipients;
    if (!recipients.includes(user.username)) return sendJson(response, 403, { error: 'This assignment was not assigned to you.' });
    if (isDeadlinePassed(mysqlDateValue(recipient[0].due_date), mysqlTimeValue(recipient[0].due_time))) {
      const [previous] = await database.execute(
        'SELECT status FROM portal_assignment_submissions WHERE assignment_id = ? AND username = ?',
        [assignmentId, user.username]
      );
      if (previous.length && previous[0].status === status && ['submitted', 'completed'].includes(status)) {
        return sendJson(response, 200, { saved: true });
      }
      return sendJson(response, 403, { error: 'The submission deadline has passed. This assignment can no longer be submitted.' });
    }
    await database.execute(
      `INSERT INTO portal_assignment_submissions (assignment_id, username, status, note)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note)`,
      [assignmentId, user.username, status,
       typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '']
    );
    if (status === 'submitted' && fileName && fileData) {
      await database.execute(
        `INSERT INTO portal_assignment_files (assignment_id, username, file_name, file_type, file_data)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE file_name = VALUES(file_name),
           file_type = VALUES(file_type), file_data = VALUES(file_data)`,
        [assignmentId, user.username, fileName, fileType, fileData]
      );
    }
    return sendJson(response, 200, { saved: true });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const filename = url.pathname === '/' || url.pathname === '/index.html'
      ? 'index.html'
      : url.pathname.slice(1);
    if (Object.prototype.hasOwnProperty.call({
      'index.html': true,
      'script.js': true,
      'style.css': true
    }, filename)) {
      return sendStatic(request, response, filename);
    }
  }

  sendJson(response, 404, { error: 'Not found.' });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(error => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    sendJson(response, error.status || 500, {
      error: error.status ? error.message : 'An unexpected server error occurred.'
    });
    if (!error.status) console.error(error);
  });
});

initializeDatabase().then(() => {
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`BrightDesk portal running at http://${process.env.HOST || '127.0.0.1'}:${port}`);
  });
}).catch(error => {
  console.error('Unable to initialize the MySQL database:', error.message);
  process.exitCode = 1;
});
