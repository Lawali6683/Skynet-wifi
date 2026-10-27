import { LocalDB } from './db.js';
import { API_BASE, store } from './config.js';
import { authHeaders } from './supabase.js';
import { icon } from './icons.js';
import { SkyNetLoader, showAlert } from './loader.js';
import { mountPinRow } from './pin.js';

if (!store.get('is_logged_in', false)) location.replace('login.html');

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'GTBank', code: '058' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'Moniepoint MFB', code: '50515' },
  { name: 'OPay', code: '999992' },
  { name: 'Palmpay', code: '999991' },
  { name: 'United Bank for Africa (UBA)', code: '033' },
  { name: 'Zenith Bank', code: '057' }
];

const profile = LocalDB.getProfile();
let balance = parseFloat(profile.balance ?? profile.wallet_balance ?? '0') || 0;

let amount = 0;
let total = 0;
let amountValid = false;
let holder = null;
let lookupToken = 0;
let submitting = false;
let pinRow = null;

$('back').innerHTML = icon('back', 22);
$('ic-bank').innerHTML = icon('bank', 28);
$('ic-info').innerHTML = icon('help', 16);

BANKS.forEach((b) => {
  const o = document.createElement('option');
  o.value = b.code;
  o.textContent = b.name;
  $('bank').appendChild(o);
});

function renderBalance() {
  $('balance').textContent = '₦ ' + money.format(balance);
}

function post(body) {
  return authHeaders().then((auth) =>
    fetch(API_BASE + 'withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body)
    })
  );
}

function validateAmount() {
  const raw = $('amount').value.trim();
  amount = Math.round((parseFloat(raw) || 0) * 100) / 100;
  total = Math.round(amount * 1.01 * 100) / 100;
  amountValid = amount > 0 && total <= balance;
  $('total-line').style.display = raw ? 'flex' : 'none';
  $('total').textContent = '₦ ' + money.format(total);
  $('total').style.color = amountValid ? '#2e7d32' : '#c62828';
  renderSubmit();
}

function clearHolder() {
  holder = null;
  $('holder').classList.add('hidden');
  $('acc-error').classList.add('hidden');
  $('pin-section').classList.add('hidden');
  if (pinRow) pinRow.reset();
  renderSubmit();
}

async function lookup() {
  const account = $('account').value.trim();
  const bank = $('bank').value;
  clearHolder();
  if (!/^\d{10}$/.test(account) || !bank) return;

  const token = ++lookupToken;
  $('lookup').classList.remove('hidden');
  try {
    const res = await post({ bank_code: bank, account_number: account, action: 'validate' });
    const data = await res.json().catch(() => ({}));
    if (token !== lookupToken) return;
    if (res.status === 200 && data.success === true && data.account_name) {
      holder = String(data.account_name);
      $('holder').textContent = 'Holder: ' + holder;
      $('holder').classList.remove('hidden');
      $('pin-section').classList.remove('hidden');
    } else {
      $('acc-error').textContent = data.message || 'Account resolution rejected.';
      $('acc-error').classList.remove('hidden');
    }
  } catch (_) {
    if (token !== lookupToken) return;
    $('acc-error').textContent = 'Failed to communicate with account daemon.';
    $('acc-error').classList.remove('hidden');
  } finally {
    if (token === lookupToken) $('lookup').classList.add('hidden');
  }
}

function canSubmit() {
  return amountValid && !!holder && !!(pinRow && pinRow.verified) && !submitting;
}

function renderSubmit() {
  const wrap = $('submit-wrap');
  if (!canSubmit()) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = '<button class="btn rise" type="button" id="submit"></button>';
  $('submit').textContent = 'Submit Withdrawal (₦ ' + money.format(amount) + ')';
  $('submit').addEventListener('click', submit);
}

async function submit() {
  if (!canSubmit()) return;
  submitting = true;
  const pinValue = pinRow.value();
  const sentAmount = amount;
  const sentTotal = total;
  renderSubmit();
  SkyNetLoader.show('Processing payout...');

  try {
    const res = await post({
      account_number: $('account').value.trim(),
      bank_code: $('bank').value,
      amount: sentAmount,
      pin: pinValue,
      idem: crypto.randomUUID(),
      action: 'payout'
    });
    const data = await res.json().catch(() => ({}));
    SkyNetLoader.hide();

    if (res.status === 200 && data.success === true) {
      balance -= sentTotal;
      const p = LocalDB.getProfile();
      p.balance = balance;
      LocalDB.setProfile(p);
      renderBalance();
      showAlert('Withdrawal transaction processed securely.', true);
      LocalDB.syncProfile();
      setTimeout(() => location.replace('dash.html'), 1200);
    } else {
      showAlert(data.message || 'Payout pipeline denied execution request.', false);
      pinRow.reset();
    }
  } catch (_) {
    SkyNetLoader.hide();
    showAlert('Network issue. Please try again later.', false);
  } finally {
    submitting = false;
    renderSubmit();
  }
}

$('amount').addEventListener('input', validateAmount);
$('account').addEventListener('input', () => {
  $('account').value = $('account').value.replace(/\D/g, '').slice(0, 10);
  lookup();
});
$('bank').addEventListener('change', lookup);

pinRow = mountPinRow($('pin-row'), renderSubmit);
renderBalance();

LocalDB.syncProfile().then((ok) => {
  if (!ok) return;
  const p = LocalDB.getProfile();
  balance = parseFloat(p.balance ?? p.wallet_balance ?? balance) || 0;
  renderBalance();
  validateAmount();
});