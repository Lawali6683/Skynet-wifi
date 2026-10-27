import { store } from './config.js';
import { icon } from './icons.js';
import { showAlert } from './loader.js';

if (!store.get('is_logged_in', false)) location.replace('login.html');

const ROUTER_BASE = 'http://192.168.8.1';
const $ = (id) => document.getElementById(id);

let config = store.get('router_config', {}) || {};
let leases = [];
let logs = store.get('router_history_logs', []) || [];
let editable = !Object.keys(config).length;
let passVisible = false;
let routerOnline = false;
let intercepted = null;
const ignored = new Set();
const disconnecting = new Set();

$('back').innerHTML = icon('back', 22);
$('refresh').innerHTML = icon('refresh', 22);
$('ic-warn').innerHTML = icon('warn', 20);

async function routerFetch(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const opts = { signal: ctl.signal };
    if (body) {
      opts.method = 'POST';
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return await fetch(ROUTER_BASE + path, opts);
  } finally {
    clearTimeout(timer);
  }
}

function mbText(value) {
  return value > 1024 ? (value / 1024).toFixed(2) + ' GB' : value.toFixed(0) + ' MB';
}

function renderConfig() {
  const box = $('cfg');
  if (editable) {
    box.innerHTML =
      '<h3 class="blue">Local Eco-System Configuration' + (Object.keys(config).length ? '<button class="mini red" id="cfg-cancel" aria-label="Cancel">' + icon('close', 18) + '</button>' : '') + '</h3>' +
      '<div class="field plain"><input id="f-pass" type="text" placeholder=" " autocomplete="off"><label for="f-pass">Host Wi-Fi Passphrase</label></div>' +
      '<div class="two-col"><div class="field plain"><input id="f-500" type="number" min="1" inputmode="numeric" placeholder=" "><label for="f-500">Price 500 MB (₦)</label></div>' +
      '<div class="field plain"><input id="f-1g" type="number" min="1" inputmode="numeric" placeholder=" "><label for="f-1g">Price 1 GB (₦)</label></div></div>' +
      '<button class="btn" id="cfg-save" style="display:flex;align-items:center;justify-content:center;gap:8px;height:42px">' + icon('save', 16) + 'Save Configuration</button>';
    $('f-pass').value = config.wifi_passphrase || '';
    $('f-500').value = config.price_500mb || '100';
    $('f-1g').value = config.price_1gb || '150';
    $('cfg-save').addEventListener('click', saveConfig);
    const cancel = $('cfg-cancel');
    if (cancel) cancel.addEventListener('click', () => { editable = false; renderConfig(); });
    return;
  }

  box.innerHTML =
    '<h3 class="blue">Local Eco-System Configuration<button class="mini" id="eye" aria-label="Show passphrase"></button></h3>' +
    '<div class="cfg-line"><span style="display:flex;align-items:center;gap:8px">' + icon('lock', 18) + '<span><small style="display:block">SSID Lock Security Phrase</small><b id="pp"></b></span></span></div>' +
    '<div class="cfg-line"><small>Base Allocation Metrics:</small><b id="pr"></b></div>' +
    '<button class="btn outline" id="cfg-edit" style="display:flex;align-items:center;justify-content:center;gap:8px;color:var(--text);margin-top:12px">' + icon('edit', 14) + 'Modify Credential Grid</button>';
  $('eye').innerHTML = icon(passVisible ? 'eye' : 'eyeoff', 18);
  $('pp').textContent = passVisible ? config.wifi_passphrase || '' : '••••••••••••••••';
  $('pr').textContent = '500MB: ₦' + (config.price_500mb || '') + ' | 1GB: ₦' + (config.price_1gb || '');
  $('eye').addEventListener('click', () => { passVisible = !passVisible; renderConfig(); });
  $('cfg-edit').addEventListener('click', () => { editable = true; renderConfig(); });
}

function saveConfig() {
  const p500 = parseInt($('f-500').value, 10);
  const p1g = parseInt($('f-1g').value, 10);
  if (!(p500 > 0) || !(p1g > 0)) {
    showAlert('Enter valid prices for 500 MB and 1 GB.', false);
    return;
  }
  config = {
    wifi_passphrase: $('f-pass').value.trim(),
    price_500mb: String(p500),
    price_1gb: String(p1g),
    last_updated: new Date().toISOString()
  };
  store.set('router_config', config);
  editable = false;
  renderConfig();
  showAlert('Configuration saved.', true);
}

function renderLeases() {
  const chip = $('count');
  chip.textContent = routerOnline ? leases.length + ' Connected' : 'Router offline';
  chip.className = 'chip' + (routerOnline ? '' : ' off');

  const box = $('leases');
  box.innerHTML = '';
  if (!leases.length) {
    box.innerHTML = '<div class="empty-note">' + (routerOnline ? 'No operational client instances found inside interface layer.' : 'Cannot reach the local router at 192.168.8.1. Connect to the SkyNet Wi-Fi.') + '</div>';
    return;
  }

  leases.forEach((item, i) => {
    const consumed = parseFloat(item.consumed_mb ?? '0') || 0;
    const allocated = parseFloat(item.allocated_mb ?? '0') || 0;
    const pct = allocated > 0 ? Math.min(100, (consumed / allocated) * 100) : 0;

    const row = document.createElement('div');
    row.className = 'lease';
    row.style.animationDelay = Math.min(i, 10) * 0.04 + 's';
    row.innerHTML =
      '<span class="av">' + icon('laptop', 16) + '</span>' +
      '<div class="info"><b></b><small></small><div class="bar"><i></i></div></div>' +
      '<span class="qt"></span>' +
      '<button class="mini red" data-a="disconnect" aria-label="Disconnect client">' + icon('x', 16) + '</button>' +
      '<button class="mini" data-a="delete" aria-label="Delete record">' + icon('trash', 16) + '</button>';
    row.querySelector('b').textContent = item.host_name || 'Unknown Host Device';
    row.querySelector('small').textContent = 'MAC: ' + item.mac_address + ' | IP: ' + (item.ip_address || 'DHCP Bound');
    const fill = row.querySelector('.bar i');
    fill.style.width = pct + '%';
    if (pct > 85) fill.classList.add('hot');
    row.querySelector('.qt').textContent = mbText(consumed) + ' / ' + mbText(allocated);
    row.querySelector('[data-a="disconnect"]').addEventListener('click', () => disconnect(item.mac_address, item.host_name || 'Unknown'));
    row.querySelector('[data-a="delete"]').addEventListener('click', () => {
      leases = leases.filter((l) => l.mac_address !== item.mac_address);
      renderLeases();
    });
    box.appendChild(row);
  });
}

function renderHistory() {
  const box = $('history');
  box.innerHTML = '';
  if (!logs.length) {
    box.innerHTML = '<div class="empty-note">Database interaction logs are currently pristine.</div>';
    return;
  }
  logs.slice(-5).reverse().forEach((log) => {
    const row = document.createElement('div');
    row.className = 'log';
    row.innerHTML = '<div><b></b><small></small></div><div class="r"><b></b><small></small></div>';
    const [l, r] = row.children;
    l.querySelector('b').textContent = log.host_name || 'Unknown Client Address';
    l.querySelector('small').textContent = 'HW Ref: ' + log.mac_address;
    r.querySelector('b').textContent = (parseFloat(log.total_consumed_mb) || 0).toFixed(1) + ' MB';
    r.querySelector('small').textContent = log.status || 'Terminated';
    box.appendChild(row);
  });
}

async function discover() {
  try {
    const res = await routerFetch('/api/v1/dhcp/leases');
    if (res.status === 200) {
      const data = await res.json();
      routerOnline = true;
      leases = Array.isArray(data.active_hosts) ? data.active_hosts.map((h) => ({ ...h })) : [];
      renderLeases();
      evaluateIntercept(data.unauthenticated_node);
      return;
    }
    routerOnline = false;
  } catch (_) {
    routerOnline = false;
  }
  renderLeases();
}

function evaluateIntercept(node) {
  if (!node || intercepted || ignored.has(node.mac_address)) return;
  intercepted = node;
  $('mac').textContent = 'Device HW: ' + node.mac_address;
  $('c-name').value = '';
  $('c-gb').value = '';
  $('c-pass').value = '';
  $('c-alloc').value = '500 MB';
  $('c-gb-wrap').classList.add('hidden');
  $('intercept').classList.add('show');
}

function closeIntercept() {
  $('intercept').classList.remove('show');
  intercepted = null;
}

async function disconnect(mac, hostName) {
  if (disconnecting.has(mac)) return;
  disconnecting.add(mac);
  try {
    const res = await routerFetch('/api/v1/client/disconnect', { mac_address: mac });
    if (res.status === 200) {
      const target = leases.find((l) => l.mac_address === mac);
      if (target) {
        logs.push({
          host_name: hostName,
          mac_address: mac,
          total_consumed_mb: target.consumed_mb || 0.0,
          terminated_at: new Date().toISOString(),
          status: 'Quota Exceeded'
        });
        logs = logs.slice(-200);
        store.set('router_history_logs', logs);
        leases = leases.filter((l) => l.mac_address !== mac);
        renderLeases();
        renderHistory();
      }
    }
  } catch (_) {
  } finally {
    disconnecting.delete(mac);
  }
}

function enforcePolicing() {
  leases.forEach((d) => {
    const consumed = parseFloat(d.consumed_mb ?? '0') || 0;
    const allocated = parseFloat(d.allocated_mb ?? '0') || 0;
    if (allocated > 0 && consumed >= allocated) disconnect(d.mac_address, d.host_name || 'Unknown');
  });
}

$('c-alloc').addEventListener('change', (e) => {
  $('c-gb-wrap').classList.toggle('hidden', e.target.value !== 'Custom GB');
});

$('c-ignore').addEventListener('click', () => {
  if (intercepted) ignored.add(intercepted.mac_address);
  closeIntercept();
});

$('c-ok').addEventListener('click', async () => {
  if (!intercepted) return;
  const name = $('c-name').value.trim();
  if (!name) {
    showAlert('Client Full Name is required.', false);
    return;
  }
  let quota = 500;
  if ($('c-alloc').value === 'Custom GB') {
    const gb = parseFloat($('c-gb').value);
    if (!(gb > 0)) {
      showAlert('Enter a valid GB volume.', false);
      return;
    }
    quota = gb * 1024;
  }
  try {
    const res = await routerFetch('/api/v1/client/authorize', {
      mac_address: intercepted.mac_address,
      client_name: name,
      allocated_mb: quota,
      passphrase: $('c-pass').value.trim()
    });
    if (res.status === 200) {
      closeIntercept();
      showAlert('Client authorized.', true);
      discover();
    } else {
      showAlert('Router refused the authorization request.', false);
    }
  } catch (_) {
    showAlert('Cannot reach the local router.', false);
  }
});

$('refresh').addEventListener('click', discover);

renderConfig();
renderLeases();
renderHistory();
discover();
setInterval(() => { if (!document.hidden) discover(); }, 5000);
setInterval(() => { if (!document.hidden) enforcePolicing(); }, 3000);