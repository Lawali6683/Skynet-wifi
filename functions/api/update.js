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

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function requireAdmin(request, env) {
  const user = await authUser(request, env);
  if (!user.email_confirmed_at) throw new HttpError(403, 'Admin Access Required', 'NOT_ADMIN');
  const email = String(user.email || '').toLowerCase();
  const r = await sb(env, '/rest/v1/admins?email=eq.' + encodeURIComponent(email) + '&select=email');
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) throw new HttpError(403, 'Admin Access Required', 'NOT_ADMIN');
  return user;
}

const ADMIN_HEADERS = 'Content-Type, Authorization, X-API-Password';
const KNOWN = ['https://skynetwifiadmin.pages.dev', 'http://localhost:8080'];

function origins(env) {
  return env.ADMIN_ORIGINS ? env.ADMIN_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean) : KNOWN;
}

function days(item) {
  const explicit = Number(item.days);
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 3650) return explicit;
  const m = /(\d+)\s*(day|week|month|year)/i.exec(String(item.validity || ''));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return n * (unit === 'day' ? 1 : unit === 'week' ? 7 : unit === 'month' ? 30 : 365);
}

function price(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10000000) throw new HttpError(400, 'Invalid Bad Request Data', 'BAD_PRICE');
  return n;
}

export const onRequest = (ctx) => {
  const { request, env } = ctx;
  const cors = { origins: origins(env), headers: ADMIN_HEADERS };
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return options(request, env, cors);
  if (origin && !cors.origins.includes(origin.replace(/\/$/, ''))) {
    return reply(request, env, { message: 'Forbidden Origin' }, 403);
  }
  if (request.method !== 'POST') return reply(request, env, { message: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' }, cors);

  return guard(ctx, async ({ request, env }) => {
    let adminId = null;
    let adminLabel = 'api-password';
    const password = request.headers.get('X-API-Password');
    if (password) {
      if (!env.API_PASSWORD || !safeEqual(password, String(env.API_PASSWORD))) throw new HttpError(401, 'Unauthorized Access', 'UNAUTHORIZED');
    } else {
      const admin = await requireAdmin(request, env);
      adminId = admin.id;
      adminLabel = admin.email;
    }

    const body = await readJson(request, 65536);
    if (!body.plan_1 || !Array.isArray(body.plan_2) || body.plan_2.length === 0 || body.plan_2.length > 50) {
      throw new HttpError(400, 'Invalid Bad Request Data', 'BAD_PARAMS');
    }

    const p500 = price(body.plan_1.p500);
    const p1gb = price(body.plan_1.p1gb);

    const rows = [
      { id: 'plan_1_1', kind: 'plan1', name: '500 MB', cost: p500, data_mb: 500, active: true, sort: 1 },
      { id: 'plan_1_2', kind: 'plan1', name: '1 GB', cost: p1gb, data_mb: 1024, active: true, sort: 2 }
    ];

    const seen = new Set();
    for (const item of body.plan_2) {
      const sn = Number(item.sn);
      if (!Number.isInteger(sn) || sn < 1 || sn > 100 || seen.has(sn)) throw new HttpError(400, 'Invalid Bad Request Data', 'BAD_SN');
      seen.add(sn);
      const d = days(item);
      const name = String(item.plan || '').trim();
      if (!d || !name || name.length > 60) throw new HttpError(400, 'Invalid Bad Request Data', 'BAD_PLAN');
      rows.push({
        id: 'plan_2_' + sn,
        kind: 'plan2',
        name,
        cost: price(item.price),
        speed: String(item.speed || '').slice(0, 30) || null,
        duration: String(item.validity || d + ' Days').slice(0, 30),
        limits: String(item.limitation || '').slice(0, 120) || null,
        days: d,
        active: true,
        sort: sn
      });
    }

    const saved = await sb(env, '/rest/v1/pricing_plans?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: rows
    });
    if (!saved.ok) throw new HttpError(500, 'Supabase Sync Failed', 'SYNC_FAILED');

    if (body.replace_all === true) {
      const keep = rows.filter((r) => r.kind === 'plan2').map((r) => r.id).join(',');
      await sb(env, `/rest/v1/pricing_plans?kind=eq.plan2&id=not.in.(${keep})`, { method: 'PATCH', body: { active: false } });
    }

    const current = await sb(env, '/rest/v1/app_settings?key=eq.pricing&select=value');
    const existing = current.ok && Array.isArray(current.data) && current.data[0] ? current.data[0].value || {} : {};
    await sb(env, '/rest/v1/app_settings?on_conflict=key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { key: 'pricing', value: { ...existing, custom_gb_price: p1gb } }
    });

    await sb(env, '/rest/v1/audit_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: { actor: adminId, actor_role: 'admin_api', table_name: 'pricing_plans', row_id: 'bulk', action: 'update', new_data: { by: adminLabel, plans: rows.length, p500, p1gb } }
    });

    return reply(request, env, { message: 'Success', updated: rows.length }, 200, {}, cors);
  }, cors);
};
