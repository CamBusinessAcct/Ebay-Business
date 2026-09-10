#!/usr/bin/env node
'use strict';

/*
  eBay AutoShop Web
  -----------------
  Zero npm dependencies. Requires Node.js 20+ (Node 24 recommended).

  Features retained from the Electron version:
  - AliExpress OAuth callback + access/refresh token persistence
  - Automatic AliExpress access-token refresh
  - AliExpress Dropshipping product lookup
  - SKU/variant, price, stock, image, shipping parsing
  - eBay image search / comparison
  - OpenAI image fallback + listing-description generation
  - eBay image upload + AddFixedPriceItem listing creation
  - Apparel-specific inference and eBay missing-specific retries
  - Posted-product tracking
  - Optional 3-hour worker heartbeat
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const ENV_PATH = path.join(ROOT, '.env');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const ALI_DEBUG_PATH = path.join(DATA_DIR, 'aliexpress-last-product-response.json');

loadEnvFile(ENV_PATH);
const APP_CONFIG = loadJsonConfig(CONFIG_PATH);

const PORT = Number(process.env.PORT || APP_CONFIG.port || 8080);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const EBAY_CONFIG = {
  app_id: process.env.EBAY_APP_ID || '',
  dev_id: process.env.EBAY_DEV_ID || '',
  cert_id: process.env.EBAY_CERT_ID || '',
  user_token: process.env.EBAY_USER_TOKEN || '',
  default_shipping_cost: process.env.EBAY_DEFAULT_SHIPPING_COST || String(APP_CONFIG.ebay_default_shipping_cost || '4.99')
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || APP_CONFIG.openai_model || 'gpt-4o-mini';

const ALIEXPRESS_APP_KEY = process.env.ALIEXPRESS_APP_KEY || '';
const ALIEXPRESS_APP_SECRET = process.env.ALIEXPRESS_APP_SECRET || '';

const LISTING_INTERVAL_SECONDS = Number(
  process.env.LISTING_INTERVAL_SECONDS ||
  APP_CONFIG.listing_interval_seconds ||
  (3 * 3600)
);
const ENABLE_WORKER = process.env.ENABLE_WORKER != null
  ? /^true$/i.test(process.env.ENABLE_WORKER)
  : Boolean(APP_CONFIG.enable_worker);

const PRODUCT_MANAGER_ENABLED = process.env.PRODUCT_MANAGER_ENABLED != null
  ? /^true$/i.test(process.env.PRODUCT_MANAGER_ENABLED)
  : (APP_CONFIG.product_manager_enabled !== false);
const PRODUCT_MANAGER_INTERVAL_SECONDS = Number(
  process.env.PRODUCT_MANAGER_INTERVAL_SECONDS ||
  APP_CONFIG.product_manager_interval_seconds ||
  300
);
const PRODUCT_MANAGER_MAX_LISTINGS = Number(
  process.env.PRODUCT_MANAGER_MAX_LISTINGS ||
  APP_CONFIG.product_manager_max_listings ||
  250
);

const AUTO_DISCOVERY_FEED_PAGES = Number(
  process.env.AUTO_DISCOVERY_FEED_PAGES ||
  APP_CONFIG.auto_discovery_feed_pages ||
  10
);
const AUTO_DISCOVERY_DETAIL_ATTEMPTS = Number(
  process.env.AUTO_DISCOVERY_DETAIL_ATTEMPTS ||
  APP_CONFIG.auto_discovery_detail_attempts ||
  80
);
const AUTO_DISCOVERY_CANDIDATE_LIMIT = Number(
  process.env.AUTO_DISCOVERY_CANDIDATE_LIMIT ||
  APP_CONFIG.auto_discovery_candidate_limit ||
  300
);
const AUTO_DISCOVERY_MAX_SUPPLIER_PRICE = Number(
  process.env.AUTO_DISCOVERY_MAX_SUPPLIER_PRICE ||
  APP_CONFIG.auto_discovery_max_supplier_price ||
  40
);
const AUTO_DISCOVERY_MAX_DELIVERY_DAYS = Number(
  process.env.AUTO_DISCOVERY_MAX_DELIVERY_DAYS ||
  APP_CONFIG.auto_discovery_max_delivery_days ||
  18
);

const COMMON_COLORS = [
  'Black','Blue','Brown','Gray','Grey','Green','Beige','White','Red','Pink',
  'Purple','Yellow','Orange','Tan','Navy','Olive','Burgundy','Gold','Silver',
  'Cream','Ivory','Khaki','Teal','Charcoal','Turquoise','Multicolor'
];

const SHELL_FROM_TITLE = {
  denim:'Denim', leather:'Leather', wool:'Wool', polyester:'Polyester',
  nylon:'Nylon', suede:'Suede', cotton:'Cotton', corduroy:'Corduroy',
  canvas:'Canvas', down:'Down', fleece:'Fleece', shell:'Polyester'
};

const CLOTHING_CATEGORY_IDS = new Set(['57988','11484','1059']);

fs.mkdirSync(DATA_DIR, { recursive: true });
ensureState();

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (process.env[key] == null) process.env[key] = value;
  }
}

function loadJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn('Could not read config.json:', error.message);
    return {};
  }
}

function normSpace(v) {
  return String(v ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function median(values) {
  const n = values.map(Number).filter(Number.isFinite).sort((a,b) => a-b);
  if (!n.length) return null;
  const m = Math.floor(n.length / 2);
  return n.length % 2 ? n[m] : (n[m-1] + n[m]) / 2;
}

function xmlEscape(v) {
  return String(v ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');
}

function cdataSafe(v) {
  return String(v ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
}

function stripHtml(v) {
  return String(v || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function ensureState() {
  if (!fs.existsSync(STATE_PATH)) {
    writeState({
      aliexpress_auth: null,
      posted: {},
      worker: { last_run: null },
      product_manager: { last_run: null, running: false, last_action: '', last_error: '', active_count: 0, managed_count: 0, open_orders: 0 },
      fulfillments: {}
    });
  }
}

function readState() {
  ensureState();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    parsed.posted ||= {};
    parsed.worker ||= { last_run: null };
    parsed.product_manager ||= { last_run: null, running: false, last_action: '', last_error: '', active_count: 0, managed_count: 0, open_orders: 0 };
    parsed.fulfillments ||= {};
    return parsed;
  } catch {
    const fresh = {
      aliexpress_auth: null,
      posted: {},
      worker: { last_run: null },
      product_manager: { last_run: null, running: false, last_action: '', last_error: '', active_count: 0, managed_count: 0, open_orders: 0 },
      fulfillments: {}
    };
    writeState(fresh);
    return fresh;
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function saveAliExpressTokens(tokenData) {
  const state = readState();
  const existing = state.aliexpress_auth || {};
  state.aliexpress_auth = {
    ...existing,
    ...tokenData,
    access_token: tokenData.access_token || existing.access_token || '',
    refresh_token: tokenData.refresh_token || existing.refresh_token || '',
    updated_at: Math.floor(Date.now() / 1000)
  };
  writeState(state);
  console.log('AliExpress tokens saved to data/state.json');
}

function getAliExpressTokens() {
  return readState().aliexpress_auth || null;
}

function wasPosted(productId) {
  return Boolean(readState().posted?.[String(productId)]);
}

function markPosted(productId, ebayItemId = '', metadata = {}) {
  if (!productId) return;
  const state = readState();
  const prior = state.posted[String(productId)] || {};
  state.posted[String(productId)] = {
    ...prior,
    ...metadata,
    ebay_item_id: String(ebayItemId || prior.ebay_item_id || ''),
    posted_at: prior.posted_at || Math.floor(Date.now() / 1000)
  };
  writeState(state);
}

function assertAliExpressSecrets() {
  const missing = [];
  if (!ALIEXPRESS_APP_KEY) missing.push('ALIEXPRESS_APP_KEY');
  if (!ALIEXPRESS_APP_SECRET) missing.push('ALIEXPRESS_APP_SECRET');
  if (missing.length) {
    throw new Error('Missing AliExpress environment variable(s): ' + missing.join(', '));
  }
}

function assertEbayBrowseSecrets() {
  const missing = [];
  if (!EBAY_CONFIG.app_id) missing.push('EBAY_APP_ID');
  if (!EBAY_CONFIG.cert_id) missing.push('EBAY_CERT_ID');
  if (missing.length) {
    throw new Error('Missing eBay environment variable(s): ' + missing.join(', '));
  }
}

function assertEbayListingSecrets() {
  const missing = [];
  if (!EBAY_CONFIG.app_id) missing.push('EBAY_APP_ID');
  if (!EBAY_CONFIG.dev_id) missing.push('EBAY_DEV_ID');
  if (!EBAY_CONFIG.cert_id) missing.push('EBAY_CERT_ID');
  if (!EBAY_CONFIG.user_token) missing.push('EBAY_USER_TOKEN');
  if (missing.length) {
    throw new Error('Missing eBay listing environment variable(s): ' + missing.join(', '));
  }
}

function extractAliExpressProductId(input) {
  const text = String(input || '').trim();
  if (/^\d+$/.test(text)) return text;

  const match =
    text.match(/\/item\/(\d+)\.html/i) ||
    text.match(/[?&](?:productId|product_id)=(\d+)/i);

  if (match) return match[1];
  throw new Error('Could not find an AliExpress product ID in that URL.');
}

function aliExpressPathSign(apiPath, params) {
  const sorted = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] != null)
    .sort();

  const parameterString = sorted
    .map(k => `${k}${params[k]}`)
    .join('');

  return crypto
    .createHmac('sha256', ALIEXPRESS_APP_SECRET)
    .update(apiPath + parameterString, 'utf8')
    .digest('hex')
    .toUpperCase();
}

function aliExpressTopSign(params) {
  const sorted = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] != null)
    .sort();

  const parameterString = sorted
    .map(k => `${k}${params[k]}`)
    .join('');

  return crypto
    .createHmac('sha256', ALIEXPRESS_APP_SECRET)
    .update(parameterString, 'utf8')
    .digest('hex')
    .toUpperCase();
}

async function createAliExpressToken(code) {
  assertAliExpressSecrets();

  const apiPath = '/auth/token/create';
  const params = {
    app_key: ALIEXPRESS_APP_KEY,
    sign_method: 'sha256',
    timestamp: Date.now().toString(),
    method: apiPath,
    format: 'json',
    code
  };

  params.sign = aliExpressPathSign(apiPath, params);

  const response = await fetch(
    'https://api-sg.aliexpress.com/rest/auth/token/create',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(params)
    }
  );

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('AliExpress token response was not JSON: ' + text.slice(0,500)); }

  if (!response.ok) {
    throw new Error(`AliExpress token HTTP ${response.status}: ${text.slice(0,500)}`);
  }

  if (data.code && String(data.code) !== '0') {
    throw new Error(`AliExpress token error ${data.code}: ${data.message || text.slice(0,500)}`);
  }

  if (!data.access_token) {
    throw new Error('AliExpress did not return access_token: ' + JSON.stringify(data));
  }

  saveAliExpressTokens(data);
  return data;
}

async function refreshAliExpressToken() {
  assertAliExpressSecrets();
  const saved = getAliExpressTokens();

  if (!saved?.refresh_token) {
    throw new Error('No AliExpress refresh token is stored. Authorize AliExpress again.');
  }

  const apiPath = '/auth/token/refresh';
  const params = {
    app_key: ALIEXPRESS_APP_KEY,
    sign_method: 'sha256',
    timestamp: Date.now().toString(),
    method: apiPath,
    format: 'json',
    refresh_token: saved.refresh_token
  };

  params.sign = aliExpressPathSign(apiPath, params);

  const response = await fetch(
    'https://api-sg.aliexpress.com/rest/auth/token/refresh',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(params)
    }
  );

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('AliExpress refresh response was not JSON: ' + text.slice(0,500)); }

  if (!response.ok) {
    throw new Error(`AliExpress refresh HTTP ${response.status}: ${text.slice(0,500)}`);
  }

  if (data.code && String(data.code) !== '0') {
    throw new Error(`AliExpress refresh error ${data.code}: ${data.message || text.slice(0,500)}`);
  }

  if (!data.access_token) {
    throw new Error('AliExpress refresh did not return access_token: ' + JSON.stringify(data));
  }

  saveAliExpressTokens(data);
  console.log('AliExpress access token refreshed.');
  return data;
}

async function getValidAliExpressAccessToken() {
  const saved = getAliExpressTokens();
  if (!saved?.access_token) {
    throw new Error('AliExpress is not authorized yet.');
  }

  let expiration = Number(saved.expire_time || 0);

  if (!expiration && saved.updated_at && saved.expires_in) {
    expiration =
      Number(saved.updated_at) * 1000 +
      Number(saved.expires_in) * 1000;
  }

  if (expiration && Date.now() >= expiration - (30 * 60 * 1000)) {
    console.log('AliExpress token is expiring soon. Refreshing...');
    const refreshed = await refreshAliExpressToken();
    return refreshed.access_token;
  }

  return saved.access_token;
}

async function aliExpressGetProduct(productInput) {
  assertAliExpressSecrets();

  const productId = extractAliExpressProductId(productInput);
  const accessToken = await getValidAliExpressAccessToken();

  const params = {
    app_key: ALIEXPRESS_APP_KEY,
    sign_method: 'sha256',
    timestamp: Date.now().toString(),
    method: 'aliexpress.ds.product.get',
    format: 'json',
    v: '2.0',
    session: accessToken,
    product_id: productId,
    target_currency: 'USD',
    target_language: 'EN',
    ship_to_country: 'US',
    remove_personal_benefit: 'true'
  };

  params.sign = aliExpressTopSign(params);

  const response = await fetch(
    `https://api-sg.aliexpress.com/sync?${new URLSearchParams(params).toString()}`
  );

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      'AliExpress product response was not JSON: ' +
      responseText.slice(0, 500)
    );
  }

  try {
    const safeCopy = JSON.parse(JSON.stringify(data));

    function redact(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const key of Object.keys(obj)) {
        if (/access_token|refresh_token|session|app_secret|secret/i.test(key)) {
          obj[key] = '[REDACTED]';
        } else {
          redact(obj[key]);
        }
      }
    }

    redact(safeCopy);

    fs.writeFileSync(
      ALI_DEBUG_PATH,
      JSON.stringify(safeCopy, null, 2),
      'utf8'
    );
  } catch (error) {
    console.warn(
      'Could not save AliExpress debug response:',
      error.message
    );
  }

  if (!response.ok) {
    throw new Error(
      `AliExpress product HTTP ${response.status}: ` +
      responseText.slice(0, 500)
    );
  }

  const topError = data?.error_response;
  const wrapper = data?.aliexpress_ds_product_get_response;

  const wrapperRspCode =
    wrapper?.rsp_code != null
      ? String(wrapper.rsp_code)
      : '';

  const wrapperRspMessage =
    String(wrapper?.rsp_msg || '');

  const topErrorCode = String(
    topError?.code ??
    topError?.sub_code ??
    ''
  );

  const topErrorMessage = String(
    topError?.sub_msg ||
    topError?.msg ||
    ''
  );

  const wrapperSucceeded =
    !wrapperRspCode ||
    wrapperRspCode === '0' ||
    wrapperRspCode === '200';

  const errorCode =
    topErrorCode ||
    (wrapperSucceeded ? '' : wrapperRspCode);

  const errorMessage =
    topErrorMessage ||
    (errorCode ? wrapperRspMessage : '');

  if (
    errorCode === '482' ||
    /SHIP_TO_COUNTRY_PROHIBITED/i.test(errorMessage)
  ) {
    throw new Error(
      'This AliExpress product is not available for dropshipping to the United States. ' +
      'Choose a different product that supports US delivery.'
    );
  }

  if (errorCode) {
    throw new Error(
      `AliExpress product error ${errorCode}: ` +
      (errorMessage || 'Unknown AliExpress error')
    );
  }

  const normalized =
    normalizeAliExpressProduct(data, productId);

  if (
    !normalized.title &&
    !normalized.variants.length &&
    !normalized.images.length
  ) {
    throw new Error(
      'AliExpress returned no usable product data for ' +
      productId +
      '. Check data/aliexpress-last-product-response.json.'
    );
  }

  console.log(
    `AliExpress product ${productId}: ` +
    `title=${normalized.title ? 'yes' : 'no'}, ` +
    `variants=${normalized.variants.length}, ` +
    `images=${normalized.images.length}, ` +
    `store=${normalized.store?.name || 'none'}`
  );

  return {
    productId,
    data,
    normalized
  };
}

function parseNestedJson(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  const looksJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));

  if (!looksJson) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function unwrapCollection(value, preferredKeys = []) {
  const parsed = parseNestedJson(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed == null) return [];

  if (typeof parsed === 'object') {
    for (const key of preferredKeys) {
      if (parsed[key] != null) {
        return unwrapCollection(parsed[key], preferredKeys);
      }
    }

    // Some TOP/GOP responses use an unpredictable single wrapper key.
    const values = Object.values(parsed);
    if (values.length === 1) {
      const only = parseNestedJson(values[0]);
      if (Array.isArray(only)) return only;
    }
  }

  return [parsed];
}

function firstMeaningful(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function numericValue(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}


function countryNameToCode(value) {
  const raw = normSpace(value);
  const key = raw.toLowerCase();

  const exact = {
    'us':'US',
    'usa':'US',
    'u.s.':'US',
    'u.s.a.':'US',
    'united states':'US',
    'united states of america':'US',

    'cn':'CN',
    'china':'CN',
    'mainland china':'CN',

    'gb':'GB',
    'uk':'GB',
    'united kingdom':'GB',
    'great britain':'GB',

    'ca':'CA',
    'canada':'CA',

    'au':'AU',
    'australia':'AU',

    'de':'DE',
    'germany':'DE',

    'fr':'FR',
    'france':'FR',

    'es':'ES',
    'spain':'ES',

    'it':'IT',
    'italy':'IT',

    'pl':'PL',
    'poland':'PL',

    'cz':'CZ',
    'czechia':'CZ',
    'czech republic':'CZ',

    'tr':'TR',
    'turkey':'TR',
    'türkiye':'TR',

    'mx':'MX',
    'mexico':'MX',

    'br':'BR',
    'brazil':'BR',

    'ru':'RU',
    'russia':'RU',
    'russian federation':'RU',

    'kr':'KR',
    'south korea':'KR',
    'korea':'KR',

    'jp':'JP',
    'japan':'JP',

    'sg':'SG',
    'singapore':'SG',

    'hk':'HK',
    'hong kong':'HK'
  };

  if (exact[key]) return exact[key];

  if (/^[a-z]{2}$/i.test(raw)) {
    return raw.toUpperCase();
  }

  return '';
}

function normalizeLocationName(value) {
  const raw = normSpace(value);

  const map = {
    'Mainland China':'China',
    'United States of America':'United States',
    'USA':'United States',
    'U.S.A.':'United States',
    'UK':'United Kingdom'
  };

  return map[raw] || raw;
}

function shipFromFromSkuProperties(skuProps) {
  for (const prop of skuProps || []) {
    const propertyName = normSpace(
      prop?.sku_property_name ||
      prop?.property_name ||
      prop?.attr_name ||
      prop?.name ||
      ''
    );

    if (!/(ships?\s*from|ship\s*from|warehouse)/i.test(propertyName)) {
      continue;
    }

    const location = normalizeLocationName(
      prop?.property_value_definition_name ||
      prop?.sku_property_value ||
      prop?.attr_value ||
      prop?.value ||
      ''
    );

    if (!location) continue;

    return {
      countryCode: countryNameToCode(location),
      location,
      postalCode: '',
      source: `AliExpress variant field: ${propertyName}`,
      confidence: 'high',
      requiresConfirmation: false
    };
  }

  return null;
}

function productShipFromCandidate(properties, store) {
  for (const [name, rawValue] of Object.entries(properties || {})) {
    if (!/(ships?\s*from|ship\s*from|warehouse)/i.test(name)) continue;

    const location = normalizeLocationName(rawValue);

    if (!location) continue;

    return {
      countryCode: countryNameToCode(location),
      location,
      postalCode: '',
      source: `AliExpress product field: ${name}`,
      confidence: 'high',
      requiresConfirmation: false
    };
  }

  // Product "Origin" usually means manufacturing origin, not necessarily warehouse location.
  // It is useful as a candidate only and must be confirmed before listing.
  for (const [name, rawValue] of Object.entries(properties || {})) {
    if (!/^origin$/i.test(name)) continue;

    const location = normalizeLocationName(rawValue);

    if (!location) continue;

    return {
      countryCode: countryNameToCode(location),
      location,
      postalCode: '',
      source: 'AliExpress product Origin (candidate only)',
      confidence: 'low',
      requiresConfirmation: true
    };
  }

  const storeCountry = normalizeLocationName(store?.country || '');

  if (storeCountry) {
    return {
      countryCode: countryNameToCode(storeCountry),
      location: storeCountry,
      postalCode: '',
      source: 'AliExpress store country (candidate only)',
      confidence: 'low',
      requiresConfirmation: true
    };
  }

  return {
    countryCode: '',
    location: '',
    postalCode: '',
    source: 'No reliable ship-from location returned by AliExpress',
    confidence: 'unknown',
    requiresConfirmation: true
  };
}

function defaultShippingServiceForCountry(countryCode, deliveryDays = null) {
  const country = String(countryCode || '').toUpperCase();

  if (country === 'US') {
    return 'USPSGroundAdvantage';
  }

  const days = Number(deliveryDays);

  if (Number.isFinite(days) && days > 0 && days <= 5) {
    return 'ExpeditedShippingFromOutsideUS';
  }

  if (Number.isFinite(days) && days > 0 && days <= 12) {
    return 'StandardShippingFromOutsideUS';
  }

  return 'EconomyShippingFromOutsideUS';
}

function normalizeAliExpressProduct(apiData, fallbackProductId = '') {
  const top = parseNestedJson(apiData) || {};

  const wrapper = parseNestedJson(
    top?.aliexpress_ds_product_get_response ??
    top?.result?.aliexpress_ds_product_get_response ??
    top?.data?.aliexpress_ds_product_get_response ??
    top
  ) || {};

  let result = parseNestedJson(
    wrapper?.result ??
    wrapper?.data ??
    top?.result ??
    top?.data ??
    wrapper
  ) || {};

  // Occasionally result itself is nested one level deeper.
  if (result?.result && typeof result.result === 'object') {
    const nested = parseNestedJson(result.result);
    if (nested && (
      nested.ae_item_base_info_dto ||
      nested.ae_item_sku_info_dtos ||
      nested.ae_multimedia_info_dto
    )) result = nested;
  }

  const base = parseNestedJson(
    firstMeaningful(
      result?.ae_item_base_info_dto,
      result?.item_base_info,
      result?.base_info,
      result?.product_info
    )
  ) || {};

  const multimedia = parseNestedJson(
    firstMeaningful(
      result?.ae_multimedia_info_dto,
      result?.multimedia_info,
      result?.multimedia
    )
  ) || {};

  const logistics = parseNestedJson(
    firstMeaningful(
      result?.logistics_info_dto,
      result?.logistics_info,
      result?.logistics
    )
  ) || {};

  const propertiesRaw = unwrapCollection(
    firstMeaningful(
      result?.ae_item_properties,
      result?.item_properties,
      result?.properties
    ),
    ['ae_item_property','item_property','property','properties']
  );

  const skus = unwrapCollection(
    firstMeaningful(
      result?.ae_item_sku_info_dtos,
      result?.ae_item_sku_info_d_t_os,
      result?.sku_info_dtos,
      result?.skus
    ),
    ['ae_item_sku_info_d_t_o','ae_item_sku_info_dto','sku_info_dto','sku']
  ).filter(v => v && typeof v === 'object');

  const rawImages = firstMeaningful(
    multimedia?.image_urls,
    multimedia?.image_url,
    result?.image_urls,
    base?.image_urls,
    ''
  );

  let images = [];
  if (Array.isArray(rawImages)) {
    images = rawImages.map(String);
  } else if (rawImages && typeof rawImages === 'object') {
    images = Object.values(rawImages).flatMap(v => Array.isArray(v) ? v : [v]).map(String);
  } else {
    images = String(rawImages || '')
      .split(/[;,|]/)
      .map(x => x.trim());
  }
  images = [...new Set(images.filter(x => /^https?:\/\//i.test(x)))];

  const properties = {};
  for (const raw of propertiesRaw) {
    const p = parseNestedJson(raw) || {};
    const name = normSpace(firstMeaningful(
      p?.attr_name,
      p?.property_name,
      p?.name
    ));
    const value = normSpace(firstMeaningful(
      p?.attr_value,
      p?.property_value,
      p?.value
    ));
    if (name && value) properties[name] = value;
  }

  const variants = skus.map((rawSku, index) => {
    const sku = parseNestedJson(rawSku) || {};

    const skuProps = unwrapCollection(
      firstMeaningful(
        sku?.ae_sku_property_dtos,
        sku?.aeop_s_k_u_propertys,
        sku?.aeop_sku_propertys,
        sku?.sku_property_dtos,
        sku?.sku_properties
      ),
      ['ae_sku_property_d_t_o','ae_sku_property_dto','aeop_s_k_u_property','sku_property']
    ).filter(v => v && typeof v === 'object');

    const readable = skuProps
      .map(rawProp => {
        const prop = parseNestedJson(rawProp) || {};
        return normSpace(firstMeaningful(
          prop?.property_value_definition_name,
          prop?.sku_property_value,
          prop?.property_value,
          prop?.value
        ));
      })
      .filter(Boolean);

    const supplierPrice = numericValue(
      sku?.offer_sale_price,
      sku?.offer_bulk_sale_price,
      sku?.sale_price,
      sku?.sku_price,
      sku?.price
    );

    const regularPrice = numericValue(
      sku?.sku_price,
      sku?.regular_price,
      sku?.price
    );

    let stock = numericValue(
      sku?.sku_available_stock,
      sku?.s_k_u_available_stock,
      sku?.ipm_sku_stock,
      sku?.available_stock,
      sku?.stock
    );

    if (!stock && sku?.sku_stock === true) stock = 1;

    const skuImage = firstMeaningful(
      ...skuProps.map(rawProp => parseNestedJson(rawProp)?.sku_image),
      sku?.sku_image,
      images[0],
      ''
    );

    const explicitShipFrom = shipFromFromSkuProperties(skuProps);

    const id = String(firstMeaningful(
      sku?.id,
      sku?.sku_attr,
      sku?.sku_id,
      sku?.sku_code,
      ''
    ));

    return {
      index,
      skuId: String(firstMeaningful(sku?.sku_id, sku?.sku_code, sku?.id, '')),
      id,
      skuAttr: String(firstMeaningful(sku?.sku_attr, sku?.id, '')),
      label:
        readable.join(' / ') ||
        normSpace(id) ||
        `Variant ${index + 1}`,
      supplierPrice,
      regularPrice,
      stock,
      inStock: sku?.sku_stock == null ? stock > 0 : Boolean(sku.sku_stock),
      currency: String(firstMeaningful(
        sku?.currency_code,
        base?.currency_code,
        'USD'
      )),
      image: String(skuImage || ''),
      shipFrom: explicitShipFrom
    };
  });

  // Some products expose only one top-level price and no SKU array.
  if (!variants.length) {
    const basePrice = numericValue(
      result?.offer_sale_price,
      result?.sale_price,
      result?.sku_price,
      base?.product_price,
      base?.sale_price,
      base?.price
    );

    if (basePrice > 0) {
      variants.push({
        index:0,
        skuId:'',
        id:'',
        skuAttr:'',
        label:'Default',
        supplierPrice:basePrice,
        regularPrice:basePrice,
        stock:numericValue(result?.available_stock, result?.stock),
        inStock:true,
        currency:String(base?.currency_code || 'USD'),
        image:images[0] || '',
        shipFrom:null
      });
    }
  }

  const rawStore = parseNestedJson(
    firstMeaningful(
      result?.ae_store_info,
      result?.store_info,
      result?.store
    )
  ) || {};

  const store = {
    id: String(firstMeaningful(rawStore?.store_id, rawStore?.id, '')),
    name: String(firstMeaningful(rawStore?.store_name, rawStore?.name, '')),
    country: String(firstMeaningful(
      rawStore?.store_country_code,
      rawStore?.country_code,
      rawStore?.country,
      ''
    )),
    shippingRating: String(firstMeaningful(rawStore?.shipping_speed_rating, '')),
    communicationRating: String(firstMeaningful(rawStore?.communication_rating, '')),
    describedRating: String(firstMeaningful(rawStore?.item_as_described_rating, ''))
  };

  const productShipFrom = productShipFromCandidate(properties, store);

  const converter = parseNestedJson(result?.product_id_converter_result) || {};
  const resolvedProductId = String(firstMeaningful(
    base?.product_id,
    result?.product_id,
    converter?.main_product_id,
    fallbackProductId,
    ''
  ));

  const title = normSpace(firstMeaningful(
    base?.subject,
    base?.title,
    result?.subject,
    result?.title,
    ''
  ));

  const descriptionHtml = String(firstMeaningful(
    base?.detail,
    result?.detail,
    base?.mobile_detail,
    ''
  ));

  return {
    productId: resolvedProductId,
    title,
    descriptionHtml,
    descriptionText: stripHtml(descriptionHtml || base?.mobile_detail || ''),
    categoryId: String(firstMeaningful(base?.category_id, result?.category_id, '')),
    currency: String(firstMeaningful(base?.currency_code, variants[0]?.currency, 'USD')),
    salesCount: String(firstMeaningful(
      base?.sales_count,
      base?.orders,
      base?.evaluation_count,
      result?.sales_count,
      ''
    )),
    rating: String(firstMeaningful(base?.avg_evaluation_rating, result?.rating, '')),
    status: String(firstMeaningful(base?.product_status_type, result?.product_status_type, '')),
    deliveryDays: numericValue(
      logistics?.delivery_time,
      logistics?.delivery_days,
      logistics?.estimated_delivery_time
    ) || null,
    shipToCountry: String(firstMeaningful(
      logistics?.ship_to_country,
      logistics?.country_code,
      ''
    )),
    images,
    variants,
    properties,
    store,
    shipFrom: productShipFrom,
    alreadyPosted: wasPosted(resolvedProductId || fallbackProductId),
    debug: {
      wrapperKeys: Object.keys(wrapper || {}),
      resultKeys: Object.keys(result || {}),
      skuCount: skus.length,
      propertyCount: propertiesRaw.length
    }
  };
}


async function ebayGetOauthToken() {
  assertEbayBrowseSecrets();

  const basic = Buffer
    .from(`${EBAY_CONFIG.app_id}:${EBAY_CONFIG.cert_id}`)
    .toString('base64');

  const response = await fetch(
    'https://api.ebay.com/identity/v1/oauth2/token',
    {
      method: 'POST',
      headers: {
        'Content-Type':'application/x-www-form-urlencoded',
        Authorization:`Basic ${basic}`
      },
      body: new URLSearchParams({
        grant_type:'client_credentials',
        scope:'https://api.ebay.com/oauth/api_scope'
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `eBay OAuth ${response.status}: ${(await response.text()).slice(0,400)}`
    );
  }

  return (await response.json()).access_token;
}


async function ebaySuggestCategory(query) {
  const title = normSpace(query);
  if (!title) return null;

  const token = await ebayGetOauthToken();
  const headers = {
    Authorization:`Bearer ${token}`,
    'Accept':'application/json'
  };

  const treeResponse = await fetch(
    'https://api.ebay.com/commerce/taxonomy/v1_beta/get_default_category_tree_id?marketplace_id=EBAY_US',
    { headers }
  );

  if (!treeResponse.ok) {
    throw new Error(
      `eBay taxonomy tree ${treeResponse.status}: ${(await treeResponse.text()).slice(0,400)}`
    );
  }

  const tree = await treeResponse.json();
  const treeId = String(tree.categoryTreeId || '0');

  const suggestionResponse = await fetch(
    `https://api.ebay.com/commerce/taxonomy/v1_beta/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions?q=${encodeURIComponent(title.slice(0,350))}`,
    { headers }
  );

  if (!suggestionResponse.ok) {
    throw new Error(
      `eBay category suggestions ${suggestionResponse.status}: ${(await suggestionResponse.text()).slice(0,400)}`
    );
  }

  const data = await suggestionResponse.json();
  const first = data?.categorySuggestions?.[0]?.category;

  if (!first?.categoryId) return null;

  return {
    id:String(first.categoryId),
    name:String(first.categoryName || 'Suggested')
  };
}

const AUTO_PRODUCT_ALLOW_TERMS = [
  'cosmetic','makeup','beauty','perfume','atomizer','spray bottle','refillable bottle',
  'skincare','skin care','face roller','facial','self care','self-care','mirror','comb','hair brush',
  'manicure','nail file','nail brush','makeup brush','cosmetic bag','toiletry','travel bottle',
  'toy','puzzle','building block','fidget','plush','doll','educational','craft','sticker',
  'bookmark','notebook','journal','book','stationery','pen','pencil','school supplies','office supplies',
  'screwdriver','wrench','pliers','tape measure','measuring tape','hex key','tool set','hand tool',
  'cleaning brush','organizer','storage box','case','holder','container','keychain','clip','hook',
  'kitchen tool','spoon','spatula','bottle opener','brush','scrubber','travel','accessory'
];

const AUTO_PRODUCT_BLOCK_TERMS = [
  'knife','blade','machete','weapon','gun','rifle','pistol','ammo','ammunition','taser','pepper spray',
  'vape','cigarette','nicotine','tobacco','cbd','thc','cannabis','steroid','hormone','supplement',
  'medicine','medication','pill','tablet','syringe','needle','sex toy','adult toy','porn','lingerie',
  'laser pointer','firework','explosive','poison','pesticide','chainsaw','crossbow','slingshot',
  'tattoo gun','tattoo machine','medical device','blood pressure','glucose meter'
];

const AUTO_PRODUCT_COMPLEX_TERMS = [
  'smartphone','mobile phone','tablet pc','laptop','computer','graphics card','motherboard','camera',
  'drone','smart watch','smartwatch','projector','monitor','printer','router','car radio','dash cam',
  'power station','solar panel','electric scooter','ebike','e-bike','motorcycle','engine','transmission',
  'wedding dress','formal dress','shoes','sneakers','jacket','coat','jeans'
];

function productText(product) {
  return normSpace([
    product?.product_title,
    product?.title,
    product?.first_level_category_name,
    product?.second_level_category_name
  ].filter(Boolean).join(' ')).toLowerCase();
}

function productIsBlocked(product) {
  const haystack = productText(product);
  return AUTO_PRODUCT_BLOCK_TERMS.some(term => haystack.includes(term)) ||
    AUTO_PRODUCT_COMPLEX_TERMS.some(term => haystack.includes(term));
}

function productPreferenceScore(product) {
  const haystack = productText(product);
  let score = 0;

  for (const term of AUTO_PRODUCT_ALLOW_TERMS) {
    if (haystack.includes(term)) score += 25;
  }

  const volume = Number(product?.lastest_volume || product?.sales_count || 0);
  if (Number.isFinite(volume) && volume > 0) score += Math.min(40, Math.log10(volume + 1) * 12);

  const rating = Number(String(product?.evaluate_rate || product?.rating || '').replace('%',''));
  if (Number.isFinite(rating) && rating > 0) score += Math.max(0, Math.min(20, (rating - 80)));

  const price = Number(
    product?.target_sale_price ?? product?.sale_price ??
    product?.target_original_price ?? product?.original_price
  );
  if (Number.isFinite(price) && price >= 1 && price <= 20) score += 15;
  else if (Number.isFinite(price) && price <= AUTO_DISCOVERY_MAX_SUPPLIER_PRICE) score += 5;

  return score;
}

// Feed records often do NOT contain a product title. Therefore this function must
// never require a title when it is evaluating a recommendation-feed candidate.
function feedCandidateLooksUsable(product) {
  const productId = String(product?.product_id || '');
  if (!productId) return false;
  if (productIsBlocked(product)) return false;

  const price = Number(
    product?.target_sale_price ?? product?.sale_price ??
    product?.target_original_price ?? product?.original_price
  );
  if (Number.isFinite(price) && price > 0 && (price < 0.50 || price > AUTO_DISCOVERY_MAX_SUPPLIER_PRICE)) {
    return false;
  }

  const rating = Number(String(product?.evaluate_rate || '').replace('%',''));
  if (Number.isFinite(rating) && rating > 0 && rating < 75) return false;

  return true;
}

function loadedProductLooksReasonable(product) {
  const title = normSpace(product?.title || '');
  if (!title) return false;
  if (productIsBlocked({ product_title:title })) return false;

  const variants = (product?.variants || []).filter(v =>
    Number(v?.stock || 0) > 0 && Number(v?.supplierPrice || 0) > 0
  );
  if (!variants.length) return false;

  const cheapest = Math.min(...variants.map(v => Number(v.supplierPrice)));
  if (!Number.isFinite(cheapest) || cheapest < 0.50 || cheapest > AUTO_DISCOVERY_MAX_SUPPLIER_PRICE) return false;

  const days = Number(product?.deliveryDays || 0);
  if (Number.isFinite(days) && days > 0 && days > AUTO_DISCOVERY_MAX_DELIVERY_DAYS) return false;

  return Boolean(product?.images?.length);
}

async function aliExpressRecommendedFeed(pageNo = 1, sort = 'volumeDesc') {
  assertAliExpressSecrets();
  const accessToken = await getValidAliExpressAccessToken();

  const params = {
    app_key: ALIEXPRESS_APP_KEY,
    sign_method:'sha256',
    timestamp:Date.now().toString(),
    method:'aliexpress.ds.recommend.feed.get',
    format:'json',
    v:'2.0',
    session:accessToken,
    country:'US',
    target_currency:'USD',
    target_language:'EN',
    page_size:'50',
    page_no:String(Math.max(1, Number(pageNo) || 1)),
    sort,
    feed_name:'DS bestseller'
  };

  params.sign = aliExpressTopSign(params);

  const response = await fetch(
    `https://api-sg.aliexpress.com/sync?${new URLSearchParams(params).toString()}`
  );

  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('AliExpress recommendation response was not JSON: ' + raw.slice(0,500)); }

  if (!response.ok) {
    throw new Error(`AliExpress recommendation HTTP ${response.status}: ${raw.slice(0,500)}`);
  }

  const wrapper = data?.aliexpress_ds_recommend_feed_get_response || {};
  const rspCode = String(wrapper?.rsp_code ?? '');
  if (rspCode && rspCode !== '0' && rspCode !== '200') {
    throw new Error(`AliExpress recommendation error ${rspCode}: ${wrapper?.rsp_msg || 'Unknown error'}`);
  }

  const products = unwrapCollection(
    wrapper?.result?.products,
    ['integer','product','products']
  ).filter(v => v && typeof v === 'object');

  return {
    products,
    pageNo:Number(wrapper?.result?.current_page_no || pageNo || 1),
    totalPages:Number(wrapper?.result?.total_page_no || 0),
    totalRecords:Number(wrapper?.result?.total_record_count || 0),
    isFinished:Boolean(wrapper?.result?.is_finished)
  };
}

function rotateArray(items, offset) {
  if (!items.length) return items;
  const n = ((Number(offset) || 0) % items.length + items.length) % items.length;
  return items.slice(n).concat(items.slice(0,n));
}

async function discoverAndLoadAliExpressProduct(log = () => {}) {
  const state = readState();
  state.product_manager ||= {};
  state.product_manager.discovery ||= {};

  const maxPages = Math.max(1, Math.min(10, AUTO_DISCOVERY_FEED_PAGES));
  const startPage = Math.max(1, Math.min(maxPages, Number(state.product_manager.discovery.next_page || 1)));
  const pageOrder = rotateArray(Array.from({length:maxPages}, (_,i) => i + 1), startPage - 1);
  const sorts = ['volumeDesc','priceAsc'];

  const byId = new Map();
  let rawFeedCount = 0;
  let feedRejected = 0;
  let feedErrors = 0;

  log(`Searching AliExpress DS bestseller feed (up to ${maxPages} pages, ${AUTO_DISCOVERY_DETAIL_ATTEMPTS} detailed checks).`);

  for (const sort of sorts) {
    for (const page of pageOrder) {
      if (byId.size >= AUTO_DISCOVERY_CANDIDATE_LIMIT) break;
      try {
        const feed = await aliExpressRecommendedFeed(page, sort);
        rawFeedCount += feed.products.length;
        log(`AliExpress feed ${sort} page ${page}: ${feed.products.length} product record(s).`);

        for (const product of feed.products) {
          const productId = String(product?.product_id || '');
          if (!productId || byId.has(productId) || wasPosted(productId)) continue;
          if (!feedCandidateLooksUsable(product)) {
            feedRejected++;
            continue;
          }
          byId.set(productId, product);
          if (byId.size >= AUTO_DISCOVERY_CANDIDATE_LIMIT) break;
        }
      } catch (error) {
        feedErrors++;
        log(`AliExpress feed ${sort} page ${page} failed: ${error.message}`);
      }
    }
    if (byId.size >= AUTO_DISCOVERY_CANDIDATE_LIMIT) break;
  }

  state.product_manager.discovery.next_page = (startPage % maxPages) + 1;
  state.product_manager.discovery.last_feed_records = rawFeedCount;
  state.product_manager.discovery.last_candidates = byId.size;
  state.product_manager.discovery.last_feed_rejected = feedRejected;
  state.product_manager.discovery.last_run = Date.now();
  writeState(state);

  if (!byId.size) {
    throw new Error(
      `AliExpress feed returned ${rawFeedCount} record(s), but 0 usable new product IDs remained ` +
      `(${feedRejected} filtered, ${feedErrors} feed error(s)).`
    );
  }

  const candidates = [...byId.values()].sort((a,b) => {
    const scoreDiff = productPreferenceScore(b) - productPreferenceScore(a);
    if (scoreDiff) return scoreDiff;
    return Number(b?.lastest_volume || 0) - Number(a?.lastest_volume || 0);
  });

  log(`${candidates.length} unique candidate product(s) survived the light feed filter.`);

  const failures = [];
  const skipCounts = {
    usProhibited:0,
    noStock:0,
    noImages:0,
    tooExpensive:0,
    slowDelivery:0,
    unsuitable:0,
    apiError:0,
    duplicate:0
  };

  let attempted = 0;
  for (const candidate of candidates) {
    if (attempted >= AUTO_DISCOVERY_DETAIL_ATTEMPTS) break;
    const productId = String(candidate?.product_id || '');
    if (!productId) continue;
    if (wasPosted(productId)) {
      skipCounts.duplicate++;
      continue;
    }

    attempted++;
    try {
      const loaded = await aliExpressGetProduct(productId);
      const p = loaded.normalized;
      const activeVariants = (p.variants || []).filter(v =>
        Number(v?.stock || 0) > 0 && Number(v?.supplierPrice || 0) > 0
      );

      if (!activeVariants.length) {
        skipCounts.noStock++;
        continue;
      }
      if (!p.images?.length) {
        skipCounts.noImages++;
        continue;
      }

      const cheapest = Math.min(...activeVariants.map(v => Number(v.supplierPrice || Infinity)));
      if (!Number.isFinite(cheapest) || cheapest > AUTO_DISCOVERY_MAX_SUPPLIER_PRICE) {
        skipCounts.tooExpensive++;
        continue;
      }
      if (Number(p.deliveryDays || 0) > AUTO_DISCOVERY_MAX_DELIVERY_DAYS) {
        skipCounts.slowDelivery++;
        continue;
      }
      if (!loadedProductLooksReasonable(p)) {
        skipCounts.unsuitable++;
        continue;
      }

      const verifiedShipFrom = activeVariants.find(v =>
        v?.shipFrom?.countryCode && !v.shipFrom.requiresConfirmation
      )?.shipFrom || (
        p?.shipFrom?.countryCode && !p.shipFrom.requiresConfirmation ? p.shipFrom : null
      );

      if (!verifiedShipFrom) {
        skipCounts.unsuitable++;
        failures.push(`${productId}: no verified ship-from location`);
        continue;
      }

      let categoryHint = null;
      try { categoryHint = await ebaySuggestCategory(p.title); }
      catch (error) { log(`eBay category suggestion for ${productId} failed: ${error.message}`); }

      log(
        `Qualified AliExpress product ${productId}: ${String(p.title).slice(0,70)} ` +
        `| $${cheapest.toFixed(2)} | ${activeVariants.length} in-stock variant(s) ` +
        `| ~${p.deliveryDays || '?'} day(s) to US.`
      );

      return {
        productUrl:String(candidate?.product_detail_url || `https://www.aliexpress.com/item/${productId}.html`),
        feedProduct:candidate,
        productId:loaded.productId,
        normalized:p,
        categoryHint,
        discoveryStats:{ rawFeedCount, candidates:candidates.length, attempted, skipCounts }
      };
    } catch (error) {
      const msg = String(error?.message || error);
      if (/SHIP_TO_COUNTRY_PROHIBITED|not available for dropshipping to the United States/i.test(msg)) {
        skipCounts.usProhibited++;
      } else {
        skipCounts.apiError++;
      }
      failures.push(`${productId}: ${msg}`);
      if (attempted <= 10 || attempted % 10 === 0) {
        log(`Candidate ${attempted} (${productId}) skipped: ${msg}`);
      }
    }
  }

  const summary = Object.entries(skipCounts)
    .filter(([,count]) => count)
    .map(([name,count]) => `${name}=${count}`)
    .join(', ');

  throw new Error(
    `No qualifying product after ${attempted} detailed AliExpress checks from ${candidates.length} candidates. ` +
    `Feed records=${rawFeedCount}. ${summary ? `Skips: ${summary}.` : ''}`
  );
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new Error('Invalid image data URL.');

  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';

  return {
    mime,
    buffer: isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
  };
}

async function ebaySearchByImageInput(image, limit = 50) {
  const token = await ebayGetOauthToken();

  let b64;

  if (image?.dataUrl) {
    b64 = parseDataUrl(image.dataUrl).buffer.toString('base64');
  } else if (image?.url) {
    const response = await fetch(image.url);
    if (!response.ok) {
      throw new Error(`Could not fetch image URL (${response.status}).`);
    }
    b64 = Buffer.from(await response.arrayBuffer()).toString('base64');
  } else {
    throw new Error('No image was supplied.');
  }

  const url =
    `https://api.ebay.com/buy/browse/v1/item_summary/search_by_image` +
    `?limit=${Math.max(1, Math.min(200, Number(limit) || 50))}` +
    `&fieldgroups=FULL`;

  const response = await fetch(url, {
    method:'POST',
    headers:{
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json',
      'X-EBAY-C-MARKETPLACE-ID':'EBAY_US'
    },
    body:JSON.stringify({ image:b64 })
  });

  if (!response.ok) {
    throw new Error(
      `eBay image search ${response.status}: ${(await response.text()).slice(0,400)}`
    );
  }

  return (await response.json()).itemSummaries || [];
}

function browseSpecificsToMap(item) {
  const out = {};
  for (const s of item?.itemSpecifics || []) {
    const name = normSpace(s?.name);
    const values = (s?.values || []).map(normSpace).filter(Boolean);
    if (name && values.length) out[name] = values;
  }
  return out;
}

function mergeSpecifics(...objects) {
  const out = {};
  for (const obj of objects) {
    for (const [k, raw] of Object.entries(obj || {})) {
      const values = Array.isArray(raw) ? raw : [raw];
      out[k] ||= [];
      for (const v of values) {
        if (v != null && !out[k].includes(v)) out[k].push(v);
      }
    }
  }
  return out;
}

function specificsXml(specifics) {
  return Object.entries(specifics || {})
    .map(([name, raw]) => {
      const values = Array.isArray(raw) ? raw : [raw];
      return (
        `<NameValueList><Name>${xmlEscape(name).slice(0,65)}</Name>` +
        values
          .filter(Boolean)
          .map(v => `<Value>${xmlEscape(String(v).slice(0,400))}</Value>`)
          .join('') +
        `</NameValueList>`
      );
    })
    .join('');
}

function canonicalAspectName(raw) {
  const text = normSpace(raw);
  const matched =
    text.match(/the item specific\s+(.+?)\s+is missing/i) ||
    text.match(/the item specific name\s+(.+?)\s+is too long/i);

  let name = normSpace(matched ? matched[1] : text)
    .replace(/(add .*|enter .*|then try again.*)$/i,'')
    .replace(/^[ .:\-]+|[ .:\-]+$/g,'');

  const lower = name.toLowerCase();
  const map = {
    'form factor':'Form Factor',
    'brand':'Brand',
    'model':'Model',
    'compatible brand':'Compatible Brand',
    'type':'Type',
    'microphone type':'Microphone Type',
    'size type':'Size Type',
    'outer shell material':'Outer Shell Material',
    'department':'Department',
    'size':'Size',
    'color':'Color',
    'style':'Style'
  };

  for (const [k,v] of Object.entries(map)) {
    if (lower.includes(k)) return v;
  }

  return name
    .split(/\s+/)
    .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
    .join(' ')
    .slice(0,65);
}

function defaultValueForAspect(name, title) {
  const t = String(title || '').toLowerCase();

  if (name === 'Form Factor') {
    if (t.includes('lavalier') || t.includes('lapel')) return 'Lavalier/Lapel';
    if (t.includes('headset')) return 'Headset';
    if (t.includes('handheld') || t.includes('stand')) return 'Handheld/Stand-Held';
    if (t.includes('shotgun')) return 'Shotgun';
    return 'Does Not Apply';
  }

  if (name === 'Brand') return 'Unbranded';
  if (name === 'Size Type') return 'Regular';

  if (name === 'Department') {
    if (['women','womens','woman','ladies'].some(w => t.includes(w))) return 'Women';
    if (['men','mens','man'].some(w => t.includes(w))) return 'Men';
    return 'Unisex Adults';
  }

  if (name === 'Color') {
    for (const c of COMMON_COLORS) {
      if (t.includes(c.toLowerCase())) return c;
    }
    return 'Multicolor';
  }

  if (name === 'Outer Shell Material') {
    for (const [k,v] of Object.entries(SHELL_FROM_TITLE)) {
      if (t.includes(k)) return v;
    }
    return 'Does Not Apply';
  }

  if (name === 'Type' || name === 'Microphone Type') {
    if (t.includes('wireless')) return 'Wireless';
    if (t.includes('condenser')) return 'Condenser';
    if (t.includes('vest')) return 'Vest';
    if (t.includes('coat') || t.includes('parka')) return 'Coat';
    return 'Jacket';
  }

  return 'Does Not Apply';
}

function isClothingCategory(category) {
  if (!category) return false;
  if (CLOTHING_CATEGORY_IDS.has(String(category.id || ''))) return true;

  const n = String(category.name || '').toLowerCase();
  return [
    'coat','jacket','vest','clothing','apparel',
    't-shirt','shirt','tee','hoodie','sweatshirt'
  ].some(w => n.includes(w));
}

function inferApparelFromTitle(title) {
  const t = String(title || '').toLowerCase();
  const out = {};

  if (t.includes('petite')) out['Size Type'] = ['Petite'];
  else if (t.includes('tall') || t.includes('big & tall') || t.includes('big and tall')) {
    out['Size Type'] = ['Big & Tall'];
  } else if (t.includes('junior')) out['Size Type'] = ['Juniors'];
  else out['Size Type'] = ['Regular'];

  if (['women','womens','woman','ladies'].some(w => t.includes(w))) out.Department = ['Women'];
  else if (['men','mens',"man's",'male'].some(w => t.includes(w))) out.Department = ['Men'];
  else if (['girl','girls'].some(w => t.includes(w))) out.Department = ['Girls'];
  else if (['boy','boys','youth','kids','kid'].some(w => t.includes(w))) out.Department = ['Boys'];
  else out.Department = ['Unisex Adults'];

  if (t.includes('vest')) out.Type = ['Vest'];
  else if (['coat','parka','overcoat','over coat','over-coat'].some(w => t.includes(w))) out.Type = ['Coat'];
  else out.Type = ['Jacket'];

  if (t.includes('denim') || t.includes('trucker')) out.Style = ['Trucker'];
  else if (t.includes('bomber')) out.Style = ['Bomber'];
  else if (t.includes('puffer') || t.includes('down')) out.Style = ['Puffer'];
  else if (t.includes('leather')) out.Style = ['Motorcycle'];
  else if (t.includes('western')) out.Style = ['Western'];

  for (const c of COMMON_COLORS) {
    if (t.includes(c.toLowerCase())) {
      out.Color = [c];
      break;
    }
  }

  if (!out.Color) out.Color = ['Multicolor'];

  for (const [k,v] of Object.entries(SHELL_FROM_TITLE)) {
    if (t.includes(k)) {
      out['Outer Shell Material'] = [v];
      break;
    }
  }

  const sizeMatch = String(title || '').match(
    /\b(?:size|sz|tagged|marked)\s*[:\-]?\s*([XSML]{1,3}|XXL|XXXL|[0-9]{2,3})\b/i
  );

  if (sizeMatch) out.Size = [sizeMatch[1].toUpperCase()];
  return out;
}

async function openAiChat(messages, { temperature = 0.4, maxTokens = 700 } = {}) {
  if (!OPENAI_API_KEY) return null;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{
      Authorization:`Bearer ${OPENAI_API_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      model:OPENAI_MODEL,
      messages,
      temperature,
      max_tokens:maxTokens
    })
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI ${response.status}: ${(await response.text()).slice(0,500)}`
    );
  }

  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function makeDescription(title, reference = '') {
  if (!OPENAI_API_KEY) {
    return (
      `<h2>${xmlEscape(title)}</h2>` +
      `<ul><li>Quality product</li><li>Fast handling</li><li>30-day returns</li></ul>`
    );
  }

  try {
    const content = await openAiChat([
      {
        role:'system',
        content:'Return only valid, concise e-commerce HTML. Never invent specifications that are not in the provided reference.'
      },
      {
        role:'user',
        content:
          `Create a professional eBay description.\n` +
          `Title: ${title}\n` +
          `Reference: ${String(reference).slice(0,2500)}\n` +
          `Include a short intro, bullet highlights, shipping/returns. No markdown.`
      }
    ], { temperature:0.5, maxTokens:700 });

    return String(content || '')
      .replace(/```html/gi,'')
      .replace(/```/g,'')
      .trim();
  } catch (error) {
    console.warn('OpenAI description fallback:', error.message);
    return (
      `<h2>${xmlEscape(title)}</h2>` +
      `<ul><li>Quality product</li><li>Fast handling</li><li>30-day returns</li></ul>`
    );
  }
}

async function aiGuessFromImage(image) {
  const fallback = {
    title:'Untitled Product',
    description_html:'<p>Product listing.</p>',
    price_suggestion:9.99,
    category_hint:'General',
    specifics:{}
  };

  if (!OPENAI_API_KEY || !image?.dataUrl) return fallback;

  try {
    const content = await openAiChat([
      { role:'system', content:'Return strict JSON only.' },
      {
        role:'user',
        content:[
          {
            type:'text',
            text:'Analyze this product image. Return JSON with title, description_html, price_suggestion, category_hint, specifics. Do not invent a brand.'
          },
          {
            type:'image_url',
            image_url:{ url:image.dataUrl }
          }
        ]
      }
    ], { temperature:0.2, maxTokens:600 });

    const clean = String(content || '')
      .replace(/```json/gi,'')
      .replace(/```/g,'')
      .trim();

    return { ...fallback, ...JSON.parse(clean) };
  } catch (error) {
    console.warn('OpenAI image fallback:', error.message);
    return fallback;
  }
}

async function compareImage(image) {
  const items = await ebaySearchByImageInput(image, 50);
  if (!items.length) throw new Error('No eBay image matches found.');

  const prices = [];
  const matches = items.slice(0,10).map(it => {
    const price = Number(it?.price?.value);
    if (Number.isFinite(price)) prices.push(price);
    return {
      title:it.title || '',
      category:it.categories?.[0]?.categoryName || '—',
      price:Number.isFinite(price) ? price : null,
      itemWebUrl:it.itemWebUrl || ''
    };
  });

  const first = items[0];
  const title = first.title || 'Untitled';
  const categories = first.categories || [];
  const categoryHint = categories.length
    ? { id:categories[0].categoryId, name:categories[0].categoryName }
    : null;

  const apparel = inferApparelFromTitle(title);

  return {
    matches,
    estimatedPrice:median(prices),
    bestTitle:title,
    categoryHint,
    inferredSpecifics:browseSpecificsToMap(first),
    description:await makeDescription(title, first.shortDescription || ''),
    size:apparel.Size?.[0] || '',
    sizeType:apparel['Size Type']?.[0] || ''
  };
}

async function autoFillFromImage(image) {
  try {
    const items = await ebaySearchByImageInput(image, 50);

    if (items.length) {
      const top = items[0];
      const title = String(top.title || 'Untitled').slice(0,80);
      const priceValue = Number(top?.price?.value);
      const categories = top.categories || [];
      const categoryHint = categories.length
        ? {
            id:categories[0].categoryId || '42428',
            name:categories[0].categoryName || 'Suggested'
          }
        : null;

      const apparel = inferApparelFromTitle(title);

      return {
        source:'eBay image search',
        title,
        price:Number.isFinite(priceValue) ? priceValue.toFixed(2) : '',
        categoryHint,
        inferredSpecifics:browseSpecificsToMap(top),
        description:await makeDescription(title, top.shortDescription || ''),
        size:apparel.Size?.[0] || '',
        sizeType:apparel['Size Type']?.[0] || ''
      };
    }
  } catch (error) {
    console.warn('eBay auto-fill failed, using AI fallback:', error.message);
  }

  const guess = await aiGuessFromImage(image);
  const apparel = inferApparelFromTitle(guess.title);

  return {
    source:'AI vision',
    title:String(guess.title || 'Untitled').slice(0,80),
    price:Number(guess.price_suggestion || 9.99).toFixed(2),
    categoryHint:{ id:'42428', name:guess.category_hint || 'General' },
    inferredSpecifics:guess.specifics || {},
    description:guess.description_html || await makeDescription(guess.title, guess.title),
    size:apparel.Size?.[0] || '',
    sizeType:apparel['Size Type']?.[0] || ''
  };
}

async function imageSourceToUpload(source, index = 0) {
  if (source?.dataUrl) {
    const parsed = parseDataUrl(source.dataUrl);
    return {
      name:source.name || `image_${index + 1}.jpg`,
      mime:parsed.mime,
      buffer:parsed.buffer
    };
  }

  if (source?.url) {
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`Image download failed (${response.status}): ${source.url}`);
    }

    const mime = response.headers.get('content-type') || 'image/jpeg';
    const ext =
      mime.includes('png') ? '.png' :
      mime.includes('webp') ? '.webp' :
      mime.includes('gif') ? '.gif' : '.jpg';

    return {
      name:`remote_${index + 1}${ext}`,
      mime,
      buffer:Buffer.from(await response.arrayBuffer())
    };
  }

  throw new Error('Invalid image source.');
}

async function uploadSiteHostedPictures(imageSources, log = () => {}, maxPhotos = 24) {
  assertEbayListingSecrets();

  const sources = (imageSources || []).slice(0, maxPhotos);
  const out = [];

  for (let i = 0; i < sources.length; i++) {
    try {
      const image = await imageSourceToUpload(sources[i], i);
      log(`Uploading image to eBay: ${image.name}`);

      const xml =
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
        `<RequesterCredentials><eBayAuthToken>${xmlEscape(EBAY_CONFIG.user_token)}</eBayAuthToken></RequesterCredentials>` +
        `<WarningLevel>High</WarningLevel>` +
        `</UploadSiteHostedPicturesRequest>`;

      const form = new FormData();
      form.append('XML Payload', xml);
      form.append('file', new Blob([image.buffer], { type:image.mime }), image.name);

      const response = await fetch('https://api.ebay.com/ws/api.dll', {
        method:'POST',
        headers:{
          'X-EBAY-API-CALL-NAME':'UploadSiteHostedPictures',
          'X-EBAY-API-COMPATIBILITY-LEVEL':'967',
          'X-EBAY-API-DEV-NAME':EBAY_CONFIG.dev_id,
          'X-EBAY-API-APP-NAME':EBAY_CONFIG.app_id,
          'X-EBAY-API-CERT-NAME':EBAY_CONFIG.cert_id,
          'X-EBAY-API-SITEID':'0'
        },
        body:form
      });

      const text = await response.text();
      const full = (
        text.match(/<(?:\w+:)?FullURL>([\s\S]*?)<\/(?:\w+:)?FullURL>/i) || []
      )[1];

      if (full) {
        out.push(full.replace(/&amp;/g,'&'));
        log('Image uploaded ✓');
      } else {
        log('Image upload failed: ' + normSpace(text.slice(0,300)));
      }
    } catch (error) {
      log('Image upload failed: ' + error.message);
    }
  }

  return out;
}

function parseTradingErrors(text) {
  const success = /<(?:\w+:)?Ack>(Success|Warning)<\/(?:\w+:)?Ack>/i.test(text);
  const messages = [];
  const missing = [];

  const re = /<(?:\w+:)?Errors>([\s\S]*?)<\/(?:\w+:)?Errors>/gi;
  let match;

  while ((match = re.exec(text))) {
    const block = match[1];
    const message = normSpace(
      (block.match(/<(?:\w+:)?LongMessage>([\s\S]*?)<\/(?:\w+:)?LongMessage>/i) || [])[1] ||
      (block.match(/<(?:\w+:)?ShortMessage>([\s\S]*?)<\/(?:\w+:)?ShortMessage>/i) || [])[1] ||
      ''
    );

    if (!message) continue;
    messages.push(message);

    for (const pattern of [
      /the item specific\s+(.+?)\s+is missing/i,
      /the item specific name\s+(.+?)\s+is too long/i
    ]) {
      const q = message.match(pattern);
      if (q) missing.push(canonicalAspectName(q[1]));
    }
  }

  return {
    success,
    messages,
    missing:[...new Set(missing)]
  };
}

function addFixedPriceItemXml(o) {
  const pictures = o.pictureUrls?.length
    ? o.pictureUrls
        .map(url => `<PictureURL>${xmlEscape(url)}</PictureURL>`)
        .join('')
    : '';

  const conditionDescription =
    o.conditionDesc && String(o.conditionId) !== '1000'
      ? `<ConditionDescription><![CDATA[${cdataSafe(String(o.conditionDesc).slice(0,999))}]]></ConditionDescription>`
      : '';

  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${xmlEscape(EBAY_CONFIG.user_token)}</eBayAuthToken></RequesterCredentials>` +
      `<Item>` +
        `<Title>${xmlEscape(String(o.title).slice(0,80))}</Title>` +
        `<Description><![CDATA[${cdataSafe(o.description || '')}]]></Description>` +
        `<PrimaryCategory><CategoryID>${xmlEscape(o.category.id)}</CategoryID></PrimaryCategory>` +
        `<StartPrice>${xmlEscape(o.price)}</StartPrice>` +
        `<Country>${xmlEscape(o.shipFrom.countryCode)}</Country>` +
        (o.shipFrom.postalCode
          ? `<PostalCode>${xmlEscape(o.shipFrom.postalCode)}</PostalCode>`
          : `<Location>${xmlEscape(o.shipFrom.location)}</Location>`) +
        `<Currency>USD</Currency>` +
        `<DispatchTimeMax>3</DispatchTimeMax>` +
        `<ListingDuration>GTC</ListingDuration>` +
        `<ListingType>FixedPriceItem</ListingType>` +
        `<Quantity>${xmlEscape(o.quantity)}</Quantity>` +
        `<ConditionID>${xmlEscape(o.conditionId)}</ConditionID>` +
        conditionDescription +
        `<ItemSpecifics>${specificsXml(o.specifics)}</ItemSpecifics>` +
        `<ReturnPolicy>` +
          `<ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>` +
          `<RefundOption>MoneyBack</RefundOption>` +
          `<ReturnsWithinOption>Days_30</ReturnsWithinOption>` +
          `<ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>` +
        `</ReturnPolicy>` +
        `<ShippingDetails>` +
          `<ShippingType>Flat</ShippingType>` +
          `<ShippingServiceOptions>` +
            `<ShippingServicePriority>1</ShippingServicePriority>` +
            `<ShippingService>${xmlEscape(o.shippingService)}</ShippingService>` +
            `<ShippingServiceCost>${xmlEscape(o.shippingCost)}</ShippingServiceCost>` +
          `</ShippingServiceOptions>` +
        `</ShippingDetails>` +
        `<BestOfferDetails><BestOfferEnabled>${Boolean(o.bestOffer)}</BestOfferEnabled></BestOfferDetails>` +
        (pictures ? `<PictureDetails>${pictures}</PictureDetails>` : '') +
      `</Item>` +
    `</AddFixedPriceItemRequest>`
  );
}

async function createEbayListing(options) {
  assertEbayListingSecrets();

  const log = options.log || (() => {});

  const shipFrom = {
    countryCode: String(options.shipFrom?.countryCode || '').trim().toUpperCase(),
    location: normSpace(options.shipFrom?.location || ''),
    postalCode: normSpace(options.shipFrom?.postalCode || ''),
    source: normSpace(options.shipFrom?.source || ''),
    confidence: normSpace(options.shipFrom?.confidence || ''),
    requiresConfirmation: Boolean(options.shipFrom?.requiresConfirmation),
    confirmed: Boolean(options.shipFrom?.confirmed)
  };

  if (!shipFrom.countryCode) {
    throw new Error('SHIP_FROM_MISSING: Country is required for the eBay item location.');
  }

  if (!shipFrom.location && !shipFrom.postalCode) {
    throw new Error('SHIP_FROM_MISSING: Enter a ship-from Location or Postal Code.');
  }

  if (shipFrom.requiresConfirmation && !shipFrom.confirmed) {
    throw new Error(
      'SHIP_FROM_CONFIRMATION_REQUIRED: AliExpress did not provide a reliable warehouse location. Confirm the actual ship-from location before listing.'
    );
  }

  const shippingService =
    normSpace(options.shippingService) ||
    defaultShippingServiceForCountry(
      shipFrom.countryCode,
      options.deliveryDays
    );

  const shippingCost = String(
    options.shippingCost ??
    EBAY_CONFIG.default_shipping_cost ??
    '4.99'
  );

  const category = options.categoryHint?.id
    ? {
        id:String(options.categoryHint.id),
        name:options.categoryHint.name || 'Suggested'
      }
    : { id:'42428', name:'Tools' };

  let specifics = mergeSpecifics(
    { Brand:['Unbranded'] },
    options.inferredSpecifics || {}
  );

  if (isClothingCategory(options.categoryHint)) {
    specifics = mergeSpecifics(
      specifics,
      inferApparelFromTitle(options.title)
    );

    for (const key of ['Size Type','Department','Type','Color','Size']) {
      if (!specifics[key]?.length) {
        throw new Error('APPAREL_MISSING:' + key);
      }
    }

    if (!specifics['Outer Shell Material']) {
      specifics['Outer Shell Material'] = [
        defaultValueForAspect('Outer Shell Material', options.title)
      ];
    }
  }

  const pictureUrls = await uploadSiteHostedPictures(
    options.images || [],
    log,
    24
  );

  if (!pictureUrls.length) {
    throw new Error('No images could be uploaded to eBay.');
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const xml = addFixedPriceItemXml({
      ...options,
      category,
      specifics,
      pictureUrls,
      shipFrom,
      shippingService,
      shippingCost
    });

    const response = await fetch('https://api.ebay.com/ws/api.dll', {
      method:'POST',
      headers:{
        'X-EBAY-API-COMPATIBILITY-LEVEL':'967',
        'X-EBAY-API-DEV-NAME':EBAY_CONFIG.dev_id,
        'X-EBAY-API-APP-NAME':EBAY_CONFIG.app_id,
        'X-EBAY-API-CERT-NAME':EBAY_CONFIG.cert_id,
        'X-EBAY-API-CALL-NAME':'AddFixedPriceItem',
        'X-EBAY-API-SITEID':'0',
        'Content-Type':'text/xml'
      },
      body:xml
    });

    const text = await response.text();
    const parsed = parseTradingErrors(text);

    if (parsed.success) {
      const itemId = (
        text.match(/<(?:\w+:)?ItemID>(.*?)<\/(?:\w+:)?ItemID>/i) || []
      )[1];

      if (itemId && options.sourceProductId) {
        markPosted(options.sourceProductId, itemId, {
          title: options.title || '',
          source_product_id: String(options.sourceProductId || ''),
          source_product_url: options.sourceProductUrl || '',
          sku_id: String(options.sourceVariant?.skuId || ''),
          sku_attr: String(options.sourceVariant?.skuAttr || options.sourceVariant?.id || ''),
          variant_label: String(options.sourceVariant?.label || ''),
          supplier_price: Number(options.sourceVariant?.supplierPrice || 0),
          supplier_stock: Number(options.sourceVariant?.stock || 0),
          ship_from_country: String(options.shipFrom?.countryCode || ''),
          ebay_price: Number(options.price || 0),
          auto_managed: options.autoManaged !== false
        });
      }

      return {
        itemId:itemId || null,
        categoryName:category.name,
        logs:options.logs || []
      };
    }

    for (const message of parsed.messages) {
      log('eBay Error: ' + message);
    }

    if (!parsed.missing.length) break;

    for (const raw of parsed.missing) {
      const name = canonicalAspectName(raw);
      if (!specifics[name]?.length) {
        specifics[name] = [defaultValueForAspect(name, options.title)];
      }
    }
  }

  return { itemId:null, categoryName:null };
}


function xmlTagValue(block, tag) {
  const m = String(block || '').match(new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i'));
  return normSpace(m?.[1] || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}

function xmlTagBlocks(block, tag) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'gi');
  let m;
  while ((m = re.exec(String(block || '')))) out.push(m[1]);
  return out;
}

async function ebayTradingCall(callName, innerXml = '') {
  assertEbayListingSecrets();
  const body = `<?xml version="1.0" encoding="utf-8"?>` +
    `<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<RequesterCredentials><eBayAuthToken>${xmlEscape(EBAY_CONFIG.user_token)}</eBayAuthToken></RequesterCredentials>` +
    `<WarningLevel>High</WarningLevel>${innerXml}</${callName}Request>`;

  const response = await fetch('https://api.ebay.com/ws/api.dll', {
    method:'POST',
    headers:{
      'X-EBAY-API-COMPATIBILITY-LEVEL':'967',
      'X-EBAY-API-DEV-NAME':EBAY_CONFIG.dev_id,
      'X-EBAY-API-APP-NAME':EBAY_CONFIG.app_id,
      'X-EBAY-API-CERT-NAME':EBAY_CONFIG.cert_id,
      'X-EBAY-API-CALL-NAME':callName,
      'X-EBAY-API-SITEID':'0',
      'Content-Type':'text/xml'
    },
    body
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`eBay ${callName} HTTP ${response.status}: ${raw.slice(0,400)}`);
  const ack = xmlTagValue(raw, 'Ack');
  if (!/^(Success|Warning)$/i.test(ack)) {
    const messages = xmlTagBlocks(raw,'Errors').map(b => xmlTagValue(b,'LongMessage') || xmlTagValue(b,'ShortMessage')).filter(Boolean);
    throw new Error(`eBay ${callName} failed: ${messages.join(' | ') || raw.slice(0,500)}`);
  }
  return raw;
}

async function ebayGetActiveListings() {
  const all = [];
  let page = 1;
  while (page <= 20) {
    const raw = await ebayTradingCall('GetMyeBaySelling',
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList>`
    );
    const activeBlock = xmlTagBlocks(raw,'ActiveList')[0] || '';
    const items = xmlTagBlocks(activeBlock,'Item').map(b => ({
      itemId: xmlTagValue(b,'ItemID'),
      title: xmlTagValue(b,'Title'),
      startTime: xmlTagValue(b,'StartTime'),
      watchCount: Number(xmlTagValue(b,'WatchCount') || 0),
      quantityAvailable: Number(xmlTagValue(b,'QuantityAvailable') || 0),
      currentPrice: Number(xmlTagValue(xmlTagBlocks(b,'SellingStatus')[0] || b,'CurrentPrice') || 0)
    })).filter(x => x.itemId);
    all.push(...items);
    const totalPages = Number(xmlTagValue(xmlTagBlocks(activeBlock,'PaginationResult')[0] || raw,'TotalNumberOfPages') || 1);
    if (page >= totalPages || !items.length) break;
    page++;
  }
  return all;
}

async function ebayGetRecentOrders(days = 30) {
  const raw = await ebayTradingCall('GetOrders',
    `<NumberOfDays>${Math.max(1,Math.min(30,Number(days)||30))}</NumberOfDays><OrderRole>Seller</OrderRole><OrderStatus>All</OrderStatus><DetailLevel>ReturnAll</DetailLevel>`
  );
  return xmlTagBlocks(raw,'Order').map(orderBlock => {
    const shipping = xmlTagBlocks(orderBlock,'ShippingAddress')[0] || '';
    const txs = xmlTagBlocks(orderBlock,'TransactionArray').flatMap(b => xmlTagBlocks(b,'Transaction'));
    return {
      orderId: xmlTagValue(orderBlock,'OrderID'),
      paidTime: xmlTagValue(orderBlock,'PaidTime'),
      shippedTime: xmlTagValue(orderBlock,'ShippedTime'),
      checkoutStatus: xmlTagValue(xmlTagBlocks(orderBlock,'CheckoutStatus')[0] || '', 'Status'),
      address:{
        name: xmlTagValue(shipping,'Name'),
        street1: xmlTagValue(shipping,'Street1'),
        street2: xmlTagValue(shipping,'Street2'),
        city: xmlTagValue(shipping,'CityName'),
        state: xmlTagValue(shipping,'StateOrProvince'),
        postalCode: xmlTagValue(shipping,'PostalCode'),
        country: xmlTagValue(shipping,'Country'),
        phone: xmlTagValue(shipping,'Phone')
      },
      transactions: txs.map(t => ({
        itemId: xmlTagValue(t,'ItemID') || xmlTagValue(xmlTagBlocks(t,'Item')[0] || '','ItemID'),
        transactionId: xmlTagValue(t,'TransactionID'),
        quantity: Number(xmlTagValue(t,'QuantityPurchased') || 1),
        title: xmlTagValue(xmlTagBlocks(t,'Item')[0] || '', 'Title')
      })).filter(t => t.itemId)
    };
  }).filter(o => o.orderId);
}

async function ebayEndListing(itemId) {
  await ebayTradingCall('EndFixedPriceItem', `<ItemID>${xmlEscape(itemId)}</ItemID><EndingReason>NotAvailable</EndingReason>`);
}

async function ebayMarkTransactionShipped(itemId, transactionId, carrier, tracking) {
  const shipment = tracking ? `<Shipment><ShipmentTrackingDetails><ShipmentTrackingNumber>${xmlEscape(tracking)}</ShipmentTrackingNumber><ShippingCarrierUsed>${xmlEscape(carrier || 'Other')}</ShippingCarrierUsed></ShipmentTrackingDetails></Shipment>` : '';
  await ebayTradingCall('CompleteSale', `<ItemID>${xmlEscape(itemId)}</ItemID><TransactionID>${xmlEscape(transactionId)}</TransactionID><Shipped>true</Shipped>${shipment}`);
}

function topTimestampGMT8() {
  const d = new Date(Date.now() + 8*3600*1000);
  return d.toISOString().replace('T',' ').slice(0,19);
}

function aliLegacyHmacSign(params) {
  const s = Object.keys(params).filter(k => k !== 'sign' && params[k] != null).sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('md5', ALIEXPRESS_APP_SECRET).update(s,'utf8').digest('hex').toUpperCase();
}

async function aliLegacyCall(method, apiParams = {}) {
  const session = await getValidAliExpressAccessToken();
  const params = {
    app_key:ALIEXPRESS_APP_KEY,
    format:'json',
    method,
    partner_id:'autoshop',
    session,
    sign_method:'hmac',
    timestamp:topTimestampGMT8(),
    v:'2.0',
    ...apiParams
  };
  params.sign = aliLegacyHmacSign(params);
  const response = await fetch('https://eco.taobao.com/router/rest', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},
    body:new URLSearchParams(params)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`${method} returned non-JSON: ${raw.slice(0,400)}`); }
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${raw.slice(0,400)}`);
  if (data.error_response) throw new Error(`${method}: ${data.error_response.sub_msg || data.error_response.msg || 'AliExpress error'}`);
  return data;
}

async function aliChooseShippingService(mapping, address, quantity) {
  const dto = {
    country_code:String(address.country || 'US'),
    product_id:Number(mapping.source_product_id),
    product_num:Number(quantity || 1),
    send_goods_country_code:String(mapping.ship_from_country || 'CN'),
    price:String(mapping.supplier_price || ''),
    price_currency:'USD'
  };
  const data = await aliLegacyCall('aliexpress.logistics.buyer.freight.calculate', {
    param_aeop_freight_calculate_for_buyer_d_t_o:JSON.stringify(dto)
  });
  const result = data?.aliexpress_logistics_buyer_freight_calculate_response?.result || {};
  const list = result?.aeop_freight_calculate_result_for_buyer_d_t_o_list?.aeop_freight_calculate_result_for_buyer_dto || [];
  const options = (Array.isArray(list) ? list : [list]).filter(x => x && (x.success !== false) && x.service_name);
  if (!options.length) throw new Error('AliExpress returned no usable shipping service for this buyer address.');
  options.sort((a,b) => Number(a?.freight?.amount || 0) - Number(b?.freight?.amount || 0));
  return options[0];
}

async function aliPlaceDropshipOrder(mapping, address, quantity) {
  if (!mapping?.source_product_id || !mapping?.sku_attr) throw new Error('This AutoShop listing is missing its AliExpress product/SKU mapping.');
  const shipping = await aliChooseShippingService(mapping, address, quantity);
  const dto = {
    logistics_address:{
      address:address.street1,
      address2:address.street2 || '',
      city:address.city,
      contact_person:address.name,
      country:address.country || 'US',
      full_name:address.name,
      locale:'en_US',
      mobile_no:address.phone || '',
      province:address.state || '',
      zip:address.postalCode || ''
    },
    product_items:[{
      product_count:Number(quantity || 1),
      product_id:Number(mapping.source_product_id),
      sku_attr:mapping.sku_attr,
      logistics_service_name:shipping.service_name,
      order_memo:'Dropshipping order - do not include invoice or promotional material.'
    }]
  };
  const data = await aliLegacyCall('aliexpress.trade.buy.placeorder', {
    param_place_order_request4_open_api_d_t_o:JSON.stringify(dto)
  });
  const result = data?.aliexpress_trade_buy_placeorder_response?.result || {};
  if (!result.is_success) throw new Error(result.error_msg || result.error_code || 'AliExpress did not accept the order.');
  const numbers = result?.order_list?.number || result?.order_list || [];
  const ids = Array.isArray(numbers) ? numbers : [numbers];
  const orderId = String(ids.find(Boolean) || '');
  if (!orderId) throw new Error('AliExpress created the order but did not return an order ID.');
  return { orderId, shippingService:shipping.service_name, freight:Number(shipping?.freight?.amount || 0) };
}

async function aliGetDropshipOrder(orderId) {
  const data = await aliLegacyCall('aliexpress.ds.trade.order.get', { order_id:String(orderId) });
  return data?.aliexpress_ds_trade_order_get_response?.result || {};
}

function reverseManagedByItem(state) {
  const map = new Map();
  for (const [productId, meta] of Object.entries(state.posted || {})) {
    if (meta?.ebay_item_id) map.set(String(meta.ebay_item_id), { productId, ...meta });
  }
  return map;
}

async function fulfillOutstandingOrders(orders, state, log) {
  const reverse = reverseManagedByItem(state);
  const protectedIds = new Set();
  let openCount = 0;
  for (const order of orders) {
    const paid = Boolean(order.paidTime) || /Complete/i.test(order.checkoutStatus || '');
    const shipped = Boolean(order.shippedTime);
    if (!paid || shipped) continue;
    openCount++;
    for (const tx of order.transactions) {
      protectedIds.add(String(tx.itemId));
      const mapping = reverse.get(String(tx.itemId));
      if (!mapping) continue;
      const key = `${order.orderId}:${tx.transactionId || tx.itemId}`;
      const existing = state.fulfillments[key];
      if (!existing?.ali_order_id) {
        try {
          log(`Placing AliExpress order for eBay ${order.orderId} / item ${tx.itemId}…`);
          const placed = await aliPlaceDropshipOrder(mapping, order.address, tx.quantity);
          state.fulfillments[key] = {
            ebay_order_id:order.orderId,
            ebay_item_id:tx.itemId,
            transaction_id:tx.transactionId,
            ali_order_id:placed.orderId,
            status:'ALIEXPRESS_ORDER_PLACED',
            created_at:Date.now()
          };
          writeState(state);
          log(`AliExpress order ${placed.orderId} created.`);
        } catch (e) {
          state.fulfillments[key] = { ...(existing || {}), ebay_order_id:order.orderId, ebay_item_id:tx.itemId, transaction_id:tx.transactionId, status:'ERROR', error:e.message, updated_at:Date.now() };
          writeState(state);
          log(`Fulfillment error for ${order.orderId}: ${e.message}`);
          continue;
        }
      }
      const rec = state.fulfillments[key];
      if (rec?.ali_order_id && rec.status !== 'EBAY_MARKED_SHIPPED') {
        try {
          const aliOrder = await aliGetDropshipOrder(rec.ali_order_id);
          const list = aliOrder?.logistics_info_list?.aeop_order_logistics_info || [];
          const info = (Array.isArray(list) ? list : [list]).find(x => x?.logistics_no);
          if (info?.logistics_no) {
            await ebayMarkTransactionShipped(tx.itemId, tx.transactionId, info.logistics_service || 'Other', info.logistics_no);
            rec.status = 'EBAY_MARKED_SHIPPED';
            rec.tracking = info.logistics_no;
            rec.carrier = info.logistics_service || '';
            rec.updated_at = Date.now();
            writeState(state);
            log(`Tracking ${info.logistics_no} sent to eBay for ${order.orderId}.`);
          }
        } catch (e) {
          rec.last_tracking_error = e.message;
          rec.updated_at = Date.now();
          writeState(state);
          log(`Tracking check deferred for AliExpress order ${rec.ali_order_id}: ${e.message}`);
        }
      }
    }
  }
  return { protectedIds, openCount };
}

async function autoCreateOneListing(log) {
  const discovered = await discoverAndLoadAliExpressProduct(log);
  const p = discovered.normalized;
  const variant = (p.variants || []).filter(v => Number(v.stock) > 0).sort((a,b) => Number(b.stock)-Number(a.stock))[0];
  if (!variant) throw new Error('Discovered product has no in-stock variant.');
  const shipFrom = variant.shipFrom || p.shipFrom;
  if (!shipFrom?.countryCode || shipFrom.requiresConfirmation) throw new Error('Discovered product has no verified ship-from warehouse; skipped.');
  const categoryHint = discovered.categoryHint || await ebaySuggestCategory(p.title);
  if (!categoryHint?.id) throw new Error('eBay category could not be determined.');
  const price = suggestedSellPrice(variant.supplierPrice);
  const description = await makeDescription(p.title, p.descriptionText || p.descriptionHtml || '');
  const specifics = {};
  for (const [k,v] of Object.entries(p.properties || {})) if (k && v) specifics[k] = [v];
  const images = (p.images || []).slice(0,12).map(url => ({url}));
  if (!images.length) throw new Error('Discovered product has no usable images.');
  const result = await createEbayListing({
    title:String(p.title || '').slice(0,80),
    price,
    description,
    categoryHint,
    inferredSpecifics:specifics,
    images,
    quantity:Math.max(1, Math.min(5, Number(variant.stock || 1))),
    conditionId:'1000',
    bestOffer:true,
    sourceProductId:p.productId,
    sourceProductUrl:discovered.productUrl || `https://www.aliexpress.com/item/${p.productId}.html`,
    sourceVariant:variant,
    deliveryDays:p.deliveryDays,
    shipFrom:{...shipFrom, confirmed:true},
    shippingService:defaultShippingServiceForCountry(shipFrom.countryCode,p.deliveryDays),
    shippingCost:EBAY_CONFIG.default_shipping_cost,
    autoManaged:true,
    log
  });
  if (!result.itemId) throw new Error('eBay did not create the automatic listing.');
  return result;
}

let productManagerRunning = false;
async function runProductManagerCycle(trigger = 'timer') {
  if (productManagerRunning) return;
  productManagerRunning = true;
  const logs = [];
  const log = m => { logs.push(m); console.log('[Product Manager]',m); };
  let state = readState();
  state.product_manager ||= {};
  state.product_manager.running = true;
  state.product_manager.last_run = Date.now();
  state.product_manager.last_error = '';
  writeState(state);
  try {
    log(`Cycle started (${trigger}).`);
    const [active, orders] = await Promise.all([ebayGetActiveListings(), ebayGetRecentOrders(30)]);
    state = readState();
    const reverse = reverseManagedByItem(state);
    const fulfillment = await fulfillOutstandingOrders(orders, state, log);
    let activeNow = active;
    let total = activeNow.length;
    const managedActive = () => activeNow.filter(x => reverse.has(String(x.itemId)));
    log(`eBay shop has ${total} active listing(s); ${managedActive().length} are AutoShop-managed.`);

    if (total > PRODUCT_MANAGER_MAX_LISTINGS) {
      let excess = total - PRODUCT_MANAGER_MAX_LISTINGS;
      const candidates = managedActive().filter(x => !fulfillment.protectedIds.has(String(x.itemId))).sort((a,b) => {
        const ma = reverse.get(String(a.itemId)) || {};
        const mb = reverse.get(String(b.itemId)) || {};
        const riskA = (Number(ma.supplier_stock || 0) <= 1 ? -1000000 : 0) + Number(ma.posted_at || 0);
        const riskB = (Number(mb.supplier_stock || 0) <= 1 ? -1000000 : 0) + Number(mb.posted_at || 0);
        return riskA-riskB;
      });
      for (const item of candidates) {
        if (excess <= 0) break;
        await ebayEndListing(item.itemId);
        log(`Ended AutoShop listing ${item.itemId} (${item.title}) to enforce the ${PRODUCT_MANAGER_MAX_LISTINGS}-listing cap.`);
        activeNow = activeNow.filter(x => x.itemId !== item.itemId);
        excess--;
      }
      if (excess > 0) log(`Still ${excess} listing(s) above cap, but no additional safe AutoShop listing can be ended.`);
      total = activeNow.length;
    }

    if (total < PRODUCT_MANAGER_MAX_LISTINGS) {
      try {
        const created = await autoCreateOneListing(log);
        total++;
        log(`Created one new automatic eBay listing: ${created.itemId}.`);
      } catch (e) {
        log(`No qualifying listing created this cycle: ${e.message}`);
      }
    } else {
      log(`Listing cap is ${PRODUCT_MANAGER_MAX_LISTINGS}; no new listing created.`);
    }

    state = readState();
    state.product_manager = {
      ...state.product_manager,
      running:false,
      last_run:Date.now(),
      last_action:logs.slice(-1)[0] || '',
      last_error:'',
      active_count:total,
      managed_count:activeNow.filter(x => reverse.has(String(x.itemId))).length,
      open_orders:fulfillment.openCount,
      last_logs:logs.slice(-20)
    };
    writeState(state);
  } catch (e) {
    state = readState();
    state.product_manager = {...state.product_manager, running:false, last_run:Date.now(), last_error:e.message, last_action:'Cycle failed', last_logs:logs.slice(-20)};
    writeState(state);
    console.error('[Product Manager] cycle error:', e);
  } finally {
    productManagerRunning = false;
  }
}

function suggestedSellPrice(cost) {
  const c = Number(cost);
  if (!Number.isFinite(c) || c <= 0) return '';
  const raw = Math.max(c * 2.5, c + 4);
  return Math.max(0.99, Math.ceil(raw) - 0.01).toFixed(2);
}

function publicAliExpressAuthorizeUrl() {
  assertAliExpressSecrets();

  const redirectUri = `${PUBLIC_BASE_URL}/callback`;
  const url = new URL('https://api-sg.aliexpress.com/oauth/authorize');

  url.searchParams.set('response_type','code');
  url.searchParams.set('force_auth','true');
  url.searchParams.set('redirect_uri',redirectUri);
  url.searchParams.set('client_id',ALIEXPRESS_APP_KEY);

  return url.toString();
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(body),
    'Cache-Control':'no-store'
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type':'text/html; charset=utf-8',
    'Content-Length':Buffer.byteLength(body)
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    'Content-Type':'text/plain; charset=utf-8',
    'Content-Length':Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req, maxBytes = 35 * 1024 * 1024) {
  let total = 0;
  const chunks = [];

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body is too large.');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveStatic(res, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  requested = decodeURIComponent(requested);

  const resolved = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    text(res, 403, 'Forbidden');
    return true;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    return false;
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = {
    '.html':'text/html; charset=utf-8',
    '.js':'application/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8',
    '.json':'application/json; charset=utf-8',
    '.png':'image/png',
    '.jpg':'image/jpeg',
    '.jpeg':'image/jpeg',
    '.svg':'image/svg+xml'
  }[ext] || 'application/octet-stream';

  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    'Content-Type':mime,
    'Content-Length':body.length
  });
  res.end(body);
  return true;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/status') {
      const auth = getAliExpressTokens();
      const state = readState();

      return json(res, 200, {
        ok:true,
        aliexpress:{
          connected:Boolean(auth?.access_token),
          user:auth?.user_nick || auth?.account || '',
          expire_time:Number(auth?.expire_time || 0),
          refresh_expires_in:Number(auth?.refresh_expires_in || 0)
        },
        ebay:{
          browseConfigured:Boolean(EBAY_CONFIG.app_id && EBAY_CONFIG.cert_id),
          listingConfigured:Boolean(
            EBAY_CONFIG.app_id &&
            EBAY_CONFIG.dev_id &&
            EBAY_CONFIG.cert_id &&
            EBAY_CONFIG.user_token
          )
        },
        openai:{ configured:Boolean(OPENAI_API_KEY), model:OPENAI_MODEL },
        postedCount:Object.keys(state.posted || {}).length,
        worker:{
          enabled:ENABLE_WORKER,
          lastRun:state.worker?.last_run || null
        },
        productManager:{
          enabled:PRODUCT_MANAGER_ENABLED,
          intervalSeconds:PRODUCT_MANAGER_INTERVAL_SECONDS,
          maxListings:PRODUCT_MANAGER_MAX_LISTINGS,
          ...(state.product_manager || {})
        },
        publicBaseUrl:PUBLIC_BASE_URL
      });
    }

    if (req.method === 'GET' && pathname === '/api/aliexpress/authorize-url') {
      return json(res, 200, {
        ok:true,
        url:publicAliExpressAuthorizeUrl(),
        redirectUri:`${PUBLIC_BASE_URL}/callback`
      });
    }

    if (req.method === 'GET' && pathname === '/callback') {
      const code = url.searchParams.get('code');

      if (!code) {
        return html(
          res,
          400,
          '<h2>Missing AliExpress authorization code.</h2>'
        );
      }

      try {
        const tokenData = await createAliExpressToken(code);

        return html(
          res,
          200,
          `<!doctype html>
          <html><body style="font-family:Arial;padding:40px">
            <h2>AliExpress authorization received</h2>
            <p>Connected as <b>${xmlEscape(tokenData.user_nick || tokenData.account || 'AliExpress user')}</b>.</p>
            <p>You can close this tab and return to AutoShop.</p>
          </body></html>`
        );
      } catch (error) {
        console.error('AliExpress authorization error:', error);
        return html(
          res,
          500,
          `<h2>AliExpress authorization failed</h2><pre>${xmlEscape(error.message)}</pre>`
        );
      }
    }

    if (req.method === 'POST' && pathname === '/api/aliexpress/product') {
      const body = await readJson(req);
      const result = await aliExpressGetProduct(body.input);

      let categoryHint = null;
      try {
        categoryHint = await ebaySuggestCategory(result.normalized?.title || '');
      } catch (error) {
        console.warn('Automatic eBay category suggestion failed:', error.message);
      }

      return json(res, 200, {
        ok:true,
        productId:result.productId,
        normalized:result.normalized,
        categoryHint
      });
    }

    if (req.method === 'POST' && pathname === '/api/aliexpress/discover') {
      const result = await discoverAndLoadAliExpressProduct();
      return json(res, 200, { ok:true, ...result });
    }

    if (req.method === 'POST' && pathname === '/api/ebay/category-suggest') {
      const body = await readJson(req);
      const categoryHint = await ebaySuggestCategory(body.query || body.title || '');
      if (!categoryHint) throw new Error('eBay did not return a category suggestion.');
      return json(res, 200, { ok:true, categoryHint });
    }

    if (req.method === 'POST' && pathname === '/api/images/autofill') {
      const body = await readJson(req);
      const data = await autoFillFromImage(body.image);
      return json(res, 200, { ok:true, data });
    }

    if (req.method === 'POST' && pathname === '/api/ebay/compare') {
      const body = await readJson(req);
      const data = await compareImage(body.image);
      return json(res, 200, { ok:true, data });
    }

    if (req.method === 'POST' && pathname === '/api/ai/description') {
      const body = await readJson(req);
      const description = await makeDescription(
        body.title || '',
        body.reference || ''
      );
      return json(res, 200, { ok:true, description });
    }

    if (req.method === 'POST' && pathname === '/api/ebay/listing') {
      const body = await readJson(req);
      const logs = [];

      const result = await createEbayListing({
        ...body,
        log:message => logs.push(message)
      });

      return json(res, 200, {
        ok:Boolean(result.itemId),
        itemId:result.itemId,
        categoryName:result.categoryName,
        logs,
        error:result.itemId ? null : 'Could not create listing'
      });
    }

    if (req.method === 'POST' && pathname === '/api/product-manager/run') {
      setImmediate(() => runProductManagerCycle('manual'));
      return json(res, 202, { ok:true, message:'Product Manager cycle started.' });
    }

    if (req.method === 'GET' && pathname === '/api/posted') {
      return json(res, 200, {
        ok:true,
        posted:readState().posted || {}
      });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(res, pathname)) return;
    }

    text(res, 404, 'Not found');
  } catch (error) {
    console.error(req.method, pathname, error);
    json(res, error.statusCode || 500, {
      ok:false,
      error:error.message || 'Server error'
    });
  }
}

function runWorkerCycle() {
  const state = readState();
  state.worker ||= {};
  state.worker.last_run = Date.now();
  writeState(state);

  // Legacy optional heartbeat. The active Product Manager has its own 5-minute sourcing/fulfillment loop.
  console.log(`[${new Date().toLocaleTimeString()}] Worker heartbeat / cycle ran`);
}

if (ENABLE_WORKER) {
  runWorkerCycle();
  setInterval(runWorkerCycle, LISTING_INTERVAL_SECONDS * 1000).unref();
}

if (PRODUCT_MANAGER_ENABLED) {
  setTimeout(() => runProductManagerCycle('startup'), 10000).unref();
  setInterval(() => runProductManagerCycle('timer'), PRODUCT_MANAGER_INTERVAL_SECONDS * 1000).unref();
}

const server = http.createServer((req, res) => {
  route(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  const auth = getAliExpressTokens();

  console.log('');
  console.log('eBay AutoShop Web');
  console.log(`Local: ${`http://localhost:${PORT}`}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);

  if (auth?.access_token) {
    console.log(`Saved AliExpress login: ${auth.user_nick || auth.account || '(unknown)'}`);
  } else {
    console.log('AliExpress is not authorized yet.');
  }

  console.log('');
});
