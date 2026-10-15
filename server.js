'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'dealer-store.json');
const HOST = process.env.HOST || '::1';
const PORT = Number(process.env.PORT || 8000);
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map();
const rateLimits = new Map();
let store = { dealers: [], requests: [] };
let writeQueue = Promise.resolve();

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    store = {
      dealers: Array.isArray(saved.dealers) ? saved.dealers : [],
      requests: Array.isArray(saved.requests) ? saved.requests : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveStore();
  }
  let addedCodes = false;
  const existingCodes = new Set(store.dealers.map(dealer => dealer.code).filter(Boolean));
  for (const dealer of store.dealers) {
    if (dealer.code) continue;
    dealer.code = generateDealerCode(existingCodes);
    addedCodes = true;
  }
  if (addedCodes) await saveStore();
}

function extractImportedCatalog(html) {
  const marker = 'window.MTECH_IMPORTED_CATALOG=';
  const start = html.indexOf(marker);
  if (start === -1) return [];
  let i = start + marker.length;
  let depth = 0;
  let quote = null;
  let escaped = false;
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const snippet = html.slice(start + marker.length, i + 1);
        try {
          return JSON.parse(snippet);
        } catch {
          return [];
        }
      }
    }
    i += 1;
  }
  return [];
}

let productCatalog = [];

async function loadProductCatalog() {
  try {
    const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
    productCatalog = extractImportedCatalog(html);
  } catch {
    productCatalog = [];
  }
}

function generateDealerCode(existing = new Set()) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    const bytes = crypto.randomBytes(8);
    code = 'MT-' + Array.from(bytes, byte => alphabet[byte % alphabet.length]).slice(0, 6).join('');
  } while (existing.has(code));
  existing.add(code);
  return code;
}

function saveStore() {
  const snapshot = JSON.stringify(store, null, 2) + '\n';
  writeQueue = writeQueue.then(async () => {
    const tempFile = STORE_FILE + '.tmp';
    await fs.writeFile(tempFile, snapshot, { mode: 0o600 });
    await fs.rename(tempFile, STORE_FILE);
  });
  return writeQueue;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 16 * 1024) fail(413, 'Request is too large.');
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    fail(400, 'Request body must be valid JSON.');
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMobile(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  const normalized = raw.startsWith('+') ? `+${digits}` : digits.length === 10 ? `+91${digits}` : `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) fail(400, 'Enter a valid mobile number, including country code if outside India.');
  return normalized;
}

function validateIdentity(name, email, mobile) {
  if (!name || name.length > 120) fail(400, 'Enter a valid dealer or shop name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail(400, 'Enter a valid email address.');
  return { name, email, mobile };
}

function requireAdmin(request) {
  const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expiresAt = adminSessions.get(token);
  if (!token || !expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(token);
    fail(401, 'Admin sign-in has expired. Please sign in again.');
  }
}

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const recent = (rateLimits.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= limit) fail(429, 'Too many attempts. Please wait before trying again.');
  recent.push(now);
  rateLimits.set(key, recent);
}

async function sendEmailOtp(email, code, accountType = 'dealer') {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    throw new Error('Email OTP is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL in .env.');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [email],
      subject: `Your Mtech ${accountType} sign-in code`,
      text: `Your Mtech ${accountType} sign-in code is ${code}. It expires in 5 minutes. Do not share this code with anyone.`
    })
  });
  if (!response.ok) throw new Error('Email provider rejected the OTP request.');
}

async function sendSmsOtp(mobile, code, accountType = 'dealer') {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = process.env;
  if (!sid || !token || !from) {
    throw new Error('SMS OTP is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in .env.');
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const body = new URLSearchParams({
    To: mobile,
    From: from,
    Body: `Your Mtech ${accountType} sign-in code is ${code}. It expires in 5 minutes. Do not share this code.`
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  if (!response.ok) throw new Error('SMS provider rejected the OTP request.');
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const { pathname } = url;
  const ip = request.socket.remoteAddress || 'unknown';

  if (request.method === 'GET' && pathname === '/api/health') {
    return sendJson(response, 200, { success: true });
  }

  if (request.method === 'POST' && pathname === '/api/admin/login') {
    rateLimit(`admin-login:${ip}`, 10, 15 * 60 * 1000);
    const body = await readJson(request);
    const configuredPassword = process.env.ADMIN_PASSWORD;
    if (!configuredPassword || !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(body.password || '')).digest(),
      crypto.createHash('sha256').update(configuredPassword).digest()
    )) fail(401, 'Incorrect admin password or missing server configuration.');
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
    return sendJson(response, 200, { success: true, token });
  }

  if (request.method === 'POST' && pathname === '/api/dealer/signup') {
    rateLimit(`signup:${ip}`, 10, 60 * 60 * 1000);
    const body = await readJson(request);
    const identity = validateIdentity(String(body.name || '').trim(), normalizeEmail(body.email), normalizeMobile(body.mobile));
    if (store.dealers.some(dealer => dealer.email === identity.email)) {
      fail(409, 'An approved dealer account already exists for this email. Please sign in.');
    }
    if (store.requests.some(item => item.email === identity.email)) {
      fail(409, 'An account request for this email is already pending admin approval.');
    }
    store.requests.push({
      id: crypto.randomUUID(),
      ...identity,
      requestedAt: new Date().toISOString()
    });
    await saveStore();
    return sendJson(response, 201, { success: true });
  }

  if (request.method === 'POST' && pathname === '/api/dealer/code/login') {
    rateLimit(`dealer-code-ip:${ip}`, 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const code = String(body.code || '').trim().toUpperCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^MT-[A-Z2-9]{6}$/.test(code)) {
      fail(400, 'Enter your dealer email address and valid dealer code.');
    }
    rateLimit(`dealer-code-email:${email}`, 10, 15 * 60 * 1000);
    const dealer = store.dealers.find(item => item.email === email);
    const suppliedHash = crypto.createHash('sha256').update(code).digest();
    const savedHash = crypto.createHash('sha256').update(String(dealer?.code || '')).digest();
    if (!dealer || !crypto.timingSafeEqual(suppliedHash, savedHash)) {
      fail(401, 'Dealer email or code is incorrect.');
    }
    return sendJson(response, 200, {
      success: true,
      dealer: { name: dealer.name, email: dealer.email, mobile: dealer.mobile }
    });
  }

  if (request.method === 'GET' && pathname === '/api/products') {
    return sendJson(response, 200, productCatalog);
  }

  const adminApiRoute = request.method === 'GET' && pathname === '/api/admin/dealers'
    || request.method === 'POST' && [
      '/api/admin/dealer-requests/approve',
      '/api/admin/dealer-requests/reject',
      '/api/admin/dealers'
    ].includes(pathname)
    || request.method === 'DELETE' && pathname === '/api/admin/dealers';
  if (adminApiRoute) {
    requireAdmin(request);
    if (request.method === 'GET' && pathname === '/api/admin/dealers') {
      return sendJson(response, 200, { success: true, dealers: store.dealers, requests: store.requests });
    }
    if (request.method === 'POST' && pathname === '/api/admin/dealer-requests/approve') {
      const { id } = await readJson(request);
      const index = store.requests.findIndex(item => item.id === id);
      if (index < 0) fail(404, 'Dealer request not found.');
      const dealer = store.requests[index];
      if (store.dealers.some(item => item.email === dealer.email)) fail(409, 'This dealer is already approved.');
      const code = generateDealerCode(new Set(store.dealers.map(item => item.code).filter(Boolean)));
      store.dealers.push({ name: dealer.name, email: dealer.email, mobile: dealer.mobile, code, approvedAt: new Date().toISOString() });
      store.requests.splice(index, 1);
      await saveStore();
      return sendJson(response, 200, { success: true, dealer: store.dealers[store.dealers.length - 1] });
    }
    if (request.method === 'POST' && pathname === '/api/admin/dealer-requests/reject') {
      const { id } = await readJson(request);
      const index = store.requests.findIndex(item => item.id === id);
      if (index < 0) fail(404, 'Dealer request not found.');
      store.requests.splice(index, 1);
      await saveStore();
      return sendJson(response, 200, { success: true });
    }
    if (request.method === 'POST' && pathname === '/api/admin/dealers') {
      const body = await readJson(request);
      const dealer = validateIdentity(String(body.name || '').trim(), normalizeEmail(body.email), normalizeMobile(body.mobile));
      if (store.dealers.some(item => item.email === dealer.email)) fail(409, 'A dealer with this email already exists.');
      dealer.code = generateDealerCode(new Set(store.dealers.map(item => item.code).filter(Boolean)));
      dealer.approvedAt = new Date().toISOString();
      store.dealers.push(dealer);
      await saveStore();
      return sendJson(response, 201, { success: true, dealer });
    }
    if (request.method === 'DELETE' && pathname === '/api/admin/dealers') {
      const email = normalizeEmail(url.searchParams.get('email'));
      const initialLength = store.dealers.length;
      store.dealers = store.dealers.filter(item => item.email !== email);
      if (store.dealers.length === initialLength) fail(404, 'Dealer account not found.');
      await saveStore();
      return sendJson(response, 200, { success: true });
    }
    fail(404, 'API route not found.');
  }

  if (request.method === 'GET') {
    let filePath;
    if (pathname === '/') filePath = path.join(ROOT, 'index.html');
    else if (pathname.startsWith('/images/')) {
      filePath = path.resolve(ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(path.join(ROOT, 'images') + path.sep)) fail(404, 'Not found.');
    } else {
      fail(404, 'Not found.');
    }
    let content;
    try {
      content = await fs.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') fail(404, 'Not found.');
      throw error;
    }
    const extension = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
    response.writeHead(200, {
      'Content-Type': types[extension] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'same-origin'
    });
    return response.end(content);
  }

  fail(404, 'Not found.');
}

async function start() {
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 5) {
    throw new Error('Set ADMIN_PASSWORD to a unique value of at least 5 characters in .env.');
  }
  await loadStore();
  await loadProductCatalog();
  const server = http.createServer((request, response) => {
    route(request, response).catch(error => {
      if (!response.headersSent) {
        sendJson(response, error.status || 500, {
          success: false,
          error: error.status ? error.message : 'The server could not complete the request.'
        });
      } else {
        response.destroy();
      }
      if (!error.status) console.error(error);
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`Mtech store running at http://${HOST}:${PORT}`);
    console.log(`Dealer data is stored locally in ${STORE_FILE}`);
  });
}

start().catch(error => {
  console.error(`Server startup failed: ${error.message}`);
  process.exitCode = 1;
});
