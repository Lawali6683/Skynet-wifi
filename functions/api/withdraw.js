const DEFAULT_ORIGINS = [
  'https://skynetwifi.pages.dev',
  'https://www.skynetwifi.com.ng',
  'https://skynetwifi.com.ng',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost'
];

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

function corsHeaders(request, env, opts = {}) {
  const origin = request.headers.get('Origin');
  const list = opts.origins || allowedOrigins(env);
  const h = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': opts.headers || 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (origin && list.includes(origin.replace(/\/$/, ''))) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function reply(request, env, data, status = 200, extra = {}, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request, env, cors),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    }
  });
}

function options(request, env, cors = {}) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, cors) });
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

async function guard(ctx, fn, cors = {}) {
  const { request, env } = ctx;
  try {
    return await fn(ctx);
  } catch (e) {
    if (e instanceof HttpError) {
      const body = { success: false, error: e.message, message: e.message };
      if (e.code) body.code = e.code;
      if (e.extra) Object.assign(body, e.extra);
      if (e.status >= 500) ctx.waitUntil(logServer(env, request, e));
      return reply(request, env, body, e.status, {}, cors);
    }
    console.error('[api]', (e && e.stack) || e);
    ctx.waitUntil(logServer(env, request, e));
    return reply(request, env, { success: false, error: 'Internal Server Error', message: 'Internal Server Error' }, 500, {}, cors);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

async function authUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header);
  if (!match) throw new HttpError(401, 'Authentication Required', 'NO_TOKEN');
  const { url, key } = config(env);
  let res;
  try {
    res = await fetch(url + '/auth/v1/user', {
      headers: { apikey: key, Authorization: 'Bearer ' + match[1] },
      signal: AbortSignal.timeout(8000)
    });
  } catch (_) {
    throw new HttpError(503, 'Auth Service Unreachable', 'AUTH_DOWN');
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Session Expired. Please login again.', 'BAD_TOKEN');
  if (!res.ok) throw new HttpError(502, 'Auth Service Error', 'AUTH_ERROR');
  const user = await res.json().catch(() => null);
  if (!user || !isUuid(user.id)) throw new HttpError(401, 'Invalid Session', 'BAD_TOKEN');
  return user;
}

function assertSameUser(body, user) {
  const claimed = body.uuid !== undefined ? body.uuid : body.id !== undefined ? body.id : body.caller_uuid;
  if (claimed !== undefined && claimed !== user.id) throw new HttpError(403, 'Account Mismatch', 'UUID_MISMATCH');
}

const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;

const isIdem = (v) => typeof v === 'string' && IDEM_RE.test(v);

function idemKey(body, user) {
  if (body.idem === undefined || body.idem === null) return null;
  if (!isIdem(body.idem)) throw new HttpError(400, 'Invalid Request Key', 'BAD_IDEM');
  return user.id + ':' + body.idem;
}

async function verifyPin(env, userId, pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw new HttpError(400, 'Transaction PIN must be 4 digits', 'PIN_FORMAT');
  let ok;
  try {
    ok = await rpc(env, 'verify_pin_for', { p_user: userId, p_pin: pin });
  } catch (e) {
    if (e instanceof HttpError && e.rpcMessage && /PIN_LOCKED/.test(e.rpcMessage)) {
      throw new HttpError(423, 'PIN locked after too many wrong attempts. Try again in 15 minutes.', 'PIN_LOCKED');
    }
    throw e;
  }
  if (ok !== true) throw new HttpError(403, 'Wrong Transaction PIN', 'PIN_INVALID');
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

let cachedToken = null;

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

function methodNotAllowed({ request, env }) {
  return reply(request, env, { error: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' });
}

const FAILED_STATES = new Set(['FAILED', 'EXPIRED', 'REVERSED', 'CANCELLED', 'DECLINED']);

function bankFields(body) {
  const account = String(body.account_number || '').trim();
  const bank = String(body.bank_code || '').trim();
  if (!/^\d{10}$/.test(account) || !/^\d{3,6}$/.test(bank)) throw new HttpError(400, 'Missing tracking account validation attributes', 'BAD_ACCOUNT');
  return { account, bank };
}

async function resolveAccount(env, account, bank) {
  const path = env.MONNIFY_VALIDATE_PATH || '/api/v1/disbursements/account/validate';
  const r = await monnify(env, `${path}?accountNumber=${account}&bankCode=${bank}`);
  if (r.network) throw new HttpError(503, 'Failed to communicate with account daemon.', 'BANK_DOWN');
  const name = r.data && r.data.responseBody && r.data.responseBody.accountName;
  if (r.ok && r.data && r.data.requestSuccessful === true && name) return { ok: true, name: String(name) };
  return { ok: false, message: (r.data && r.data.responseMessage) || 'Validation verification refused' };
}

export const onRequestOptions = ({ request, env }) => options(request, env);
export const onRequest = methodNotAllowed;

export const onRequestPost = (ctx) => guard(ctx, async ({ request, env }) => {
  const user = await authUser(request, env);
  const body = await readJson(request);
  assertSameUser(body, user);

  if (body.action === 'validate') {
    rateLimit('wd-validate:' + user.id, 12, 60000);
    const { account, bank } = bankFields(body);
    const found = await resolveAccount(env, account, bank);
    if (!found.ok) return reply(request, env, { success: false, message: found.message });
    return reply(request, env, { success: true, account_name: found.name });
  }

  if (body.action !== 'payout') throw new HttpError(400, 'Invalid system action parameter', 'BAD_ACTION');

  rateLimit('wd-payout:' + user.id, 3, 60000);
  const { account, bank } = bankFields(body);
  const amount = Math.round(Number(body.amount) * 100) / 100;
  const min = Number(env.WITHDRAW_MIN) || 100;
  const max = Number(env.WITHDRAW_MAX) || 500000;
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    throw new HttpError(400, `Amount must be between ₦${min} and ₦${max}`, 'BAD_AMOUNT');
  }
  const idem = idemKey(body, user);

  await verifyPin(env, user.id, body.pin);

  const holder = await resolveAccount(env, account, bank);
  if (!holder.ok) throw new HttpError(400, holder.message, 'ACCOUNT_REJECTED');

  const started = await rpc(env, 'start_withdrawal', {
    p_user: user.id,
    p_amount: amount,
    p_bank_code: bank,
    p_account: account,
    p_account_name: holder.name,
    p_idem: idem
  });

  if (!started || started.ok !== true) {
    const code = started && started.error;
    if (code === 'INSUFFICIENT_FUNDS_OR_SUSPENDED') throw new HttpError(400, 'Insufficient network ledger liquidity limits available', 'INSUFFICIENT_FUNDS');
    throw new HttpError(500, 'Critical synchronization fault with backplane state store', 'WITHDRAW_START_FAILED');
  }
  if (started.duplicate) {
    return reply(request, env, { success: true, status: 'processing', message: 'Request already received.', withdrawal_id: started.withdrawal_id });
  }

  const id = started.withdrawal_id;
  const reference = 'SNW-WD-' + id;

  const payout = await monnify(env, env.MONNIFY_PAYOUT_PATH || '/api/v2/disbursements/single', {
    method: 'POST',
    body: {
      amount,
      reference,
      narration: 'SkyNet System Settlement Allocation',
      destinationBankCode: bank,
      destinationAccountNumber: account,
      currency: 'NGN',
      sourceAccountNumber: env.MONNIFY_WALLET_ACCOUNT
    }
  });

  const refused = !payout.network && payout.status >= 400 && payout.status < 500 && !(payout.data && payout.data.requestSuccessful === true);
  const state = String((payout.data && payout.data.responseBody && payout.data.responseBody.status) || '').toUpperCase();

  if (!payout.network && payout.ok && payout.data && payout.data.requestSuccessful === true && state === 'SUCCESS') {
    await rpc(env, 'finish_withdrawal', { p_id: id, p_success: true, p_provider_ref: reference, p_reason: null });
    return reply(request, env, {
      success: true,
      status: 'success',
      message: 'Settlement successfully dispatched and processed.',
      withdrawal_id: id,
      fee: started.fee,
      total: started.total,
      new_balance: started.balance
    });
  }

  if (refused || FAILED_STATES.has(state)) {
    await rpc(env, 'finish_withdrawal', {
      p_id: id,
      p_success: false,
      p_provider_ref: reference,
      p_reason: String((payout.data && payout.data.responseMessage) || state || 'Provider refused the transfer').slice(0, 200)
    });
    throw new HttpError(400, 'Network issue. Please try again later.', 'PAYOUT_REFUSED');
  }

  await sb(env, '/rest/v1/withdrawals?id=eq.' + id, { method: 'PATCH', body: { status: 'processing', provider_ref: reference } });
  return reply(request, env, {
    success: true,
    status: 'processing',
    message: 'Settlement is being processed. You will see it in your history shortly.',
    withdrawal_id: id,
    fee: started.fee,
    total: started.total,
    new_balance: started.balance
  });
});
