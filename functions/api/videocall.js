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

async function startCall(env, user, target, kind) {
  if (!isUuid(target)) throw new HttpError(400, 'Missing Call Routing Parameters', 'BAD_PARAMS');
  if (target === user.id) throw new HttpError(400, 'You cannot call yourself', 'SELF_CALL');

  rateLimit('call:' + user.id, 1, 2000);

  const rows = await sb(env, `/rest/v1/profiles?id=in.(${user.id},${target})&select=id,full_name,status,video_call_enabled,video_call_expiry`);
  if (!rows.ok || !Array.isArray(rows.data)) throw new HttpError(500, 'Verification Pipeline Interrupted', 'VERIFY_FAILED');

  const caller = rows.data.find((r) => r.id === user.id);
  const callee = rows.data.find((r) => r.id === target);
  if (!caller || !callee || callee.status !== 'active') {
    throw new HttpError(404, 'One or more entities are offline or unregistered', 'TARGET_UNAVAILABLE');
  }
  if (caller.status !== 'active') throw new HttpError(403, 'Account Suspended', 'ACCOUNT_SUSPENDED');

  if (kind === 'video') {
    const expiry = caller.video_call_expiry ? new Date(caller.video_call_expiry).getTime() : 0;
    if (caller.video_call_enabled !== 'yes' || expiry <= Date.now()) {
      throw new HttpError(403, 'Video plan inactive. Activate the video plan to place video calls.', 'VIDEO_PLAN_REQUIRED');
    }
  }

  const callId = crypto.randomUUID();
  const delivered = await broadcast(env, 'inbox:' + target, 'invite', {
    callId,
    kind,
    from: user.id,
    name: caller.full_name || 'SkyNet Member'
  });
  if (!delivered) throw new HttpError(502, 'Could not reach the user right now', 'SIGNAL_FAILED');

  const base = baseUrl(env);
  return {
    status: 'ready',
    call_id: callId,
    channel_id: 'call:' + callId,
    connection_endpoint: `${base}/realtime/v1`,
    realtime_bridge_url: `${base.replace(/^http/, 'ws')}/realtime/v1/websocket`,
    routing_metadata: { stream_type: kind, handshake_isolated_flag: true }
  };
}

function methodNotAllowed({ request, env }) {
  return reply(request, env, { error: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' });
}

const QOS = { noise_suppression: true, echo_cancellation: true };

export const onRequestOptions = ({ request, env }) => options(request, env);
export const onRequest = methodNotAllowed;

export const onRequestPost = (ctx) => guard(ctx, async ({ request, env }) => {
  const user = await authUser(request, env);
  const body = await readJson(request, 65536);

  if (body.initiator_uuid !== undefined && body.initiator_uuid !== user.id) throw new HttpError(403, 'Account Mismatch', 'UUID_MISMATCH');
  const target = body.target_uuid;
  if (!isUuid(target)) throw new HttpError(400, 'Missing Peer Coordinates', 'BAD_PARAMS');

  const sdp = body.sdp_payload;
  const ice = body.ice_candidate;

  if (!sdp && !ice) {
    const data = await startCall(env, user, target, 'video');
    return reply(request, env, { ...data, bandwidth_limit: '1Mbps', qos_parameters: QOS });
  }

  if (!isUuid(body.call_id)) throw new HttpError(400, 'Missing Call Identifier', 'BAD_PARAMS');
  rateLimit('relay:' + user.id, 200, 60000);

  const me = await sb(env, `/rest/v1/profiles?id=eq.${user.id}&select=video_call_enabled,video_call_expiry,status`);
  const row = me.ok && Array.isArray(me.data) ? me.data[0] : null;
  const expiry = row && row.video_call_expiry ? new Date(row.video_call_expiry).getTime() : 0;
  if (!row || row.status !== 'active' || row.video_call_enabled !== 'yes' || expiry <= Date.now()) {
    throw new HttpError(403, 'Premium Subscription Dead Or Expired', 'VIDEO_PLAN_REQUIRED');
  }

  const topic = 'call:' + body.call_id;
  let delivered = true;
  if (sdp) {
    const type = sdp && sdp.type === 'answer' ? 'answer' : 'offer';
    delivered = (await broadcast(env, topic, type, { sdp })) && delivered;
  }
  if (ice) delivered = (await broadcast(env, topic, 'ice', { c: ice })) && delivered;
  if (!delivered) throw new HttpError(502, 'Signalling relay failed', 'SIGNAL_FAILED');

  return reply(request, env, { status: 'relayed', channel_id: topic, bandwidth_limit: '1Mbps', qos_parameters: QOS });
});
