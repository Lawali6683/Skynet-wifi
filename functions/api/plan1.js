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

async function signGrant(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function methodNotAllowed({ request, env }) {
  return reply(request, env, { error: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' });
}

const TOKEN_TTL_SECONDS = 900;

export const onRequestOptions = ({ request, env }) => options(request, env);
export const onRequest = methodNotAllowed;

export const onRequestPost = (ctx) => guard(ctx, async ({ request, env }) => {
  const user = await authUser(request, env);
  const body = await readJson(request);
  assertSameUser(body, user);

  const device = body.device_uuid;
  if (typeof device !== 'string' || !device || device.length > 80) throw new HttpError(400, 'Missing Parameters', 'BAD_PARAMS');
  if (!env.VPN_TOKEN_SECRET) throw new HttpError(500, 'Server Misconfigured', 'CONFIG');

  const found = await sb(env, `/rest/v1/profiles?id=eq.${user.id}&select=id,status,device_uuid,plan1_active,data_balance`);
  if (!found.ok || !Array.isArray(found.data)) throw new HttpError(500, 'Database Connection Error', 'FETCH_FAILED');
  if (found.data.length === 0) throw new HttpError(404, 'User Profile Not Found', 'NOT_FOUND');
  const profile = found.data[0];

  if (profile.status !== 'active') throw new HttpError(403, 'Account Suspended', 'ACCOUNT_SUSPENDED');
  if (profile.device_uuid && profile.device_uuid !== device) throw new HttpError(403, 'Device not authorized for this account', 'DEVICE_MISMATCH');
  if (profile.plan1_active !== 'yes' || Number(profile.data_balance || 0) <= 0) {
    throw new HttpError(403, 'Plan 1 Inactive or Data Balance Exhausted', 'PLAN_INACTIVE');
  }

  const expires = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  const endpoint = env.PLAN1_BPN_IP || '10.0.0.1';
  const handshake = await signGrant(env.VPN_TOKEN_SECRET, `plan1:${user.id}:${device}:${expires}`);

  return reply(request, env, {
    status: 'granted',
    profile_tier: 'Plan 1 Uncapped',
    endpoint_ip: endpoint,
    handshake_token: handshake,
    expires_at: expires,
    ttl_seconds: TOKEN_TTL_SECONDS,
    dns_server: '1.1.1.1',
    allowed_ips: '0.0.0.0/0'
  });
});
