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

function maskPhone(phone) {
  const p = String(phone || '');
  return p.length > 7 ? p.slice(0, 4) + '***' + p.slice(-3) : '***';
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

export const onRequestOptions = ({ request, env }) => options(request, env);
export const onRequest = methodNotAllowed;

async function routingToken(env, userId, targetId) {
  const secret = env.ROUTING_SECRET || env.SUPABASE_SERVICE_ROLE_KEY;
  return signGrant(secret, userId + ':' + targetId);
}

export const onRequestPost = (ctx) => guard(ctx, async ({ request, env }) => {
  const user = await authUser(request, env);
  const body = await readJson(request, 65536);

  if (!Array.isArray(body.phones) || body.phones.length === 0) {
    return reply(request, env, { registered: [], unregistered: [] });
  }

  rateLimit('contacts:' + user.id, 6, 60000);

  const originalByNorm = new Map();
  for (const raw of body.phones.slice(0, 500)) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const text = String(raw);
    if (text.length > 24) continue;
    const norm = normalizePhone(text);
    if (norm && norm.length >= 8 && norm.length <= 16 && !originalByNorm.has(norm)) originalByNorm.set(norm, text);
  }

  const wanted = Array.from(originalByNorm.keys());
  if (wanted.length === 0) return reply(request, env, { registered: [], unregistered: [] });

  const matches = await rpc(env, 'match_contacts', { p_phones: wanted });
  if (!Array.isArray(matches)) throw new HttpError(500, 'Data Layer Connection Interrupted', 'MATCH_FAILED');

  const matched = new Set();
  const registered = [];
  for (const record of matches) {
    const norm = normalizePhone(record.phone_number);
    matched.add(norm);
    if (record.uuid === user.id) continue;
    registered.push({
      uuid: record.uuid,
      profile_url: record.profile_url || '',
      local_contact_name: record.full_name || 'SkyNet Member',
      phone_number: record.phone_number,
      masked_phone: maskPhone(record.phone_number),
      routing_token: await routingToken(env, user.id, record.uuid)
    });
  }

  const unregistered = wanted
    .filter((norm) => !matched.has(norm))
    .map((norm) => ({ local_contact_name: 'External Contact', phone_number: originalByNorm.get(norm) }));

  return reply(request, env, { registered, unregistered });
});
