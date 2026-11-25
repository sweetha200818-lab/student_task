const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const mysql = require('mysql2/promise');

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
  bd_events: []
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
  return {
    username: user.username,
    salt: user.salt,
    passwordHash: user.password_hash,
    data: normalizePortalData(typeof user.portal_data === 'string' ? JSON.parse(user.portal_data) : user.portal_data)
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

function validUsername(value) {
  return typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 64 &&
    /^[a-zA-Z0-9._-]+$/.test(value);
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

  if (url.pathname === '/api/register' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const body = await readJson(request);
    if (!isRecord(body) || !validUsername(body.username) || typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) {
      return sendJson(response, 400, { error: 'Enter a valid username and a password of at least 10 characters.' });
    }
    if (body.data !== undefined && !validPortalData(body.data)) {
      return sendJson(response, 400, { error: 'Existing portal data has an invalid format.' });
    }
    const username = body.username.trim();
    const { salt, hash } = hashPassword(body.password);
    try {
      await database.execute(
        'INSERT INTO portal_users (username, salt, password_hash, portal_data) VALUES (?, ?, ?, ?)',
        [username, salt, hash, JSON.stringify(normalizePortalData(body.data || {}))]
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
    let user = null;
    if (validUsername(username)) {
      const [rows] = await database.execute(
        'SELECT salt, password_hash FROM portal_users WHERE username = ?',
        [username]
      );
      user = rows[0] || null;
    }
    if (!user || !isRecord(body) || typeof body.password !== 'string' ||
      !verifyPassword(body.password, { salt: user.salt, passwordHash: user.password_hash })) {
      return sendJson(response, 401, { error: 'Invalid username or password.' });
    }
    const token = createSession(username);
    return sendJson(response, 200, { authenticated: true }, { 'Set-Cookie': cookieHeader(token, sessionLifetime / 1000) });
  }

  if (url.pathname === '/api/session' && request.method === 'GET') {
    const user = await getSessionUser(request);
    return sendJson(response, 200, {
      authenticated: !!user,
      username: user ? user.username : ''
    });
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
    await database.execute(
      'UPDATE portal_users SET portal_data = ? WHERE username = ?',
      [JSON.stringify(normalizePortalData(data)), user.username]
    );
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
