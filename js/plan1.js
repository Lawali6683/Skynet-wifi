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
const router = store.get('router_config', {}) || {};

let balance = parseFloat(profile.balance ?? profile.wallet_balance ?? '0') || 0;
let userUuid = profile.uuid || profile.id || '';
const referralCode = profile.referral_code || '';
const referralLink = profile.referral_link || (referralCode ? 'https://skynetwifi.pages.dev/ref/' + referralCode : '');
const price500 = parseInt(router.price_500mb ?? '100', 10) || 100;
const price1gb = parseInt(router.price_1gb ?? '150', 10) || 150;

const plans = [
  { label: '500 MB', cost: price500 },
  { label: '1 GB', cost: price1gb },
  { label: '2 GB', cost: price1gb * 2 },
  { label: '3 GB', cost: price1gb * 3 },
  { label: '5 GB', cost: 700 },
  { label: '10 GB', cost: 1350 }
];

let selected = null;
let customMode = false;
let cost = 0;
let label = '';
let processing = false;
let pinRow = null;

$('back').innerHTML = icon('back', 22);
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.innerHTML = icon('copy', 11) + 'Copy';
});

$('banner').textContent =
  'More high-speed internet, premium reliability, and completely un-expiring data structures. Your volume never turns invalid until consumed! Experience smart network operations for just ₦' +
  price500 + ' for 500 MB or ₦' + price1gb + ' per 1 GB block. Deposit into your local wallet to activate now.';

$('ref-link').textContent = referralLink || '—';
$('ref-code').textContent = referralCode || '—';

function renderBalance() {
  $('balance').textContent = '₦ ' + money.format(balance);
}

function renderPlans() {
  const grid = $('plan-grid');
  grid.innerHTML = '';
  plans.forEach((plan, i) => {
    const b = document.createElement('button');
    const on = selected === i && !customMode;
    b.type = 'button';
    b.className = 'plan-btn' + (on ? ' sel' : '');
    b.innerHTML = '<div><b></b><span></span></div>' + (on ? icon('checkcircle', 16) : '');
    b.querySelector('b').textContent = plan.label;
    b.querySelector('span').textContent = '₦ ' + plan.cost;
    b.addEventListener('click', () => {
      customMode = false;
      selected = i;
      cost = plan.cost;
      label = plan.label;
      $('custom').classList.add('hidden');
      refresh();
    });
    grid.appendChild(b);
  });
  $('others').classList.toggle('sel', customMode);
}

function canSubmit() {
  if (cost <= 0 || cost > balance) return false;
  return !!(pinRow && pinRow.verified);
}

function renderSubmit() {
  const wrap = $('submit-wrap');
  const hint = $('hint');
  const insufficient = cost > 0 && cost > balance;
  hint.textContent = insufficient ? 'Insufficient wallet balance for this plan.' : '';
  hint.classList.toggle('hidden', !insufficient);

  if (!canSubmit() || processing) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = '<button class="btn rise" type="button" id="submit"></button>';
  const btn = $('submit');
  btn.textContent = 'Submit Purchase (₦ ' + cost.toFixed(0) + ')';
  btn.addEventListener('click', submit);
}

function refresh() {
  renderPlans();
  renderSubmit();
}

$('others').addEventListener('click', () => {
  customMode = true;
  selected = null;
  cost = 0;
  label = '';
  $('custom').classList.remove('hidden');
  $('custom-gb').focus();
  refresh();
});

$('custom-gb').addEventListener('input', (e) => {
  const gb = parseFloat(e.target.value);
  selected = null;
  if (Number.isFinite(gb) && gb > 0) {
    cost = gb * price1gb;
    label = gb + ' GB';
  } else {
    cost = 0;
    label = '';
  }
  renderSubmit();
});

async function submit() {
  if (processing || !canSubmit()) return;
  processing = true;
  const boughtLabel = label;
  const boughtCost = cost;
  const pinValue = pinRow.value();
  renderSubmit();
  SkyNetLoader.show('Processing transaction...');

  try {
    if (!userUuid) {
      const { data } = await supabase.auth.getSession();
      userUuid = data && data.session ? data.session.user.id : '';
    }

    const response = await fetch(API_BASE + 'plan1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({
        uuid: userUuid,
        ip_address: '192.168.8.101',
        data_size: boughtLabel,
        cost: boughtCost,
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
      balance -= boughtCost;
      const p = LocalDB.getProfile();
      p.balance = balance;
      LocalDB.setProfile(p);

      selected = null;
      customMode = false;
      cost = 0;
      label = '';
      $('custom-gb').value = '';
      $('custom').classList.add('hidden');
      pinRow.reset();

      renderBalance();
      showAlert('Success! Purchased ' + boughtLabel + ' Data Plan for ₦' + boughtCost.toFixed(0) + ' securely.', true);
      LocalDB.syncProfile().then(() => {
        balance = parseFloat(LocalDB.getUserField('balance') ?? balance) || balance;
        renderBalance();
      });
    } else {
      showAlert(body.error || 'Transaction pipeline allocation failure.', false);
    }
  } catch (_) {
    SkyNetLoader.hide();
    showAlert('Network connection lost. Please check your interface.', false);
  } finally {
    processing = false;
    refresh();
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

if (!referralCode && !referralLink) $('referral').classList.add('hidden');

renderBalance();
pinRow = mountPinRow($('pin-row'), () => renderSubmit());
refresh();

LocalDB.syncProfile().then((ok) => {
  if (!ok) return;
  const p = LocalDB.getProfile();
  balance = parseFloat(p.balance ?? p.wallet_balance ?? balance) || 0;
  renderBalance();
  renderSubmit();
});