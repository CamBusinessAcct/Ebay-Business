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

loadEnvFile(ENV_PATH);

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const EBAY_CONFIG = {
  app_id: process.env.EBAY_APP_ID || '',
  dev_id: process.env.EBAY_DEV_ID || '',
  cert_id: process.env.EBAY_CERT_ID || '',
  user_token: process.env.EBAY_USER_TOKEN || '',
  default_shipping_cost: process.env.EBAY_DEFAULT_SHIPPING_COST || '4.99'
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const ALIEXPRESS_APP_KEY = process.env.ALIEXPRESS_APP_KEY || '';
const ALIEXPRESS_APP_SECRET = process.env.ALIEXPRESS_APP_SECRET || '';

const LISTING_INTERVAL_SECONDS = Number(process.env.LISTING_INTERVAL_SECONDS || (3 * 3600));
const ENABLE_WORKER = /^true$/i.test(process.env.ENABLE_WORKER || 'false');

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
      worker: { last_run: null }
    });
  }
}

function readState() {
  ensureState();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    parsed.posted ||= {};
    parsed.worker ||= { last_run: null };
    return parsed;
  } catch {
    const fresh = {
      aliexpress_auth: null,
      posted: {},
      worker: { last_run: null }
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

function markPosted(productId, ebayItemId = '') {
  if (!productId) return;
  const state = readState();
  state.posted[String(productId)] = {
    ebay_item_id: String(ebayItemId || ''),
    posted_at: Math.floor(Date.now() / 1000)
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
    ship_to_country: 'US',
    target_currency: 'USD',
    target_language: 'EN',
    remove_personal_benefit: 'true'
  };

  params.sign = aliExpressTopSign(params);

  const response = await fetch(
    `https://api-sg.aliexpress.com/sync?${new URLSearchParams(params).toString()}`
  );

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('AliExpress product response was not JSON: ' + text.slice(0,500)); }

  if (!response.ok) {
    throw new Error(`AliExpress product HTTP ${response.status}: ${text.slice(0,500)}`);
  }

  if (data.error_response) {
    throw new Error(
      data.error_response.sub_msg ||
      data.error_response.msg ||
      JSON.stringify(data.error_response)
    );
  }

  return {
    productId,
    data,
    normalized: normalizeAliExpressProduct(data, productId)
  };
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
  const wrapper =
    apiData?.aliexpress_ds_product_get_response ||
    apiData?.result?.aliexpress_ds_product_get_response ||
    {};

  const result = wrapper?.result || apiData?.result || {};
  const base = result?.ae_item_base_info_dto || {};
  const multimedia = result?.ae_multimedia_info_dto || {};
  const logistics = result?.logistics_info_dto || {};

  const propertiesRaw = firstArray(
    result?.ae_item_properties?.ae_item_property
  );

  const skus = firstArray(
    result?.ae_item_sku_info_dtos?.ae_item_sku_info_d_t_o
  );

  const images = String(multimedia?.image_urls || '')
    .split(';')
    .map(x => x.trim())
    .filter(Boolean);

  const properties = {};
  for (const p of propertiesRaw) {
    const name = normSpace(p?.attr_name);
    const value = normSpace(p?.attr_value);
    if (name && value) properties[name] = value;
  }

  const variants = skus.map((sku, index) => {
    const skuProps = firstArray(
      sku?.ae_sku_property_dtos?.ae_sku_property_d_t_o
    );

    const readable = skuProps
      .map(p => normSpace(
        p?.property_value_definition_name ||
        p?.sku_property_value ||
        ''
      ))
      .filter(Boolean);

    const supplierPrice = Number(
      sku?.offer_sale_price ??
      sku?.offer_bulk_sale_price ??
      sku?.sku_price ??
      0
    );

    const explicitShipFrom = shipFromFromSkuProperties(skuProps);

    return {
      index,
      skuId: String(sku?.sku_id || ''),
      id: String(sku?.id || ''),
      label:
        readable.join(' / ') ||
        normSpace(String(sku?.sku_attr || '').split('#').pop()) ||
        `Variant ${index + 1}`,
      supplierPrice: Number.isFinite(supplierPrice) ? supplierPrice : 0,
      regularPrice: Number(sku?.sku_price || 0) || 0,
      stock: Number(sku?.sku_available_stock || 0) || 0,
      currency: String(sku?.currency_code || 'USD'),
      image:
        skuProps.find(p => p?.sku_image)?.sku_image ||
        images[0] ||
        '',
      shipFrom: explicitShipFrom
    };
  });

  const store = {
    name: String(result?.ae_store_info?.store_name || ''),
    country: String(result?.ae_store_info?.store_country_code || ''),
    shippingRating: String(result?.ae_store_info?.shipping_speed_rating || ''),
    communicationRating: String(result?.ae_store_info?.communication_rating || ''),
    describedRating: String(result?.ae_store_info?.item_as_described_rating || '')
  };

  const productShipFrom = productShipFromCandidate(properties, store);

  return {
    productId: String(
      base?.product_id ||
      result?.product_id_converter_result?.main_product_id ||
      fallbackProductId ||
      ''
    ),
    title: normSpace(base?.subject || ''),
    descriptionHtml: String(base?.detail || ''),
    descriptionText: stripHtml(base?.detail || base?.mobile_detail || ''),
    categoryId: String(base?.category_id || ''),
    currency: String(base?.currency_code || 'USD'),
    salesCount: String(base?.sales_count || ''),
    rating: String(base?.avg_evaluation_rating || ''),
    status: String(base?.product_status_type || ''),
    deliveryDays: Number(logistics?.delivery_time || 0) || null,
    shipToCountry: String(logistics?.ship_to_country || ''),
    images,
    variants,
    properties,
    store,
    shipFrom: productShipFrom,
    alreadyPosted: wasPosted(
      base?.product_id ||
      result?.product_id_converter_result?.main_product_id ||
      fallbackProductId
    )
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
        markPosted(options.sourceProductId, itemId);
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

      return json(res, 200, {
        ok:true,
        productId:result.productId,
        normalized:result.normalized
      });
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

  // This preserves the old 3-hour worker hook.
  // Add a product-discovery strategy here later if you want fully automatic sourcing.
  console.log(`[${new Date().toLocaleTimeString()}] Worker heartbeat / cycle ran`);
}

if (ENABLE_WORKER) {
  runWorkerCycle();
  setInterval(runWorkerCycle, LISTING_INTERVAL_SECONDS * 1000).unref();
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
