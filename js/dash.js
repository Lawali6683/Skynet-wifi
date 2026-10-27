import { LocalDB } from './db.js';
import { store } from './config.js';
import { supabase } from './supabase.js';
import { icon } from './icons.js';
import { SkyNetLoader, showAlert } from './loader.js';
import { SkyNetMeterEngine } from './meter.js';
import { SkyNetVpn } from './vpn.js';

if (!store.get('is_logged_in', false)) location.replace('login.html');

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RING = 2 * Math.PI * 62;

let hideBalance = store.get('hide_balance', false);
let ringAnimated = false;
let latest = {};

$('menu').innerHTML = icon('menu', 22);
$('ic-wifi').innerHTML = icon('wifi', 18);
$('ic-bell').innerHTML = icon('bell', 22);
$('ic-card').innerHTML = icon('card', 18);
$('ic-up').innerHTML = icon('upload', 16);
$('ic-hist').innerHTML = icon('history', 16);
$('ic-bank').innerHTML = icon('bank', 20);
$('copy').innerHTML = icon('copy', 20);
$('drawer-close').innerHTML = icon('close', 22);
$('ic-dwifi').innerHTML = icon('wifi', 36);
$('notif-close').innerHTML = icon('close', 20);

$('wema').addEventListener('error', () => {
  $('wema').classList.add('hidden');
  $('ic-bank').classList.remove('hidden');
});

const DRAWER = [
  { icon: 'home', text: 'Home', href: 'https://skynetwifi.pages.dev', external: true },
  { icon: 'help', text: 'Help', href: 'help.html' },
  { icon: 'data', text: 'Data Plan GB', href: 'plan1.html' },
  { icon: 'bolt', text: 'Wi-Fi Plan Mbps', href: 'plan2.html' },
  { icon: 'upload', text: 'Withdraw', href: 'withdraw.html' },
  { icon: 'phone', text: 'USSD Dialer', href: 'ussd.html' },
  { icon: 'briefcase', text: 'For Business', href: 'https://skynetwifi.pages.dev/bs', external: true }
];

$('drawer-nav').innerHTML =
  DRAWER.map((d) => '<a href="' + d.href + '"' + (d.external ? ' target="_blank" rel="noopener"' : '') + '>' + icon(d.icon, 18) + '<span>' + d.text + '</span></a>').join('') +
  '<button class="di" id="logout">' + icon('logout', 18) + '<span>Logout</span></button>';

const NAV = [
  { href: 'https://skynetwifi.pages.dev', external: true, html: icon('home', 22) },
  { href: 'plan1.html', html: icon('layers', 22) },
  { href: 'call.html', html: '<img src="assets/images/call.png" alt="" onerror="this.outerHTML=\'' + icon('phone', 22).replace(/'/g, '&#39;') + '\'">' },
  { href: 'ht.html', html: icon('history', 22) },
  { href: 'profile.html', html: icon('shield', 22) }
];

$('nav').innerHTML = NAV.map((n) => '<a href="' + n.href + '"' + (n.external ? ' target="_blank" rel="noopener"' : '') + '>' + n.html + '</a>').join('');

function openDrawer(open) {
  $('drawer').classList.toggle('open', open);
  $('scrim').classList.toggle('show', open);
}

$('menu').addEventListener('click', () => openDrawer(true));
$('drawer-close').addEventListener('click', () => openDrawer(false));
$('scrim').addEventListener('click', () => openDrawer(false));

$('logout').addEventListener('click', async () => {
  SkyNetLoader.show();
  try {
    await supabase.auth.signOut();
  } catch (_) {}
  store.set('is_logged_in', false);
  location.replace('login.html');
});

function renderBalance() {
  const raw = parseFloat(latest.balance);
  const text = Number.isFinite(raw) ? money.format(raw) : '0.00';
  $('balance').textContent = hideBalance ? '₦ *********' : '₦ ' + text;
  $('toggle-balance').innerHTML = icon(hideBalance ? 'eyeoff' : 'eye', 20);
}

$('toggle-balance').addEventListener('click', () => {
  hideBalance = !hideBalance;
  store.set('hide_balance', hideBalance);
  renderBalance();
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  showAlert('Copied Successfully!', true);
}

$('copy').addEventListener('click', () => {
  const acc = latest.account_number;
  if (acc) copyText(String(acc));
});

function renderMeter(p) {
  const target = $('meter');

  if (p.plan2_active === 'yes') {
    const days = parseInt(p.plan2_remaining_days ?? p.plan2_days ?? '0', 10) || 0;
    target.className = 'card premium g-meter';
    target.innerHTML =
      '<div class="t">' + icon('bolt', 24) + 'High-Speed Bandwidth Node</div>' +
      '<small>ACTIVE SERVICE PROFILE</small><div class="v">' + esc(p.my_plan_2 || 'Premium Pipeline') + '</div>' +
      '<small>PROVISIONED THROUGHPUT</small><div class="speed">' + esc(p.plan2_speed || '8 Mbps') + '</div>' +
      '<div class="days">' + icon('clock', 16) + 'Remaining Days: ' + days + '</div>';
    return;
  }

  const total = parseFloat(p.total_data_allocated ?? '100') || 100;
  const remaining = parseFloat(p.data_balance ?? '0') || 0;
  const connected = p.is_connected === true;

  let progress = remaining / (total > 0 ? total : 100);
  if (remaining < 10 && remaining > 0) progress = 0.1;
  progress = Math.min(1, Math.max(0, progress));

  const unit = remaining >= 1000 ? 'GB' : 'MB';
  const shown = remaining >= 1000 ? remaining / 1000 : remaining;
  const speed = p.throughput_mbps ? Number(p.throughput_mbps).toFixed(1) + ' Mbps' : connected ? '—' : '0.0 Mbps';

  target.className = 'card g-meter';
  target.innerHTML =
    '<div class="meter-title"><span>Volume Analytics Meter</span><span class="pulse' + (connected ? ' on' : '') + '"></span></div>' +
    '<div class="ring-wrap"><svg class="ring" viewBox="0 0 140 140"><circle class="ring-bg" cx="70" cy="70" r="62"/>' +
    '<circle class="ring-fg' + (remaining < 50 ? ' low' : '') + '" cx="70" cy="70" r="62" stroke-dasharray="' + RING + '" stroke-dashoffset="' + (ringAnimated ? RING * (1 - progress) : RING) + '"/></svg>' +
    '<div class="ring-val"><b>' + shown.toFixed(1) + '</b><span>' + unit + '</span></div></div>' +
    '<div class="kv"><span>Network Diagnostics:</span><b class="' + (connected ? 'ok' : 'off') + '">' + (connected ? 'Active Link Established' : 'Inactive Pipeline Block') + '</b></div>' +
    '<div class="kv"><span>Throughput Telemetry:</span><b class="blue">' + esc(speed) + '</b></div>';

  if (!ringAnimated) {
    ringAnimated = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const fg = target.querySelector('.ring-fg');
      if (fg) fg.style.strokeDashoffset = RING * (1 - progress);
    }));
  }
}

function renderAd() {
  const holder = $('ad');
  const ads = LocalDB.getAds();
  holder.innerHTML = '';
  if (!ads.length) return;
  const ad = ads[0];
  const image = String(ad.Ad_image || '');
  const link = String(ad.Ad_link || '');
  if (!/^https?:\/\//i.test(image)) return;

  const node = document.createElement(/^https?:\/\//i.test(link) ? 'a' : 'div');
  node.className = 'ad';
  node.style.backgroundImage = 'url("' + image.replace(/"/g, '%22') + '")';
  if (node.tagName === 'A') {
    node.href = link;
    node.target = '_blank';
    node.rel = 'noopener';
  }
  holder.appendChild(node);
}

function renderNotifications(list) {
  const ul = $('notif-list');
  ul.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No historical notification traces found.';
    ul.appendChild(empty);
  } else {
    list.forEach((n) => {
      const li = document.createElement('li');
      li.textContent = (n && n.message) || '';
      ul.appendChild(li);
    });
  }
  $('flush').classList.toggle('hidden', !list.length);
}

function render(profile) {
  latest = profile || {};
  const notifications = Array.isArray(latest.account_notifications) ? latest.account_notifications : [];
  const unread = notifications.filter((n) => n && n.unread === true).length;

  $('hello').textContent = 'Hello ' + (latest.full_name || 'User') + ' 🙏';
  $('acc').textContent = latest.account_number || '—';
  $('badge').textContent = unread;
  $('badge').classList.toggle('hidden', unread === 0);

  renderBalance();
  renderMeter(latest);
  renderAd();
  renderNotifications(notifications);
}

$('bell').addEventListener('click', () => $('notif-overlay').classList.add('show'));
$('notif-close').addEventListener('click', () => $('notif-overlay').classList.remove('show'));
$('notif-overlay').addEventListener('click', (e) => {
  if (e.target === $('notif-overlay')) $('notif-overlay').classList.remove('show');
});

$('flush').addEventListener('click', () => {
  const profile = LocalDB.getProfile();
  profile.account_notifications = [];
  LocalDB.setProfile(profile);
  $('notif-overlay').classList.remove('show');
});

LocalDB.userProfileNotifier.subscribe(render);
LocalDB.syncProfile();
LocalDB.syncAds().then(renderAd);

SkyNetMeterEngine.on('cutoff_triggered', (d) => showAlert(d.reason, false));
SkyNetMeterEngine.on('data_exhausted_exception', (d) => showAlert(d.message, false));
SkyNetMeterEngine.start();

SkyNetVpn.initialize();