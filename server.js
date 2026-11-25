const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
const dataDirectory = process.env.PORTAL_DATA_DIR || path.join(root, '.portal-data');
const usersFile = path.join(dataDirectory, 'users.json');
const port = Number(process.env.PORT || 3000);
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const sessionCookie = 'brightdesk_session';
const sessionStore = new Map();
const defaultPortalData = {
  bd_classes: [],
  bd_attendance: {},
  bd_tasks: [],
  bd_student_names: {}
};

fs.mkdirSync(dataDirectory, { recursive: true });
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '{}', { mode: 0o600 });
let users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

function persistUsers() {
  const temporaryFile = `${usersFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(users), { mode: 0o600 });
  fs.renameSync(temporaryFile, usersFile);
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

function getSessionUser(request) {
  const token = getSessionToken(request);
  const session = sessionStore.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessionStore.delete(token);
    return null;
  }
  return users[session.email] || null;
}

function createSession(email) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessionStore.set(token, { email, expiresAt: Date.now() + sessionLifetime });
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
    isRecord(value.bd_student_names);
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
    if (!isRecord(body) || !validEmail(body.email) || typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) {
      return sendJson(response, 400, { error: 'Enter a valid email and a password of at least 10 characters.' });
    }
    if (body.data !== undefined && !validPortalData(body.data)) {
      return sendJson(response, 400, { error: 'Existing portal data has an invalid format.' });
    }
    const email = body.email.trim().toLowerCase();
    if (users[email]) return sendJson(response, 409, { error: 'An account with this email already exists.' });
    const { salt, hash } = hashPassword(body.password);
    users[email] = {
      salt,
      passwordHash: hash,
      data: body.data || JSON.parse(JSON.stringify(defaultPortalData))
    };
    try {
      persistUsers();
    } catch (error) {
      delete users[email];
      throw error;
    }
    const token = createSession(email);
    return sendJson(response, 201, { authenticated: true }, { 'Set-Cookie': cookieHeader(token, sessionLifetime / 1000) });
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const body = await readJson(request);
    const email = isRecord(body) && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const user = validEmail(email) ? users[email] : null;
    if (!user || !isRecord(body) || typeof body.password !== 'string' || !verifyPassword(body.password, user)) {
      return sendJson(response, 401, { error: 'Invalid email or password.' });
    }
    const token = createSession(email);
    return sendJson(response, 200, { authenticated: true }, { 'Set-Cookie': cookieHeader(token, sessionLifetime / 1000) });
  }

  if (url.pathname === '/api/session' && request.method === 'GET') {
    const user = getSessionUser(request);
    return sendJson(response, 200, { authenticated: !!user });
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    sessionStore.delete(getSessionToken(request));
    return sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': cookieHeader('', 0) });
  }

  if (url.pathname === '/api/data' && request.method === 'GET') {
    const user = getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to access your portal data.' });
    return sendJson(response, 200, user.data);
  }

  if (url.pathname === '/api/data' && request.method === 'PUT') {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    const user = getSessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'Sign in to save your portal data.' });
    const data = await readJson(request);
    if (!validPortalData(data)) return sendJson(response, 400, { error: 'Portal data has an invalid format.' });
    user.data = data;
    persistUsers();
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

server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`BrightDesk portal running at http://${process.env.HOST || '127.0.0.1'}:${port}`);
});
