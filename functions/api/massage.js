const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

async function broadcast(env, topic, event, payload) {
  const { url, key } = config(env);
  try {
    const res = await fetch(url + '/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: true }] }),
      signal: AbortSignal.timeout(6000)
    });
    return res.ok;
  } catch (_) {
    return false;
  }
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

function maskPhone(phone) {
  const p = String(phone || '');
  return p.length > 7 ? p.slice(0, 4) + '***' + p.slice(-3) : '***';
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

export const onRequestOptions = ({ request, env }) => options(request, env);
export const onRequest = methodNotAllowed;

export const onRequestPost = (ctx) => guard(ctx, async ({ request, env }) => {
  const user = await authUser(request, env);
  const body = await readJson(request, 4096);
  assertSameUser(body, user);

  const target = body.target_uuid;
  if (!isUuid(target) || body.payload === undefined || body.payload === null) {
    throw new HttpError(400, 'Missing Delivery Directives', 'BAD_PARAMS');
  }
  if (target === user.id) throw new HttpError(400, 'You cannot message yourself', 'SELF_MESSAGE');

  const content = String(body.payload).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!content) throw new HttpError(400, 'Missing Delivery Directives', 'EMPTY');
  if (content.length > 50) throw new HttpError(400, 'Character Boundary Exceeded', 'TOO_LONG');

  rateLimit('msg-s:' + user.id, 1, 1000);
  rateLimit('msg-m:' + user.id, 30, 60000);

  const rows = await sb(env, `/rest/v1/profiles?id=in.(${user.id},${target})&select=id,full_name,phone_number,status`);
  if (!rows.ok || !Array.isArray(rows.data)) throw new HttpError(500, 'Delivery Network Unavailable', 'VERIFY_FAILED');

  const sender = rows.data.find((r) => r.id === user.id);
  const receiver = rows.data.find((r) => r.id === target);
  if (!sender || sender.status !== 'active') throw new HttpError(403, 'Account Suspended', 'ACCOUNT_SUSPENDED');
  if (!receiver || receiver.status !== 'active') throw new HttpError(404, 'Recipient Not Found', 'TARGET_UNAVAILABLE');

  const delivered = await broadcast(env, 'inbox:' + target, 'message', {
    from: user.id,
    name: sender.full_name || 'SkyNet Member',
    sender_phone: maskPhone(sender.phone_number),
    content,
    dispatched_timestamp: new Date().toISOString()
  });
  if (!delivered) throw new HttpError(502, 'Delivery Network Unavailable', 'SIGNAL_FAILED');

  return reply(request, env, { delivery: 'dispatched', status: 200, retained: false, logs_purged: true });
});
