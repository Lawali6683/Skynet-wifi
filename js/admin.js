import { supabase } from './supabase.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const naira = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });

let thresholds = { rpm_warn: 600, rpm_critical: 1500, error_rate_warn: 0.02, error_rate_critical: 0.05, slow_ms: 3000 };
let table = 'app_logs';
let rows = [];

$('back').innerHTML = icon('back', 22);

const COLUMNS = {
  app_logs: ['created_at', 'level', 'source', 'message', 'page', 'meta'],
  transactions: ['created_at', 'user_id', 'direction', 'kind', 'amount', 'balance_after', 'status', 'ref'],
  withdrawals: ['created_at', 'user_id', 'amount', 'fee', 'bank_code', 'account_number', 'status', 'failure_reason'],
  audit_log: ['at', 'actor_role', 'table_name', 'row_id', 'action', 'old_data', 'new_data'],
  profiles: ['created_at', 'full_name', 'email', 'phone_number', 'balance', 'data_balance', 'plan1_active', 'plan2_active', 'status']
};
const ORDER = { app_logs: 'created_at', transactions: 'created_at', withdrawals: 'created_at', audit_log: 'at', profiles: 'created_at' };

function gate(text) {
  $('panel').classList.add('hidden');
  $('gate').textContent = text;
  $('gate').classList.remove('hidden');
}

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 200);
  return String(value);
}

function renderRows() {
  const cols = COLUMNS[table];
  $('thead').innerHTML = '<tr>' + cols.map((c) => '<th>' + c.replace(/_/g, ' ').toUpperCase() + '</th>').join('') + '</tr>';
  const body = $('tbody');
  body.innerHTML = '';
  const q = $('search').value.trim().toLowerCase();
  rows
    .filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q))
    .slice(0, 300)
    .forEach((r) => body.appendChild(rowEl(r, cols)));
}

function rowEl(r, cols) {
  const tr = document.createElement('tr');
  cols.forEach((c) => {
    const td = document.createElement('td');
    if (c === 'level') {
      const s = document.createElement('span');
      s.className = 'lvl ' + r.level;
      s.textContent = r.level;
      td.appendChild(s);
    } else if (c === 'created_at' || c === 'at') {
      td.textContent = new Date(r[c]).toLocaleString();
    } else {
      td.textContent = cell(r[c]);
    }
    tr.appendChild(td);
  });
  return tr;
}

async function loadRows() {
  let q = supabase.from(table).select('*').order(ORDER[table], { ascending: false }).limit(300);
  if (table === 'app_logs' && $('level').value) q = q.eq('level', $('level').value);
  const { data, error } = await q;
  if (error) {
    gate('Query failed: ' + error.message);
    return;
  }
  rows = data || [];
  renderRows();
}

function statCard(label, value, level) {
  const d = document.createElement('div');
  d.className = 'stat' + (level ? ' ' + level : '');
  d.innerHTML = '<small></small><b></b>';
  d.querySelector('small').textContent = label;
  d.querySelector('b').textContent = value;
  return d;
}

function renderStats(s) {
  const box = $('stats');
  box.innerHTML = '';
  const rpmLevel = s.rpm_estimate >= thresholds.rpm_critical ? 'crit' : s.rpm_estimate >= thresholds.rpm_warn ? 'warn' : '';
  const errLevel = s.error_rate_1h >= thresholds.error_rate_critical ? 'crit' : s.error_rate_1h >= thresholds.error_rate_warn ? 'warn' : '';
  [
    ['USERS', naira.format(s.users_total)],
    ['NEW (24H)', naira.format(s.users_24h)],
    ['ACTIVE (1H)', naira.format(s.active_users_1h)],
    ['SUSPENDED', naira.format(s.suspended)],
    ['REQUESTS / MIN (EST.)', naira.format(s.rpm_estimate), rpmLevel],
    ['ERROR RATE (1H)', (s.error_rate_1h * 100).toFixed(2) + '%', errLevel],
    ['ERRORS (1H)', naira.format(s.errors_1h), s.errors_1h > 20 ? 'warn' : ''],
    ['SLOW CALLS (1H)', naira.format(s.slow_1h), s.slow_1h > 30 ? 'warn' : ''],
    ['TRANSACTIONS (24H)', naira.format(s.tx_24h)],
    ['VOLUME OUT (24H)', '₦' + naira.format(s.volume_24h)],
    ['PENDING PAYOUTS', s.withdrawals_pending + ' / ₦' + naira.format(s.withdrawals_pending_amount), s.withdrawals_pending > 0 ? 'warn' : ''],
    ['USER BALANCES TOTAL', '₦' + naira.format(s.balances_total)]
  ].forEach(([l, v, lv]) => box.appendChild(statCard(l, v, lv)));

  const alerts = $('alerts');
  alerts.innerHTML = '';
  const add = (cls, text) => {
    const d = document.createElement('div');
    d.className = 'alert-box ' + cls;
    d.textContent = text;
    alerts.appendChild(d);
  };
  if (rpmLevel === 'crit') add('crit', 'Traffic is critical (~' + s.rpm_estimate + ' req/min). Upgrade Supabase compute and Cloudflare plan now, and enable rate limiting.');
  else if (rpmLevel === 'warn') add('warn', 'Traffic is high (~' + s.rpm_estimate + ' req/min). Plan to add compute or read replicas before the next campaign.');
  if (errLevel === 'crit') add('crit', 'Error rate is above ' + thresholds.error_rate_critical * 100 + '%. Check the latest errors below and the Cloudflare Functions logs.');
  else if (errLevel === 'warn') add('warn', 'Error rate is above ' + thresholds.error_rate_warn * 100 + '%. Watch closely.');
  if (!alerts.children.length) add('ok', 'All systems look healthy.');
}

function renderChart(series) {
  const svg = $('chart');
  svg.innerHTML = '';
  if (!series.length) return;
  const max = Math.max(1, ...series.map((p) => Math.max(Number(p.errors), Number(p.warns), Number(p.metrics))));
  const w = 600 / series.length;
  series.forEach((p, i) => {
    [['metrics', '#bdbdbd', 0], ['warns', '#fb8c00', 1], ['errors', '#e53935', 2]].forEach(([k, color, j]) => {
      const h = (Number(p[k]) / max) * 110;
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', i * w + j * (w / 3.4) + 1);
      r.setAttribute('y', 118 - h);
      r.setAttribute('width', Math.max(1, w / 3.6));
      r.setAttribute('height', h);
      r.setAttribute('fill', color);
      svg.appendChild(r);
    });
  });
}

async function refreshStats() {
  const [{ data: stats, error }, { data: series }] = await Promise.all([
    supabase.rpc('admin_stats'),
    supabase.rpc('admin_log_series', { p_hours: 24 })
  ]);
  if (error) {
    gate('Stats failed: ' + error.message);
    return;
  }
  renderStats(stats);
  renderChart(series || []);
}

function live() {
  supabase
    .channel('admin-logs')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'app_logs' }, (payload) => {
      if (table !== 'app_logs') return;
      if ($('level').value && payload.new.level !== $('level').value) return;
      rows.unshift(payload.new);
      rows = rows.slice(0, 300);
      renderRows();
    })
    .subscribe((s) => {
      $('live-state').textContent = s === 'SUBSCRIBED' ? 'live' : s.toLowerCase();
    });
}

(async function init() {
  const { data } = await supabase.auth.getSession();
  if (!data || !data.session) {
    gate('Login first from login.html with an admin account, then open this page again.');
    return;
  }
  const { data: ok } = await supabase.rpc('is_admin');
  if (ok !== true) {
    gate('This account is not authorized for the control room.');
    return;
  }
  const { data: cap } = await supabase.from('app_settings').select('value').eq('key', 'capacity').maybeSingle();
  if (cap && cap.value) thresholds = { ...thresholds, ...cap.value };

  $('gate').classList.add('hidden');
  $('panel').classList.remove('hidden');
  await Promise.all([refreshStats(), loadRows()]);
  live();
  setInterval(refreshStats, 15000);
})();

$('source').addEventListener('change', (e) => {
  table = e.target.value;
  $('level').style.display = table === 'app_logs' ? '' : 'none';
  loadRows();
});
$('level').addEventListener('change', loadRows);
$('reload').addEventListener('click', () => { loadRows(); refreshStats(); });
$('search').addEventListener('input', renderRows);