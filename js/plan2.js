import { LocalDB } from './db.js';
import { API_BASE, store } from './config.js';
import { supabase, authHeaders } from './supabase.js';
import { icon } from './icons.js';
import { SkyNetLoader, showAlert } from './loader.js';
import { mountPinRow } from './pin.js';

if (!store.get('is_logged_in', false)) location.replace('login.html');

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const profile = LocalDB.getProfile();
let balance = parseFloat(profile.balance ?? profile.wallet_balance ?? '0') || 0;
let userUuid = profile.uuid || profile.id || '';
const referralCode = profile.referral_code || '';
const referralLink = profile.referral_link || (referralCode ? 'https://skynetwifi.pages.dev/ref/' + referralCode : '');

const FALLBACK = [
  { id: 'plan_2_1', name: 'Standard Access 1', cost: 1000, speed: '10 Mbps', duration: '1 Week', limits: 'All Social Networks, SD Streaming' },
  { id: 'plan_2_2', name: 'Premium Tier 2', cost: 3500, speed: '30 Mbps', duration: '1 Month', limits: 'All Social Networks, TV Streaming, HD Videos' },
  { id: 'plan_2_3', name: 'SkyNet Ultra Extreme', cost: 8000, speed: '50+ Mbps', duration: '1 Month', limits: 'Unrestricted Pipeline, 4K Broadcast, Zero Throttle' }
];

function loadCatalog() {
  const raw = LocalDB.pricingPlansNotifier.value || {};
  const list = [];
  Object.keys(raw).forEach((key) => {
    if (!key.startsWith('plan_2_') || !raw[key] || typeof raw[key] !== 'object') return;
    const v = raw[key];
    list.push({
      id: key,
      name: v.name || key,
      cost: Number(v.cost) || 0,
      speed: v.speed || '',
      duration: v.duration || '',
      limits: v.limits || ''
    });
  });
  const catalog = list.length ? list : FALLBACK.map((p) => ({ ...p }));
  return catalog.sort((a, b) => a.cost - b.cost);
}

let catalog = loadCatalog();
let selectedId = null;
let selectedCost = 0;
let processing = false;
let pinRow = null;

$('back').innerHTML = icon('back', 22);
$('ic-gift').innerHTML = icon('gift', 16);
$('ic-wallet').innerHTML = icon('wallet', 28);
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.innerHTML = icon('copy', 11) + 'Copy';
});
$('ref-link').textContent = referralLink || '—';
$('ref-code').textContent = referralCode || '—';
if (!referralCode && !referralLink) $('referral').classList.add('hidden');

function renderBalance() {
  $('balance').textContent = '₦ ' + money.format(balance);
}

function renderTiers() {
  const wrap = $('tiers');
  wrap.innerHTML = '';
  catalog.forEach((plan) => {
    const on = selectedId === plan.id;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier' + (on ? ' sel' : '');
    b.innerHTML =
      '<div class="body"><div class="hd"><span class="nm"></span><span class="price"></span></div>' +
      '<div class="tags"><span class="tag blue">' + icon('gauge', 10) + '<i class="sp"></i></span><span class="tag orange">' + icon('clock', 10) + '<i class="du"></i></span></div>' +
      '<div class="lim"></div></div><span class="radio">' + (on ? icon('check', 12) : '') + '</span>';
    b.querySelector('.nm').textContent = plan.name;
    b.querySelector('.price').textContent = '₦ ' + plan.cost.toFixed(0);
    b.querySelector('.sp').textContent = plan.speed;
    b.querySelector('.du').textContent = plan.duration;
    b.querySelector('.lim').textContent = 'Access Allocation: ' + plan.limits;
    b.addEventListener('click', () => {
      selectedId = plan.id;
      selectedCost = plan.cost;
      renderTiers();
      renderSubmit();
    });
    wrap.appendChild(b);
  });
}

function canSubmit() {
  if (!selectedId || selectedCost > balance) return false;
  return !!(pinRow && pinRow.verified);
}

function renderSubmit() {
  const insufficient = selectedId && selectedCost > balance;
  $('hint').textContent = insufficient ? 'Insufficient wallet balance for this plan.' : '';
  $('hint').classList.toggle('hidden', !insufficient);

  const wrap = $('submit-wrap');
  if (!canSubmit() || processing) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = '<button class="btn rise" type="button" id="submit"></button>';
  $('submit').textContent = 'Activate Speed Plan (₦ ' + selectedCost.toFixed(0) + ')';
  $('submit').addEventListener('click', submit);
}

async function submit() {
  if (processing || !canSubmit()) return;
  processing = true;
  const planId = selectedId;
  const cost = selectedCost;
  const pinValue = pinRow.value();
  renderSubmit();
  SkyNetLoader.show('Activating speed plan...');

  try {
    if (!userUuid) {
      const { data } = await supabase.auth.getSession();
      userUuid = data && data.session ? data.session.user.id : '';
    }

    const response = await fetch(API_BASE + 'plan2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({
        uuid: userUuid,
        ip_address: '192.168.8.1',
        package_id: planId,
        cost_deduction: cost,
        pin: pinValue,
        idem: crypto.randomUUID()
      })
    });

    let body = {};
    try {
      body = await response.json();
    } catch (_) {}

    SkyNetLoader.hide();

    if (response.status === 200 && body.success === true) {
      balance -= cost;
      const p = LocalDB.getProfile();
      p.balance = balance;
      p.active_speed_tier = planId;
      LocalDB.setProfile(p);

      selectedId = null;
      selectedCost = 0;
      pinRow.reset();
      renderBalance();
      renderTiers();
      showAlert('Success! Speed Plan Active. Local QoS allocation pipeline updated.', true);
      LocalDB.syncProfile();
      setTimeout(() => location.replace('dash.html'), 1500);
    } else {
      showAlert(body.error || 'Intranet provisioning refusal payload returned.', false);
    }
  } catch (_) {
    SkyNetLoader.hide();
    showAlert('Asynchronous backend loop timeout. Ensure local network link integrity.', false);
  } finally {
    processing = false;
    renderSubmit();
  }
}

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = $(btn.dataset.copy).textContent;
    if (!text || text === '—') return;
    try {
      await navigator.clipboard.writeText(text);
      showAlert('Copied ' + btn.dataset.name + ' successfully.', true);
    } catch (_) {
      showAlert('Copy failed. Please copy manually.', false);
    }
  });
});

renderBalance();
renderTiers();
pinRow = mountPinRow($('pin-row'), () => renderSubmit());
renderSubmit();

LocalDB.syncProfile().then((ok) => {
  if (!ok) return;
  const p = LocalDB.getProfile();
  balance = parseFloat(p.balance ?? p.wallet_balance ?? balance) || 0;
  renderBalance();
  renderSubmit();
});

LocalDB.syncPlans().then((ok) => {
  if (!ok) return;
  catalog = loadCatalog();
  renderTiers();
});