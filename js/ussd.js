import { LocalDB } from './db.js';
import { API_BASE, store } from './config.js';
import { icon } from './icons.js';
import { SkyNetLoader, showAlert } from './loader.js';
import { verifyPin } from './pin.js';
import { authHeaders } from './supabase.js';

if (!store.get('is_logged_in', false)) location.replace('login.html');

const $ = (id) => document.getElementById(id);
const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');

const CODES = ['#221#', '#111#', '#112#', '#113#'];
const MAIN_TEXT = '1 check account balance\n2 check data balance\n3 show my account wallet Number\n4 buy data GB plan\n5 buy WiFi access MBPS';

const PLAN1 = [
  { label: '500 MB', cost: 100, id: 'plan_1_1' },
  { label: '1GB', cost: 150, id: 'plan_1_2' },
  { label: '5GB', cost: 1000, id: 'plan_1_3' },
  { label: '10GB', cost: 1800, id: 'plan_1_4' },
  { label: '20GB', cost: 3200, id: 'plan_1_5' }
];
const PLAN2 = [
  { label: '20MBPS (7 Days)', cost: 1500, id: 'plan_2_1' },
  { label: '5MBPS (30 Days)', cost: 5000, id: 'plan_2_2' }
];

let state = 'MAIN';
let pending = null;
let attempts = 0;
let smsText = null;

$('back').innerHTML = icon('back', 22);
$('call').innerHTML = icon('phone', 30);

function sendSms(text) {
  try {
    if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification('SkyNetWiFi', { body: text, icon: 'assets/images/icon.png' }));
    }
  } catch (_) {}
}

function show(screen) {
  $('u-title').textContent = screen.title;
  $('u-sub').textContent = screen.sub || '';
  $('u-sub').style.display = screen.sub ? 'block' : 'none';
  $('u-body').textContent = screen.body;
  const input = $('u-input');
  input.style.display = screen.hint ? 'block' : 'none';
  input.placeholder = screen.hint || '';
  input.type = screen.password ? 'password' : 'text';
  input.inputMode = 'numeric';
  input.value = '';
  $('u-ok').textContent = screen.ok || 'Send/OK';
  $('u-back').textContent = screen.back || '';
  $('u-back').style.display = screen.back ? 'block' : 'none';
  $('ussd').classList.add('show');
  if (screen.hint) setTimeout(() => input.focus(), 150);
}

function close() {
  $('ussd').classList.remove('show');
  state = 'MAIN';
  pending = null;
  attempts = 0;
  smsText = null;
}

function mainScreen(note = '') {
  state = 'MAIN';
  pending = null;
  attempts = 0;
  show({ title: 'SkyNet WiFi Dialogue Window', sub: 'Welcome to SkyNet WiFi', body: (note ? note + '\n\n' : '') + MAIN_TEXT, hint: 'Enter selection option', back: 'Cancel' });
}

function infoScreen(title, body, sms = null) {
  state = 'INFO';
  smsText = sms;
  show({ title, body, ok: 'OK' });
}

function plan1Screen(note = '') {
  state = 'PLAN1';
  const lines = PLAN1.map((p, i) => i + 1 + ': ' + p.label + ' (' + naira(p.cost) + ')').join('\n') + '\n6: Input GB you want';
  show({ title: 'Buy Data GB Plan (Plan 1)', body: (note ? note + '\n\n' : '') + lines, hint: 'Select option', back: 'Back' });
}

function plan2Screen(note = '') {
  state = 'PLAN2';
  const lines = PLAN2.map((p, i) => i + 1 + ': ' + p.label + ' - ' + naira(p.cost)).join('\n');
  show({ title: 'Buy Access Speed (Plan 2)', body: (note ? note + '\n\n' : '') + lines, hint: 'Select option', back: 'Back' });
}

function pinScreen(note = '') {
  state = 'PIN';
  show({
    title: 'Confirm Purchase',
    body: (note ? note + '\n\n' : '') + pending.label + ' for ' + naira(pending.cost) + '\nEnter your 4-digit transaction PIN to confirm.',
    hint: 'Transaction PIN',
    password: true,
    back: 'Cancel'
  });
}

function balance() {
  const p = LocalDB.getProfile();
  return parseFloat(p.balance ?? p.wallet_balance ?? '0') || 0;
}

function handleMain(v) {
  const p = LocalDB.getProfile();
  switch (v) {
    case '1': {
      const b = balance();
      infoScreen('Wallet Balance', 'Your SkyNet WiFi balance is ' + naira(b), 'Dear Customer, your SkyNet WiFi wallet balance is ' + naira(b) + '. Thank you for choosing SkyNet!');
      break;
    }
    case '2': {
      const lines = [];
      if (p.plan2_active === 'yes') {
        const days = parseInt(p.plan2_remaining_days ?? p.plan2_days ?? '0', 10) || 0;
        lines.push('- Plan 2 (MBPS): ' + days + ' Days Remaining');
      }
      if (p.plan1_active === 'yes') {
        const gb = (parseFloat(p.data_balance ?? '0') || 0) / 1024;
        lines.push('- Plan 1 (GB): ' + gb.toFixed(2) + ' GB Remaining');
      }
      const msg = lines.length ? 'Active Plans:\n' + lines.join('\n') : 'You do not have any active Plan 1 or Plan 2 subscription.';
      infoScreen('Data Balance', msg, 'SkyNet Status Info:\n' + msg);
      break;
    }
    case '3': {
      const num = p.wallet_number || p.account_number || 'Not Configured';
      const msg = 'Your SkyNet WiFi Wallet Number is: ' + num + ' Wema Bank. Use this to fund your wallet.';
      infoScreen('Wallet Profile', msg, msg);
      break;
    }
    case '4':
      plan1Screen();
      break;
    case '5':
      plan2Screen();
      break;
    default:
      mainScreen('Invalid option.');
  }
}

function choose(list, type, v) {
  const item = list[parseInt(v, 10) - 1];
  if (!item || !/^\d+$/.test(v)) return false;
  pending = { planType: type, packageId: item.id, cost: item.cost, label: item.label };
  pinScreen();
  return true;
}

async function handlePin(v) {
  if (!/^\d{4}$/.test(v)) {
    pinScreen('Enter a 4-digit PIN.');
    return;
  }
  SkyNetLoader.show('Verifying PIN...');
  let ok = false;
  try {
    ok = await verifyPin(v);
  } catch (err) {
    SkyNetLoader.hide();
    infoScreen('Purchase Failed', err.message);
    return;
  }
  SkyNetLoader.hide();
  if (!ok) {
    attempts += 1;
    if (attempts >= 3) {
      infoScreen('Purchase Failed', 'Too many wrong PIN attempts.');
      return;
    }
    pinScreen('Wrong PIN. Attempts left: ' + (3 - attempts));
    return;
  }
  pending.pin = v;
  executePurchase();
}

async function executePurchase() {
  const order = pending;
  if (balance() < order.cost) {
    infoScreen('Purchase Failed', 'Purchase Failed! Your wallet balance is insufficient.');
    return;
  }

  const p = LocalDB.getProfile();
  SkyNetLoader.show('Processing transaction...');
  try {
    const body = {
      id: p.id || '',
      ip_address: p.ip_address || '0.0.0.0',
      plan_type: order.planType,
      package_id: order.packageId,
      pin: order.pin,
      idem: crypto.randomUUID()
    };
    if (order.gb) body.gb = order.gb;

    const res = await fetch(API_BASE + 'buydata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body)
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    SkyNetLoader.hide();

    if (res.status === 200 && (data.status === 'success' || data.success === true)) {
      const post = balance() - order.cost;
      const fresh = LocalDB.getProfile();
      fresh.balance = post;
      LocalDB.setProfile(fresh);
      infoScreen('Transaction Success', 'Package activated successfully.', 'SkyNet Order Complete: Package ' + order.packageId + ' purchased successfully. Account balance: ' + naira(post) + '.');
      LocalDB.syncProfile();
    } else {
      infoScreen('Server System Error', data.message || data.error || 'Processing Failure');
    }
  } catch (_) {
    SkyNetLoader.hide();
    infoScreen('Gateway Connect Timeout', 'Failed to contact edge verification nodes.');
  }
}

function submit() {
  const v = $('u-input').value.trim();
  switch (state) {
    case 'MAIN':
      handleMain(v);
      break;
    case 'PLAN1':
      if (v === '6') {
        state = 'PLAN1_CUSTOM';
        show({ title: 'Buy Data GB Plan (Plan 1)', body: 'Enter the amount of GB you want.', hint: 'GB volume', back: 'Back' });
      } else if (!choose(PLAN1, 'plan1', v)) {
        plan1Screen('Invalid option.');
      }
      break;
    case 'PLAN1_CUSTOM': {
      const gb = parseFloat(v);
      if (!(gb > 0)) {
        show({ title: 'Buy Data GB Plan (Plan 1)', body: 'Invalid volume. Enter the amount of GB you want.', hint: 'GB volume', back: 'Back' });
        break;
      }
      const price1gb = parseInt((store.get('router_config', {}) || {}).price_1gb ?? '150', 10) || 150;
      pending = { planType: 'plan1', packageId: 'plan_1_custom', cost: gb * price1gb, label: gb + ' GB', gb };
      pinScreen();
      break;
    }
    case 'PLAN2':
      if (!choose(PLAN2, 'plan2', v)) plan2Screen('Invalid option.');
      break;
    case 'PIN':
      handlePin(v);
      break;
    case 'INFO':
      if (smsText) sendSms(smsText);
      close();
      break;
  }
}

function back() {
  if (state === 'MAIN') close();
  else mainScreen();
}

$('u-ok').addEventListener('click', submit);
$('u-back').addEventListener('click', back);
$('u-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});

const dial = $('dial');
'123456789*0#'.split('').forEach((k) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'key';
  b.textContent = k;
  b.addEventListener('click', () => { dial.value += k; });
  $('keys').appendChild(b);
});

dial.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    $('call').click();
    return;
  }
  e.preventDefault();
  if (/^[0-9*#]$/.test(e.key)) dial.value += e.key;
});
dial.addEventListener('dblclick', () => { dial.value = ''; });

$('call').addEventListener('click', () => {
  const code = dial.value.trim();
  if (CODES.includes(code)) {
    dial.value = '';
    mainScreen();
  } else {
    showAlert('Connection problem or invalid USSD code.', false);
  }
});