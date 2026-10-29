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

function methodNotAllowed({ request, env }) {
  return reply(request, env, { error: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' });
}

export const onRequestOptions = ({ request, env }) => options(request, env);
export const onRequest = methodNotAllowed;

export const onRequestPost = (ctx) => guard(ctx, async ({ request, env }) => {
  const user = await authUser(request, env);
  const body = await readJson(request);
  assertSameUser(body, user);
  const idem = idemKey(body, user);

  await verifyPin(env, user.id, body.pin);

  const result = await rpc(env, 'buy_video_plan', { p_user: user.id, p_idem: idem });

  if (!result || result.ok !== true) {
    const code = result && result.error;
    if (code === 'INSUFFICIENT_FUNDS') throw new HttpError(400, 'Insufficient Wallet Balance', code);
    if (code === 'USER_NOT_FOUND') throw new HttpError(404, 'Identity Trace Failed', code);
    if (code === 'ACCOUNT_SUSPENDED') throw new HttpError(403, 'Account Suspended', code);
    throw new HttpError(500, 'Atomic Asset Mutation Rolled Back', 'PAY_FAILED');
  }

  return reply(request, env, {
    success: true,
    new_balance: result.balance,
    video_call_enabled: 'yes',
    video_call_expiry: result.expiry,
    message: result.duplicate ? 'Request already processed.' : 'Premium Video Plan Provisions Initialized Safely.'
  });
});
