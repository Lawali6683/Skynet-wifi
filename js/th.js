import { LocalDB } from './db.js';
import { store } from './config.js';
import { icon } from './icons.js';
import { showAlert } from './loader.js';

if (!store.get('is_logged_in', false)) location.replace('login.html');

const $ = (id) => document.getElementById(id);
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

let history = [];

$('back').innerHTML = icon('back', 22);
$('clear').innerHTML = icon('trash', 22);

function formatTimestamp(iso) {
  if (!iso) return 'Unknown Date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return dateFmt.format(d) + ' • ' + timeFmt.format(d);
}

function time(item) {
  const t = new Date(item.timestamp || '').getTime();
  return Number.isNaN(t) ? 0 : t;
}

function load(profile) {
  const raw = profile && Array.isArray(profile.transmission) ? profile.transmission : [];
  history = raw.filter((x) => x && typeof x === 'object').map((x) => ({ ...x })).sort((a, b) => time(b) - time(a));
  render();
}

function commit() {
  const p = LocalDB.getProfile();
  p.transmission = history;
  LocalDB.setProfile(p);
}

function render() {
  const list = $('list');
  list.innerHTML = '';
  $('clear').classList.toggle('hidden', history.length === 0);

  if (!history.length) {
    list.innerHTML =
      '<div class="empty-folder">' + icon('folder', 46) +
      '<b>No Transmission Records Located</b><span>All operational local network traffic metrics appear clean.</span></div>';
    return;
  }

  history.forEach((node, index) => {
    const out = node.direction === 'withdrawal';
    const amount = parseFloat(node.amount ?? '0') || 0;
    const status = String(node.status || 'Success');
    const ok = status.toLowerCase() === 'success';

    const row = document.createElement('div');
    row.className = 'tx-row';
    row.style.animationDelay = Math.min(index, 12) * 0.03 + 's';
    row.innerHTML =
      '<span class="tx-ic ' + (out ? 'out' : 'in') + '">' + icon(out ? 'arrowout' : 'arrowin', 14) + '</span>' +
      '<div class="tx-main"><div class="top"><b></b><span class="st-tag' + (ok ? ' ok' : '') + '"></span></div><small></small></div>' +
      '<button class="mini" aria-label="Delete record">' + icon('trash', 18) + '</button>';
    row.querySelector('b').textContent = '₦ ' + amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    row.querySelector('.st-tag').textContent = status.toUpperCase();
    row.querySelector('small').textContent = formatTimestamp(node.timestamp);
    row.querySelector('.mini').addEventListener('click', () => {
      history.splice(index, 1);
      commit();
      render();
      showAlert('Selected record removed securely from cache ledger.', true);
    });
    list.appendChild(row);
  });
}

$('clear').addEventListener('click', () => $('confirm').classList.add('show'));
$('c-cancel').addEventListener('click', () => $('confirm').classList.remove('show'));
$('confirm').addEventListener('click', (e) => {
  if (e.target === $('confirm')) $('confirm').classList.remove('show');
});
$('c-ok').addEventListener('click', () => {
  $('confirm').classList.remove('show');
  history = [];
  commit();
  render();
  showAlert('All history logs flushed successfully.', true);
});

load(LocalDB.getProfile());
LocalDB.syncProfile().then((ok) => {
  if (ok) load(LocalDB.getProfile());
});