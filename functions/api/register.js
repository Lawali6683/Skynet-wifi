const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DEFAULT_ORIGINS = [
  'https://skynetwifi.pages.dev',
  'https://www.skynetwifi.com.ng',
  'https://skynetwifi.com.ng',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost'
];

let cachedToken = null;

class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function allowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS;
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const h = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (origin && allowedOrigins(env).includes(origin.replace(/\/$/, ''))) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function reply(request, env, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    }
  });
}

function options(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function methodNotAllowed({ request, env }) {
  return reply(request, env, { error: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' });
}

async function readJson(request, maxBytes = 16384) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'Payload Too Large', 'TOO_LARGE');
  const text = await request.text();
  if (!text || text.length > maxBytes) throw new HttpError(text ? 413 : 400, text ? 'Payload Too Large' : 'Invalid JSON Payload', text ? 'TOO_LARGE' : 'BAD_JSON');
  let value;
  try {
    value = JSON.parse(text);
  } catch (_) {
    throw new HttpError(400, 'Invalid JSON Payload', 'BAD_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid JSON Payload', 'BAD_JSON');
  return value;
}

function baseUrl(env) {
  return String(env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
}

function config(env) {
  const url = baseUrl(env);
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(500, 'Server Misconfigured', 'CONFIG');
  return { url, key };
}

async function sb(env, path, { method = 'GET', body, headers = {}, timeout = 8000 } = {}) {
  const { url, key } = config(env);
  let res;
  try {
    res = await fetch(url + path, {
      method,
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (_) {
    throw new HttpError(503, 'Database Unreachable', 'DB_DOWN');
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

async function rpc(env, fn, args) {
  const r = await sb(env, '/rest/v1/rpc/' + fn, { method: 'POST', body: args });
  if (r.ok) return r.data;
  const code = r.data && r.data.code;
  const status = code === '23505' ? 409 : r.status >= 500 || r.status === 404 ? 502 : 400;
  const err = new HttpError(status, code === '23505' ? 'Duplicate Request' : 'Database Operation Failed', code === '23505' ? 'DUPLICATE' : 'RPC_' + fn);
  err.rpcMessage = (r.data && r.data.message) || '';
  throw err;
}

const hits = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    throw new HttpError(429, 'Too Many Requests. Please slow down.', 'RATE_LIMIT');
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) {
    for (const k of hits.keys()) {
      if (!(hits.get(k) || []).some((t) => now - t < windowMs)) hits.delete(k);
    }
  }
}

function normalizePhone(input) {
  const digits = String(input === undefined || input === null ? '' : input).replace(/\D/g, '');
  if (!digits) return null;
  if (/^234\d{10}$/.test(digits)) return '+' + digits;
  if (/^0\d{10}$/.test(digits)) return '+234' + digits.slice(1);
  if (/^\d{10}$/.test(digits)) return '+234' + digits;
  if (/^00\d+$/.test(digits)) return '+' + digits.slice(2);
  return '+' + digits;
}

function monnifyRoot(env) {
  const base = String(env.MONNIFY_BASE_URL || '').replace(/\/$/, '');
  if (!base || !env.MONNIFY_API_KEY || !env.MONNIFY_SECRET_KEY) throw new HttpError(500, 'Payment Gateway Misconfigured', 'CONFIG');
  return base;
}

async function monnifyToken(env) {
  const base = monnifyRoot(env);
  const now = Date.now();
  if (cachedToken && cachedToken.base === base && cachedToken.exp > now + 30000) return cachedToken.value;
  let res;
  try {
    res = await fetch(base + '/api/v1/auth/login', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${env.MONNIFY_API_KEY}:${env.MONNIFY_SECRET_KEY}`), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
  } catch (_) {
    throw new HttpError(503, 'Banking gateway unreachable', 'BANK_DOWN');
  }
  const data = await res.json().catch(() => null);
  const value = data && data.responseBody && data.responseBody.accessToken;
  if (!res.ok || !value) throw new HttpError(502, 'Banking gateway authentication failure', 'BANK_AUTH');
  const ttl = Number(data.responseBody.expiresIn) || 300;
  cachedToken = { base, value, exp: now + ttl * 1000 };
  return value;
}

async function monnify(env, path, { method = 'GET', body, timeout = 25000 } = {}) {
  const base = monnifyRoot(env);
  const bearer = await monnifyToken(env);
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (_) {
    return { network: true, ok: false, status: 0, data: null };
  }
  if (res.status === 401) cachedToken = null;
  const data = await res.json().catch(() => null);
  return { network: false, ok: res.ok, status: res.status, data };
}

async function logServer(env, request, err) {
  try {
    const path = new URL(request.url).pathname;
    await rpc(env, 'log_events', {
      p_events: [{
        level: 'error',
        source: 'api',
        message: String((err && err.message) || err).slice(0, 300),
        meta: { route: path, code: err && err.code, status: err && err.status },
        page: path
      }]
    });
  } catch (_) {}
}

async function guard(ctx, fn) {
  const { request, env } = ctx;
  try {
    return await fn(ctx);
  } catch (e) {
    if (e instanceof HttpError) {
      const body = { success: false, error: e.message, message: e.message };
      if (e.code) body.code = e.code;
      if (e.extra) Object.assign(body, e.extra);
      if (e.status >= 500) ctx.waitUntil(logServer(env, request, e));
      return reply(request, env, body, e.status);
    }
    console.error('[api]', (e && e.stack) || e);
    ctx.waitUntil(logServer(env, request, e));
    return reply(request, env, { success: false, error: 'Internal Server Error', message: 'Internal Server Error' }, 500);
  }
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return;
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'Human verification required', 'TURNSTILE_REQUIRED');
  let res;
  try {
    res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (_) {
    throw new HttpError(503, 'Human verification unavailable', 'TURNSTILE_DOWN');
  }
  const data = await res.json().catch(() => null);
  if (!data || data.success !== true) throw new HttpError(400, 'Human verification failed', 'TURNSTILE_FAILED');
}

async function removeUser(env, id) {
  if (!id) return;
  try {
    await sb(env, '/auth/v1/admin/users/' + id, { method: 'DELETE' });
  } catch (_) {}
}

export const onRequestOptions = ({ request, env }) => options(request, env);
export const onRequest = methodNotAllowed;

export const onRequestPost = (ctx) => guard(ctx, async ({ request, env }) => {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  rateLimit('register:' + ip, 5, 600000);

  const body = await readJson(request);
  await verifyTurnstile(env, body.turnstile_token, ip);

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fullName = String(body.full_name || '').replace(/\s+/g, ' ').trim();
  const phone = normalizePhone(body.phone_number);
  const pin = String(body.pin !== undefined ? body.pin : body.security_pin !== undefined ? body.security_pin : '');
  const device = String(body.device_uuid || '').trim();
  const mac = body.device_mac ? String(body.device_mac).slice(0, 40) : null;
  const referral = String(body.referral_by !== undefined ? body.referral_by : body.referral_code || '').trim();
  const profileUrl = String(body.profile_url || '').trim();

  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Invalid email address', 'BAD_EMAIL');
  if (password.length < 6 || password.length > 72) throw new HttpError(400, 'Password must be between 6 and 72 characters', 'BAD_PASSWORD');
  if (fullName.length < 2 || fullName.length > 80) throw new HttpError(400, 'Full name is required', 'BAD_NAME');
  if (!phone || phone.length < 11 || phone.length > 16) throw new HttpError(400, 'Invalid phone number', 'BAD_PHONE');
  if (!/^\d{4}$/.test(pin)) throw new HttpError(400, 'Security PIN must be 4 digits', 'BAD_PIN');
  if (!device || device.length > 80) throw new HttpError(400, 'Device signature missing', 'BAD_DEVICE');
  if (referral && !/^\d{6}$/.test(referral)) throw new HttpError(400, 'Invalid referral code', 'BAD_REFERRAL');
  const storagePrefix = baseUrl(env) + '/storage/v1/object/public/skynet_files/';
  if (profileUrl && !profileUrl.startsWith(storagePrefix)) throw new HttpError(400, 'Invalid profile image', 'BAD_PROFILE_URL');

  const phoneTaken = await sb(env, '/rest/v1/profiles?phone_norm=eq.' + encodeURIComponent(phone) + '&select=id&limit=1');
  if (phoneTaken.ok && Array.isArray(phoneTaken.data) && phoneTaken.data.length) {
    throw new HttpError(409, 'This phone number is already registered', 'PHONE_EXISTS');
  }

  let referrer = null;
  if (referral) {
    const ref = await sb(env, '/rest/v1/profiles?referral_code=eq.' + referral + '&select=id&limit=1');
    if (ref.ok && Array.isArray(ref.data) && ref.data.length) referrer = referral;
  }

  const signup = await sb(env, '/auth/v1/signup', { method: 'POST', body: { email, password, data: { full_name: fullName } } });
  if (!signup.ok) {
    const text = JSON.stringify(signup.data || '').toLowerCase();
    if (signup.status === 422 || text.includes('already') || text.includes('registered')) throw new HttpError(409, 'This email is already registered', 'EMAIL_EXISTS');
    if (signup.status === 429) throw new HttpError(429, 'Too many sign-up attempts. Try again later.', 'RATE_LIMIT');
    throw new HttpError(400, 'Could not create the account', 'SIGNUP_FAILED');
  }

  const created = signup.data && (signup.data.user || signup.data);
  const authId = created && created.id;
  if (!authId) throw new HttpError(502, 'Account service returned an invalid response', 'SIGNUP_INVALID');
  if (Array.isArray(created.identities) && created.identities.length === 0) {
    throw new HttpError(409, 'This email is already registered', 'EMAIL_EXISTS');
  }
  const needsConfirmation = !(signup.data && (signup.data.access_token || signup.data.session));

  let accounts;
  try {
    const reserve = await monnify(env, env.MONNIFY_RESERVE_PATH || '/api/v2/bank-transfer/reserved-accounts', {
      method: 'POST',
      body: {
        accountReference: 'SNW-' + authId,
        accountName: fullName,
        currencyCode: 'NGN',
        contractCode: env.MONNIFY_CONTRACT_CODE,
        customerEmail: email,
        customerName: fullName,
        getAllAvailableBanks: true
      }
    });
    const list = reserve.data && reserve.data.responseBody && reserve.data.responseBody.accounts;
    if (reserve.network || !reserve.ok || !reserve.data || reserve.data.requestSuccessful !== true || !Array.isArray(list) || !list.length) {
      throw new HttpError(502, 'Virtual ledger generation failed. Core setup rolled back.', 'LEDGER_FAILED');
    }
    accounts = list;
  } catch (e) {
    await removeUser(env, authId);
    throw e;
  }

  const bank = accounts.find((a) => a.bankCode === '035') || accounts[0];
  const cf = request.cf || {};
  const place = [cf.city, cf.region, cf.country].filter(Boolean).join(', ') || 'Unknown Geolocation';

  const profile = await sb(env, '/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: {
      id: authId,
      full_name: fullName,
      phone_number: phone,
      email,
      device_uuid: device,
      device_mac: mac,
      profile_url: profileUrl || null,
      referred_by: referrer,
      register_ip: ip,
      location_address: place,
      account_number: bank.accountNumber,
      wallet_number: bank.accountNumber,
      account_name: bank.accountName,
      bank_name: bank.bankName,
      monnify_reference: 'SNW-' + authId,
      login_status: 'yes',
      online_status: 'off',
      message: 'Pipeline account generated successfully.'
    }
  });

  if (!profile.ok || !Array.isArray(profile.data) || !profile.data.length) {
    await removeUser(env, authId);
    const dup = profile.data && profile.data.code === '23505';
    throw new HttpError(dup ? 409 : 500, dup ? 'This phone number is already registered' : 'Storage allocation exception error. Core setup rolled back.', dup ? 'PHONE_EXISTS' : 'PROFILE_FAILED');
  }

  try {
    await rpc(env, 'set_pin', { p_user: authId, p_pin: pin });
  } catch (_) {
    await removeUser(env, authId);
    throw new HttpError(500, 'Could not secure your PIN. Core setup rolled back.', 'PIN_FAILED');
  }

  if (env.SEND_WELCOME === 'true') {
    ctx.waitUntil(fetch(new URL('/api/welcome', request.url).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, full_name: fullName })
    }).catch(() => {}));
  }

  const row = profile.data[0];
  return reply(request, env, {
    status: 'success',
    message: needsConfirmation
      ? 'Account created. Please confirm your email address, then login.'
      : 'Security node account registered and verified successfully.',
    requires_email_confirmation: needsConfirmation,
    account_number: bank.accountNumber,
    bank_name: bank.bankName,
    member_code: row.member_code || null
  });
});
