'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'dealer-store.json');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog-store.json');
const ORDER_FILE = path.join(DATA_DIR, 'order-store.json');
const HOST = process.env.HOST || '::1';
const PORT = Number(process.env.PORT || 8000);
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const PAYMENT_INTENT_MS = 30 * 60 * 1000;
const DELIVERY_FEE = 99;
const DEFAULT_CATEGORIES = ['Antivirus', 'Software', 'PC Build'];
const DEFAULT_CATEGORY_STRUCTURE = {
  Antivirus: ['Quick Heal', 'NPAV'],
  Software: ['Windows'],
  'PC Build': ['CPU', 'Motherboard', 'RAM', 'Graphics Card', 'Cooler', 'SSD M2', 'SSD SATA', 'HDD', 'SMPS', 'Cabinet', 'Home & Office Pre Build PCs', 'Gaming PCs']
};
const adminSessions = new Map();
const customerSessions = new Map();
const rateLimits = new Map();
let store = { dealers: [], requests: [] };
let orderStore = { customers: [], orders: [], paymentIntents: [] };
let writeQueue = Promise.resolve();
let catalogWriteQueue = Promise.resolve();
let orderWriteQueue = Promise.resolve();
let orderMutationQueue = Promise.resolve();
let productCatalog = [];
let categoryCatalog = {
  categories: [...DEFAULT_CATEGORIES],
  structure: structuredClone(DEFAULT_CATEGORY_STRUCTURE)
};

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

async function loadOrderStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(ORDER_FILE, 'utf8'));
    orderStore = {
      customers: Array.isArray(saved.customers) ? saved.customers : [],
      orders: Array.isArray(saved.orders) ? saved.orders : [],
      paymentIntents: Array.isArray(saved.paymentIntents) ? saved.paymentIntents : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveOrderStore();
  }
}

function extractArraySource(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
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
        return html.slice(start + marker.length, i + 1);
      }
    }
    i += 1;
  }
  return null;
}

function normalizeSubcategory(category, subcategory) {
  if (typeof subcategory !== 'string') return '';
  const name = subcategory.trim();
  if (category !== 'PC Build') return name;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = {
    cpu: 'CPU',
    motherboard: 'Motherboard',
    ram: 'RAM',
    graphicscard: 'Graphics Card',
    graphicscards: 'Graphics Card',
    gpu: 'Graphics Card',
    cooler: 'Cooler',
    cooling: 'Cooler',
    coolingsolutions: 'Cooler',
    ssdm2: 'SSD M2',
    m2ssd: 'SSD M2',
    ssdsata: 'SSD SATA',
    satassd: 'SSD SATA',
    hdd: 'HDD',
    hddharddrives: 'HDD',
    harddrive: 'HDD',
    harddrives: 'HDD',
    smps: 'SMPS',
    smpspowersupplies: 'SMPS',
    powersupply: 'SMPS',
    powersupplies: 'SMPS',
    cabinet: 'Cabinet',
    case: 'Cabinet',
    homeofficeprebuildpcs: 'Home & Office Pre Build PCs',
    gamingpcs: 'Gaming PCs'
  };
  return aliases[key] || name;
}

async function loadProductCatalog() {
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const importedSource = extractArraySource(html, 'window.MTECH_IMPORTED_CATALOG=');
  let importedProducts = [];
  if (importedSource) {
    try {
      importedProducts = JSON.parse(importedSource);
    } catch (error) {
      throw new Error(`Could not parse the imported product catalog: ${error.message}`);
    }
  }

  const demoSource = extractArraySource(html, 'const DEMO_PRODUCTS =');
  if (!demoSource) fail(500, 'Default product catalog was not found.');
  let demoProducts;
  try {
    demoProducts = vm.runInNewContext(`(${demoSource})`, Object.create(null), { timeout: 1000 });
    if (!Array.isArray(demoProducts)) fail(500, 'Default product catalog must be an array.');
  } catch (error) {
    throw new Error(`Could not parse the default product catalog: ${error.message}`);
  }

  const defaultProducts = demoProducts.filter(product =>
    product.category !== 'PC Build' || product.subcategory === 'Home & Office Pre Build PCs' || product.subcategory === 'Gaming PCs'
  );
  const initialProducts = [...defaultProducts, ...importedProducts];

  try {
    const saved = JSON.parse(await fs.readFile(CATALOG_FILE, 'utf8'));
    productCatalog = Array.isArray(saved.products) ? saved.products : initialProducts;
    if (Array.isArray(saved.categories) && saved.structure && typeof saved.structure === 'object') {
      categoryCatalog = { categories: saved.categories, structure: saved.structure };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    productCatalog = initialProducts;
  }

  const beforeSync = JSON.stringify({ products: productCatalog, categories: categoryCatalog });
  syncCategoriesFromProducts();
  if (!await fileExists(CATALOG_FILE) || JSON.stringify({ products: productCatalog, categories: categoryCatalog }) !== beforeSync) {
    await saveCatalog();
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function syncCategoriesFromProducts() {
  const categories = new Set(categoryCatalog.categories);
  const structure = {};
  for (const category of categories) {
    const existing = categoryCatalog.structure[category];
    structure[category] = Array.isArray(existing)
      ? [...new Set(existing.map(subcategory => normalizeSubcategory(category, subcategory)).filter(Boolean))]
      : [];
  }
  categoryCatalog.structure = structure;
  for (const product of productCatalog) {
    if (!product || typeof product.category !== 'string' || !product.category.trim()) continue;
    const category = product.category.trim();
    product.category = category;
    categories.add(category);
    if (!Array.isArray(categoryCatalog.structure[category])) categoryCatalog.structure[category] = [];
    const subcategory = normalizeSubcategory(category, product.subcategory);
    product.subcategory = subcategory;
    if (subcategory && !categoryCatalog.structure[category].includes(subcategory)) {
      categoryCatalog.structure[category].push(subcategory);
    }
  }
  categoryCatalog.categories = [...categories];
}

function saveCatalog() {
  const snapshot = JSON.stringify({
    products: productCatalog,
    categories: categoryCatalog.categories,
    structure: categoryCatalog.structure
  }, null, 2) + '\n';
  catalogWriteQueue = catalogWriteQueue.then(async () => {
    const tempFile = CATALOG_FILE + '.tmp';
    await fs.writeFile(tempFile, snapshot, { mode: 0o600 });
    await fs.rename(tempFile, CATALOG_FILE);
  });
  return catalogWriteQueue;
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

function saveOrderStore() {
  const snapshot = JSON.stringify(orderStore, null, 2) + '\n';
  orderWriteQueue = orderWriteQueue.then(async () => {
    const tempFile = ORDER_FILE + '.tmp';
    await fs.writeFile(tempFile, snapshot, { mode: 0o600 });
    await fs.rename(tempFile, ORDER_FILE);
  });
  return orderWriteQueue;
}

function serializeOrderMutation(action) {
  const operation = orderMutationQueue.then(action);
  orderMutationQueue = operation.catch(() => {});
  return operation;
}

function requireCustomer(request) {
  const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = customerSessions.get(token);
  if (!token || !session || session.expiresAt <= Date.now()) {
    customerSessions.delete(token);
    fail(401, 'Customer sign-in has expired. Please sign in again.');
  }
  const customer = orderStore.customers.find(item => item.email === session.email);
  if (!customer) fail(401, 'Customer account was not found. Please sign in again.');
  return customer;
}

function createCustomerSession(customer) {
  const token = crypto.randomBytes(32).toString('hex');
  customerSessions.set(token, { email: customer.email, expiresAt: Date.now() + ADMIN_SESSION_MS });
  return token;
}

function pendingQuantity(productId, plan = null, excludeIntentId = null) {
  const pendingOrders = orderStore.orders
    .filter(order => order.status === 'pending')
    .flatMap(order => order.items)
    .filter(item => String(item.id) === String(productId) && (plan === null || item.plan === plan))
    .reduce((total, item) => total + item.qty, 0);
  const reservedIntents = orderStore.paymentIntents
    .filter(intent => intent.id !== excludeIntentId && intent.status === 'created' && intent.expiresAt > Date.now())
    .flatMap(intent => intent.items)
    .filter(item => String(item.id) === String(productId) && (plan === null || item.plan === plan))
    .reduce((total, item) => total + item.qty, 0);
  return pendingOrders + reservedIntents;
}

function findProduct(productId) {
  return productCatalog.find(product => String(product.id) === String(productId));
}

function orderPlanKey(plan) {
  return typeof plan === 'string' && /^[1-9]\d{0,2}u-[1-9]\d{0,2}y$/.test(plan) ? plan : '';
}

function getAvailableLicenseKeys(product, plan) {
  if (!Array.isArray(product.licenseKeys)) return null;
  return product.licenseKeys.filter(key =>
    key && key.status === 'available' && (!plan || key.plan === plan)
  );
}

function validateOrderItems(items, excludeIntentId = null) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
    fail(400, 'An order must contain between 1 and 50 items.');
  }
  const lines = [];
  const lineQuantities = new Map();
  let totalQuantity = 0;
  for (const item of items) {
    const product = item && findProduct(item.id);
    const qty = Number(item && item.qty);
    if (!product || !Number.isSafeInteger(qty) || qty < 1 || qty > 100) {
      fail(400, 'Each order item must have a valid product and quantity.');
    }
    totalQuantity += qty;
    if (totalQuantity > 100) fail(400, 'An order cannot contain more than 100 items.');
    const plan = item.plan ? orderPlanKey(item.plan) : '';
    if (item.plan && !plan) fail(400, `The selected plan for "${product.name}" is invalid.`);
    const selectedPlan = plan && (product.plans || []).find(value => `${value.users}u-${value.years}y` === plan);
    if (plan && !selectedPlan) fail(400, `The selected plan for "${product.name}" is not available.`);
    if (!plan && Array.isArray(product.plans) && product.plans.length) {
      fail(400, `Choose a license plan for "${product.name}".`);
    }
    const unitPrice = Number(selectedPlan ? selectedPlan.price : product.price);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) fail(400, `"${product.name}" is not currently available to order.`);
    const lineKey = JSON.stringify([String(product.id), plan]);
    const existing = lineQuantities.get(lineKey);
    if (existing) existing.qty += qty;
    else {
      const line = { id: product.id, name: product.name, qty, plan: plan || '', unitPrice, assignedKeys: [] };
      lineQuantities.set(lineKey, line);
      lines.push(line);
    }
  }
  const productQuantities = new Map();
  for (const line of lines) {
    const product = findProduct(line.id);
    const selectedPlan = line.plan && (product.plans || []).find(value => `${value.users}u-${value.years}y` === line.plan);
    const pending = pendingQuantity(line.id, line.plan || null, excludeIntentId);
    const stock = Number(selectedPlan ? selectedPlan.stock : product.stock);
    if (Number.isFinite(stock) && stock - pending < line.qty) {
      fail(409, `"${product.name}" does not have enough available stock.`);
    }
    const availableKeys = getAvailableLicenseKeys(product, line.plan);
    if (availableKeys && availableKeys.length - pending < line.qty) {
      fail(409, `"${product.name}" does not have enough available license keys.`);
    }
    productQuantities.set(String(line.id), (productQuantities.get(String(line.id)) || 0) + line.qty);
  }
  for (const [productId, qty] of productQuantities) {
    const product = findProduct(productId);
    if (Number(product.stock) < pendingQuantity(productId, null, excludeIntentId) + qty) {
      fail(409, `"${product.name}" does not have enough available stock.`);
    }
  }
  return lines;
}

function verifyPaymentIntentInventory(intent) {
  const productQuantities = new Map();
  const planQuantities = new Map();
  for (const item of intent.items) {
    const product = findProduct(item.id);
    if (!product) fail(409, `Product "${item.name}" is no longer available.`);
    const plan = item.plan && (product.plans || []).find(value => `${value.users}u-${value.years}y` === item.plan);
    if (item.plan && !plan) fail(409, `The selected plan for "${item.name}" is no longer available.`);
    const productId = String(item.id);
    productQuantities.set(productId, (productQuantities.get(productId) || 0) + item.qty);
    if (plan) {
      const key = JSON.stringify([productId, item.plan]);
      const current = planQuantities.get(key) || { product, plan, name: item.name, qty: 0 };
      current.qty += item.qty;
      planQuantities.set(key, current);
    }
  }
  for (const [productId, qty] of productQuantities) {
    const product = findProduct(productId);
    if (Number(product.stock) - pendingQuantity(productId, null, intent.id) < qty) {
      fail(409, `"${product.name}" no longer has enough available stock.`);
    }
  }
  for (const { product, plan, name, qty } of planQuantities.values()) {
    const planKey = `${plan.users}u-${plan.years}y`;
    if (Number(plan.stock) - pendingQuantity(product.id, planKey, intent.id) < qty) {
      fail(409, `"${name}" no longer has enough available stock for this plan.`);
    }
  }
  for (const item of intent.items) {
    const product = findProduct(item.id);
    const availableKeys = getAvailableLicenseKeys(product, item.plan);
    if (availableKeys && availableKeys.length - pendingQuantity(item.id, item.plan || null, intent.id) < item.qty) {
      fail(409, `"${product.name}" no longer has enough available license keys.`);
    }
  }
}

function razorpayCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    fail(503, 'Online payment is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.');
  }
  return { keyId, keySecret };
}

async function razorpayRequest(endpoint, options = {}) {
  const { keyId, keySecret } = razorpayCredentials();
  let response;
  try {
    response = await fetch(`https://api.razorpay.com/v1/${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      fail(502, 'Razorpay did not respond in time. Please try again.');
    }
    fail(502, 'Could not connect to Razorpay. Please try again.');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    fail(502, 'Razorpay returned an invalid response.');
  }
  if (!response.ok) {
    console.error('Razorpay API request failed:', response.status, result?.error?.code || 'unknown');
    fail(502, 'Razorpay could not process the payment request. Please try again.');
  }
  return result;
}

function validateOrderAddress(value) {
  const customer = value && typeof value === 'object' ? value : {};
  const fields = {
    name: String(customer.name || '').trim(),
    address: String(customer.address || '').trim(),
    city: String(customer.city || '').trim(),
    pincode: String(customer.pincode || '').trim()
  };
  if (!fields.name || fields.name.length > 120
    || !fields.address || fields.address.length > 240
    || !fields.city || fields.city.length > 100
    || !fields.pincode || fields.pincode.length > 20) {
    fail(400, 'Enter a valid name, address, city, and pincode.');
  }
  return fields;
}

function completeOrderInventory(order) {
  const productQuantities = new Map();
  const planQuantities = new Map();
  for (const item of order.items) {
    const product = findProduct(item.id);
    if (!product) fail(409, `Product "${item.name}" no longer exists in the catalog.`);
    const plan = item.plan && (product.plans || []).find(value => `${value.users}u-${value.years}y` === item.plan);
    if (item.plan && !plan) fail(409, `The selected plan for "${item.name}" no longer exists.`);
    productQuantities.set(String(item.id), (productQuantities.get(String(item.id)) || 0) + item.qty);
    if (plan) {
      const key = JSON.stringify([String(item.id), item.plan]);
      planQuantities.set(key, { plan, name: item.name, qty: (planQuantities.get(key)?.qty || 0) + item.qty });
    }
    const availableKeys = getAvailableLicenseKeys(product, item.plan);
    if (availableKeys && availableKeys.length < item.qty) fail(409, `Not enough license keys remain for "${item.name}".`);
  }
  for (const [productId, qty] of productQuantities) {
    const product = findProduct(productId);
    if (Number(product.stock) < qty) fail(409, `Not enough stock remains for "${product.name}".`);
  }
  for (const { plan, name, qty } of planQuantities.values()) {
    if (Number(plan.stock) < qty) fail(409, `Not enough stock remains for "${name}".`);
  }
  for (const item of order.items) {
    const product = findProduct(item.id);
    const plan = item.plan && (product.plans || []).find(value => `${value.users}u-${value.years}y` === item.plan);
    if (plan) {
      plan.stock = Number(plan.stock) - item.qty;
    }
    product.stock = Number(product.stock || 0) - item.qty;
    const availableKeys = getAvailableLicenseKeys(product, item.plan);
    if (availableKeys) {
      const assigned = availableKeys.slice(0, item.qty);
      assigned.forEach(key => { key.status = 'sold'; });
      item.assignedKeys = assigned.map(key => key.key);
    }
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = 16 * 1024) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) fail(413, 'Request is too large.');
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

  if (request.method === 'POST' && pathname === '/api/customers/register') {
    rateLimit(`customer-register:${ip}`, 10, 60 * 60 * 1000);
    const body = await readJson(request);
    const name = String(body.name || '').trim();
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!name || name.length > 120) fail(400, 'Enter a valid name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail(400, 'Enter a valid email address.');
    if (password.length < 6 || Buffer.byteLength(password) > 256) fail(400, 'Password must be between 6 and 256 characters.');
    return serializeOrderMutation(async () => {
      if (orderStore.customers.some(customer => customer.email === email)) fail(409, 'An account with this email already exists. Please sign in.');
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (error, derivedKey) => error ? reject(error) : resolve(derivedKey.toString('hex')));
      });
      const customer = { id: crypto.randomUUID(), name, email, salt, passwordHash, createdAt: new Date().toISOString() };
      orderStore.customers.push(customer);
      await saveOrderStore();
      return sendJson(response, 201, {
        success: true,
        token: createCustomerSession(customer),
        name: customer.name,
        email: customer.email
      });
    });
  }

  if (request.method === 'POST' && pathname === '/api/customers/login') {
    rateLimit(`customer-login:${ip}`, 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length > 256) {
      fail(401, 'Email or password is incorrect.');
    }
    rateLimit(`customer-login-email:${email}`, 10, 15 * 60 * 1000);
    const customer = orderStore.customers.find(item => item.email === email);
    const suppliedHash = await new Promise((resolve, reject) => {
      crypto.scrypt(password, customer?.salt || 'invalid-customer-salt', 64, (error, derivedKey) =>
        error ? reject(error) : resolve(derivedKey)
      );
    });
    const savedHash = Buffer.from(customer?.passwordHash || '0'.repeat(128), 'hex');
    if (!customer || savedHash.length !== suppliedHash.length || !crypto.timingSafeEqual(suppliedHash, savedHash)) {
      fail(401, 'Email or password is incorrect.');
    }
    return sendJson(response, 200, {
      success: true,
      token: createCustomerSession(customer),
      name: customer.name,
      email: customer.email
    });
  }

  if (request.method === 'POST' && pathname === '/api/payments/razorpay/orders') {
    const customer = requireCustomer(request);
    rateLimit(`razorpay-order:${ip}`, 10, 15 * 60 * 1000);
    const body = await readJson(request, 64 * 1024);
    const address = validateOrderAddress(body.customer);
    return serializeOrderMutation(async () => {
      const items = validateOrderItems(body.items);
      const total = items.reduce((sum, item) => sum + item.unitPrice * item.qty, DELIVERY_FEE);
      const amount = Math.round(total * 100);
      if (!Number.isSafeInteger(amount) || amount < 100) fail(400, 'The order total is not valid for online payment.');
      const intentId = crypto.randomUUID();
      const expiresAt = Date.now() + PAYMENT_INTENT_MS;
      const razorpayOrder = await razorpayRequest('orders', {
        method: 'POST',
        body: JSON.stringify({
          amount,
          currency: 'INR',
          receipt: intentId.replace(/-/g, ''),
          expire_by: Math.floor(expiresAt / 1000),
          notes: { intent_id: intentId }
        })
      });
      if (typeof razorpayOrder.id !== 'string' || razorpayOrder.amount !== amount || razorpayOrder.currency !== 'INR') {
        fail(502, 'Razorpay returned unexpected order details.');
      }
      const intent = {
        id: intentId,
        razorpayOrderId: razorpayOrder.id,
        customerEmail: customer.email,
        customer: address,
        items,
        total,
        status: 'created',
        createdAt: new Date().toISOString(),
        expiresAt
      };
      orderStore.paymentIntents = orderStore.paymentIntents.filter(existing =>
        (existing.status === 'created' && existing.expiresAt > Date.now())
        || (existing.status === 'completed' && Date.now() - Date.parse(existing.createdAt) < 30 * 24 * 60 * 60 * 1000)
      );
      orderStore.paymentIntents.push(intent);
      await saveOrderStore();
      return sendJson(response, 201, {
        success: true,
        intentId,
        keyId: process.env.RAZORPAY_KEY_ID,
        orderId: razorpayOrder.id,
        amount,
        currency: 'INR',
        total,
        customer: { name: address.name, email: customer.email }
      });
    });
  }

  if (request.method === 'POST' && pathname === '/api/payments/razorpay/verify') {
    const customer = requireCustomer(request);
    rateLimit(`razorpay-verify:${ip}`, 30, 15 * 60 * 1000);
    const body = await readJson(request);
    const intentId = String(body.intentId || '');
    const razorpayOrderId = String(body.razorpay_order_id || '');
    const paymentId = String(body.razorpay_payment_id || '');
    const signature = String(body.razorpay_signature || '');
    const intent = orderStore.paymentIntents.find(item =>
      item.id === intentId && item.razorpayOrderId === razorpayOrderId && item.customerEmail === customer.email
    );
    if (!intent || !paymentId || !/^[a-f\d]{64}$/i.test(signature)) {
      fail(400, 'The Razorpay payment details could not be verified.');
    }
    const { keySecret } = razorpayCredentials();
    const expectedSignature = crypto.createHmac('sha256', keySecret)
      .update(`${razorpayOrderId}|${paymentId}`)
      .digest();
    const receivedSignature = Buffer.from(signature, 'hex');
    if (!crypto.timingSafeEqual(expectedSignature, receivedSignature)) {
      fail(400, 'Razorpay payment signature is invalid.');
    }
    if (intent.status === 'completed') {
      const existingOrder = orderStore.orders.find(item => item.paymentIntentId === intent.id);
      if (existingOrder && existingOrder.razorpayPaymentId === paymentId) {
        return sendJson(response, 200, { success: true, order: existingOrder });
      }
      fail(409, 'This payment intent has already been used.');
    }
    if (intent.status !== 'created' || intent.expiresAt <= Date.now()) {
      fail(410, 'This payment session has expired. Please place the order again.');
    }
    let payment = await razorpayRequest(`payments/${encodeURIComponent(paymentId)}`);
    const expectedAmount = Math.round(intent.total * 100);
    if (payment.order_id !== razorpayOrderId
      || payment.amount !== expectedAmount
      || payment.currency !== 'INR') {
      fail(409, 'Razorpay payment details do not match this order.');
    }
    if (payment.status === 'authorized') {
      payment = await razorpayRequest(`payments/${encodeURIComponent(paymentId)}/capture`, {
        method: 'POST',
        body: JSON.stringify({ amount: expectedAmount, currency: 'INR' })
      });
    }
    if (payment.status !== 'captured') {
      fail(409, 'Razorpay has not confirmed the full captured payment for this order.');
    }
    return serializeOrderMutation(async () => {
      if (intent.status === 'completed') {
        const existingOrder = orderStore.orders.find(item => item.paymentIntentId === intent.id);
        if (existingOrder && existingOrder.razorpayPaymentId === paymentId) {
          return sendJson(response, 200, { success: true, order: existingOrder });
        }
        fail(409, 'This payment intent has already been used.');
      }
      if (intent.status !== 'created' || intent.expiresAt <= Date.now()) {
        fail(410, 'This payment session has expired. Please place the order again.');
      }
      verifyPaymentIntentInventory(intent);
      const order = {
        id: `MT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        paymentIntentId: intent.id,
        customer: intent.customer,
        customerEmail: intent.customerEmail,
        items: structuredClone(intent.items),
        total: intent.total,
        paymentMethod: payment.method || 'razorpay',
        paymentStatus: 'paid',
        paymentProvider: 'razorpay',
        razorpayOrderId,
        razorpayPaymentId: paymentId,
        status: 'pending',
        date: new Date().toISOString()
      };
      intent.status = 'completed';
      intent.paymentId = paymentId;
      orderStore.orders.push(order);
      await saveOrderStore();
      return sendJson(response, 201, { success: true, order });
    });
  }

  if (request.method === 'POST' && pathname === '/api/orders') {
    const customer = requireCustomer(request);
    const body = await readJson(request, 64 * 1024);
    const address = validateOrderAddress(body.customer);
    const paymentMethod = String(body.paymentMethod || '');
    if (!['bank'].includes(paymentMethod)) fail(400, 'Choose a valid payment method.');
    return serializeOrderMutation(async () => {
      const items = validateOrderItems(body.items);
      const order = {
        id: `MT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        customer: address,
        customerEmail: customer.email,
        items,
        total: items.reduce((sum, item) => sum + item.unitPrice * item.qty, DELIVERY_FEE),
        paymentMethod,
        paymentStatus: 'pending',
        status: 'pending',
        date: new Date().toISOString()
      };
      orderStore.orders.push(order);
      await saveOrderStore();
      return sendJson(response, 201, { success: true, order });
    });
  }

  if (request.method === 'GET' && pathname === '/api/auth/google-config') {
    return sendJson(response, 200, { googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
  }

  if (request.method === 'POST' && pathname === '/api/customers/google') {
    rateLimit(`customer-google:${ip}`, 30, 15 * 60 * 1000);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) fail(503, 'Google sign-in is not configured. Set GOOGLE_CLIENT_ID in .env.');
    const body = await readJson(request);
    const credential = String(body.credential || '');
    if (!credential || credential.length > 4096) fail(400, 'Google sign-in failed. Please try again.');
    let info;
    try {
      const googleResponse = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
      info = await googleResponse.json();
      if (!googleResponse.ok) info = null;
    } catch (error) {
      fail(502, 'Could not reach Google to verify sign-in. Please try again.');
    }
    const issuerOk = info && ['accounts.google.com', 'https://accounts.google.com'].includes(info.iss);
    const verified = info && (info.email_verified === true || info.email_verified === 'true');
    if (!info || info.aud !== clientId || !issuerOk || !verified || Number(info.exp) * 1000 < Date.now()) {
      fail(401, 'Google sign-in could not be verified.');
    }
    const email = normalizeEmail(info.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail(401, 'Google account has no valid email.');
    const displayName = String(info.name || email.split('@')[0]).trim().slice(0, 120) || 'Customer';
    return serializeOrderMutation(async () => {
      let customer = orderStore.customers.find(item => item.email === email);
      let created = false;
      if (!customer) {
        customer = { id: crypto.randomUUID(), name: displayName, email, salt: '', passwordHash: '', googleId: String(info.sub || ''), createdAt: new Date().toISOString() };
        orderStore.customers.push(customer);
        created = true;
        await saveOrderStore();
      } else if (!customer.googleId && info.sub) {
        customer.googleId = String(info.sub);
        await saveOrderStore();
      }
      return sendJson(response, created ? 201 : 200, {
        success: true,
        created,
        token: createCustomerSession(customer),
        name: customer.name,
        email: customer.email
      });
    });
  }

  if (request.method === 'GET' && pathname === '/api/orders/mine') {
    const customer = requireCustomer(request);
    return sendJson(response, 200, orderStore.orders.filter(order => order.customerEmail === customer.email));
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

  if (request.method === 'GET' && pathname === '/api/admin/products') {
    requireAdmin(request);
    return sendJson(response, 200, productCatalog);
  }

  if (request.method === 'GET' && pathname === '/api/categories') {
    return sendJson(response, 200, categoryCatalog);
  }

  if (request.method === 'PUT' && pathname === '/api/admin/products') {
    requireAdmin(request);
    const body = await readJson(request, 32 * 1024 * 1024);
    if (!Array.isArray(body) || body.length > 20000) fail(400, 'Product catalog must be an array with no more than 20,000 products.');
    const ids = new Set();
    for (const product of body) {
      if (!product || (typeof product.id !== 'string' && typeof product.id !== 'number')
        || !String(product.id).trim()
        || typeof product.name !== 'string' || !product.name.trim()
        || typeof product.category !== 'string' || !product.category.trim()
        || typeof product.subcategory !== 'string' || !product.subcategory.trim()
        || !Number.isFinite(Number(product.price)) || Number(product.price) < 0
        || !Number.isFinite(Number(product.stock)) || Number(product.stock) < 0) {
        fail(400, 'Each product needs a valid ID, name, category, subcategory, price, and stock.');
      }
      const id = String(product.id);
      if (ids.has(id)) fail(400, `Duplicate product ID: ${id}.`);
      ids.add(id);
    }
    productCatalog = body;
    syncCategoriesFromProducts();
    await saveCatalog();
    return sendJson(response, 200, { success: true });
  }

  if (request.method === 'PUT' && pathname === '/api/admin/categories') {
    requireAdmin(request);
    const body = await readJson(request);
    if (!body || !Array.isArray(body.categories) || !body.structure || typeof body.structure !== 'object' || Array.isArray(body.structure)) {
      fail(400, 'Categories and their subcategory structure are required.');
    }
    const categories = [...new Set(body.categories.map(value => String(value).trim()).filter(Boolean))];
    if (categories.length > 1000 || categories.some(category => category.length > 100)) {
      fail(400, 'Category names must be at most 100 characters, with no more than 1,000 categories.');
    }
    const structure = {};
    for (const category of categories) {
      const subcategories = body.structure[category] || [];
      if (!Array.isArray(subcategories)) fail(400, `Subcategories for "${category}" must be a list.`);
      structure[category] = [...new Set(subcategories.map(value => String(value).trim()).filter(Boolean))];
      if (structure[category].some(subcategory => subcategory.length > 100)) {
        fail(400, 'Subcategory names must be at most 100 characters.');
      }
    }
    categoryCatalog = { categories, structure };
    syncCategoriesFromProducts();
    await saveCatalog();
    return sendJson(response, 200, { success: true });
  }

  if (request.method === 'GET' && pathname === '/api/admin/orders') {
    requireAdmin(request);
    return sendJson(response, 200, orderStore.orders);
  }

  const orderStatusMatch = request.method === 'PATCH' && pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (orderStatusMatch) {
    requireAdmin(request);
    const id = decodeURIComponent(orderStatusMatch[1]);
    const body = await readJson(request);
    if (!['pending', 'completed'].includes(body.status)) fail(400, 'Order status must be pending or completed.');
    return serializeOrderMutation(async () => {
      const order = orderStore.orders.find(item => item.id === id);
      if (!order) fail(404, 'Order not found.');
      if (order.status === body.status) return sendJson(response, 200, { success: true, order });
      if (order.status !== 'pending' || body.status !== 'completed') {
        fail(409, 'Completed orders cannot be reopened. Create a new order if needed.');
      }
      const previousCatalog = structuredClone(productCatalog);
      const previousOrder = structuredClone(order);
      try {
        completeOrderInventory(order);
        order.status = 'completed';
        await saveCatalog();
        await saveOrderStore();
      } catch (error) {
        productCatalog = previousCatalog;
        Object.assign(order, previousOrder);
        try {
          await saveCatalog();
          await saveOrderStore();
        } catch (rollbackError) {
          throw new Error(`Could not complete order or restore inventory: ${rollbackError.message}`);
        }
        throw error;
      }
      return sendJson(response, 200, { success: true, order });
    });
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
    else if (pathname === '/admin' || pathname === '/admin/') filePath = path.join(ROOT, 'admin.html');
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
      'Content-Security-Policy': "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
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
  await loadOrderStore();
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
