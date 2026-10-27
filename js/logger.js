import { supabase } from './supabase.js';

const SAMPLE = 20;
const SLOW_MS = 3000;
const MAX_PER_MINUTE = 40;
const page = (location.pathname.split('/').pop() || 'index.html').slice(0, 60);
const nativeFetch = window.fetch.bind(window);

const queue = [];
let timer = null;
let windowStart = Date.now();
let count = 0;

function allowed() {
  const now = Date.now();
  if (now - windowStart > 60000) {
    windowStart = now;
    count = 0;
  }
  count += 1;
  return count <= MAX_PER_MINUTE;
}

async function flush() {
  timer = null;
  const batch = queue.splice(0, 20);
  if (!batch.length) return;
  try {
    await supabase.rpc('log_events', { p_events: batch });
  } catch (_) {}
  if (queue.length) timer = setTimeout(flush, 4000);
}

export function logEvent(level, source, message, meta = {}) {
  if (level !== 'metric' && !allowed()) return;
  queue.push({ level, source, message: String(message).slice(0, 500), meta, page });
  if (!timer) timer = setTimeout(flush, 4000);
}

function pathOf(url) {
  try {
    return new URL(url, location.href).pathname;
  } catch (_) {
    return 'unknown';
  }
}

window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const tracked = url.includes('/api/') || url.includes('supabase.co');
  if (!tracked || url.includes('log_events')) return nativeFetch(input, init);

  const started = performance.now();
  const path = pathOf(url);
  try {
    const response = await nativeFetch(input, init);
    const ms = Math.round(performance.now() - started);
    if (response.status >= 500) logEvent('error', 'http', response.status + ' ' + path, { ms, status: response.status });
    else if (response.status >= 400 && response.status !== 401) logEvent('warn', 'http', response.status + ' ' + path, { ms, status: response.status });
    else if (ms > SLOW_MS) logEvent('warn', 'slow', path, { ms, status: response.status });
    else if (Math.random() < 1 / SAMPLE) logEvent('metric', 'http', path, { ms, status: response.status, sample: SAMPLE });
    return response;
  } catch (err) {
    logEvent('error', 'network', path + ' ' + ((err && err.message) || 'failed'), { ms: Math.round(performance.now() - started) });
    throw err;
  }
};

window.addEventListener('error', (e) => {
  logEvent('error', 'js', e.message || 'script error', { file: String(e.filename || '').split('/').pop(), line: e.lineno, col: e.colno });
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  logEvent('error', 'promise', (reason && reason.message) || String(reason), {});
});