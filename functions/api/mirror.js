const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_ORIGINS = [
  'https://skynetwifi.pages.dev',
  'https://www.skynetwifi.com.ng',
  'https://skynetwifi.com.ng',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost'
];

const MAX_DELTA_MB = 150;
const TERMINATED = { status: 'terminated', Action: 'Sever Tunnel Immediately' };

class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

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

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
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

export const onRequestPost = (ctx) => guard(ctx, async ({ request, env }) => {
  const body = await readJson(request);
  const provided = request.headers.get('X-Router-Key') || body.api_secret;
  if (!env.ROUTER_API_KEY) throw new HttpError(500, 'Server Misconfigured', 'CONFIG');
  if (!safeEqual(String(provided || ''), String(env.ROUTER_API_KEY))) throw new HttpError(403, 'Forbidden', 'FORBIDDEN');

  const id = body.id;
  const deltaBytes = Number(body.consumed_delta);
  if (!isUuid(id) || body.consumed_delta === undefined || !Number.isFinite(deltaBytes) || deltaBytes < 0 || !Number.isInteger(deltaBytes)) {
    throw new HttpError(400, 'Missing Operational Metrics', 'BAD_PARAMS');
  }

  const found = await sb(env, `/rest/v1/profiles?id=eq.${id}&select=id,device_uuid,status`);
  if (!found.ok || !Array.isArray(found.data)) throw new HttpError(500, 'Database Fetch Core Exception', 'FETCH_FAILED');
  if (found.data.length === 0) throw new HttpError(404, 'Identity Target Mismatch', 'NOT_FOUND');
  const profile = found.data[0];

  const device = body.device_uuid;
  if (device && profile.device_uuid && profile.device_uuid !== device) {
    await rpc(env, 'flag_user', { p_user: id, p_reason: 'Fraud Flagged: Device Hardware Signature Spoofing Detected.' });
    return reply(request, env, TERMINATED, 401);
  }

  if (deltaBytes / (1024 * 1024) > MAX_DELTA_MB) {
    await rpc(env, 'flag_user', { p_user: id, p_reason: 'Fraud Flagged: Abnormal Delta Consumption Spikes Detected.' });
    return reply(request, env, TERMINATED, 401);
  }

  const result = await rpc(env, 'apply_usage', { p_user: id, p_bytes: deltaBytes });
  if (!result || result.ok !== true) {
    if (result && result.error === 'USER_NOT_FOUND') throw new HttpError(404, 'Identity Target Mismatch', 'NOT_FOUND');
    throw new HttpError(500, 'Database Allocation Modification Failed', 'USAGE_FAILED');
  }

  return reply(request, env, {
    status: 'success',
    data_balance: result.data_balance,
    plan1_active: result.plan1_active,
    plan2_active: result.plan2_active,
    plan2_remaining_days: result.plan2_remaining_days
  });
});

export const onRequest = ({ request, env }) => reply(request, env, { error: 'Method Not Allowed' }, 405, { Allow: 'POST' });