import { LocalDB } from './db.js';
import { showBanner } from './loader.js';

const APP_SECRET = '@haruna66';
const MAX_BUCKET = 15000000;

const events = new EventTarget();
let status = 'Disconnected';
let tier = null;
let ephemeralKey = null;
let driver = null;
let scanTimer = null;
let bucketTimer = null;
let tokens = MAX_BUCKET;
let routerAlerted = false;

function setStatus(next) {
  status = next;
  events.dispatchEvent(new CustomEvent('status', { detail: next }));
}

async function hmacSha256(secret, message) {
  if (!window.crypto || !window.crypto.subtle) throw new Error('Secure context required');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function startTokenBucket(maxMbps) {
  stopTokenBucket();
  const bytesPerSecond = maxMbps * 125000;
  bucketTimer = setInterval(() => {
    tokens = Math.min(MAX_BUCKET, tokens + bytesPerSecond * 0.1);
  }, 100);
}

function stopTokenBucket() {
  clearInterval(bucketTimer);
  bucketTimer = null;
}

function buildConfig(key, kind) {
  const base = {
    PrivateKey: key,
    DNS: '1.1.1.1',
    Endpoint: 'canvzqvhrvyyanoicmgf.supabase.co:51820'
  };
  if (kind === 'uncapped') {
    return { ...base, Address: '10.0.0.2/32', PublicKey: 'skynet_public_backbone_gateway_server_node', AllowedIPs: '0.0.0.0/0', PersistentKeepalive: '25' };
  }
  if (kind === 'clamped') {
    return { ...base, Address: '10.0.0.3/32', PublicKey: 'skynet_public_backbone_gateway_server_node', AllowedIPs: '0.0.0.0/0', MTU: '1280' };
  }
  return { ...base, Address: '10.0.0.4/32', PublicKey: 'skynet_isolated_intranet_gateway_node', AllowedIPs: '104.21.19.100/32, 172.67.140.210/32, 10.0.0.0/8', PersistentKeepalive: '15' };
}

async function bindInterface(config) {
  if (!driver || typeof driver.connect !== 'function') {
    setStatus('Unavailable');
    showBanner('The VPN tunnel needs the native SkyNet app. Browser mode cannot open it.', null, null);
    return false;
  }
  try {
    await driver.connect(config, tier);
    setStatus('Connected');
    return true;
  } catch (_) {
    setStatus('Disconnected');
    showBanner('Tunnel connection failed. Please try again.', null, null);
    return false;
  }
}

async function establishTunnelSession(transientToken) {
  const profile = LocalDB.getProfile();
  if (!Object.keys(profile).length) return;

  const plan1Active = profile.plan1_active || 'no';
  const plan2Active = profile.plan2_active || 'no';
  const dataBalance = parseFloat(profile.data_balance ?? '0') || 0;
  const deviceUuid = profile.device_uuid || 'unassigned_node_uuid';

  try {
    ephemeralKey = await hmacSha256(APP_SECRET, deviceUuid + ':' + transientToken);
  } catch (_) {
    setStatus('Unavailable');
    return;
  }

  if (plan1Active === 'yes' && dataBalance > 0) {
    tier = 'uncapped';
    stopTokenBucket();
  } else if (plan2Active === 'yes') {
    tier = 'clamped';
    startTokenBucket(15);
    if (driver && typeof driver.restrictTethering === 'function') {
      try {
        await driver.restrictTethering();
      } catch (_) {}
    }
  } else {
    tier = 'walled';
    stopTokenBucket();
  }

  const ok = await bindInterface(buildConfig(ephemeralKey, tier));
  if (!ok) stopTokenBucket();
}

async function executeRouterBindingProtocol() {
  setStatus('Binding to SkyNet Access Point...');
  await new Promise((resolve) => setTimeout(resolve, 800));
  await establishTunnelSession('session_init_payload_token');
}

function scanForRouter() {
  const profile = LocalDB.getProfile();
  const detected = profile.online_status === 'on';
  if (detected && !routerAlerted) {
    routerAlerted = true;
    showBanner('SkyNet Router Detected', 'Connect to Router', executeRouterBindingProtocol);
  } else if (!detected) {
    routerAlerted = false;
  }
}

export const SkyNetVpn = {
  get status() {
    return status;
  },
  get tier() {
    return tier;
  },
  onStatus(handler) {
    events.addEventListener('status', (e) => handler(e.detail));
  },
  setTunnelDriver(next) {
    driver = next;
  },
  initialize() {
    if (!navigator.onLine) showBanner('Turn on your Data or Wi-Fi to establish SkyNet connectivity');
    window.addEventListener('offline', () => showBanner('Turn on your Data or Wi-Fi to establish SkyNet connectivity'));
    clearInterval(scanTimer);
    scanTimer = setInterval(() => {
      if (!document.hidden) scanForRouter();
    }, 5000);
  },
  connect: executeRouterBindingProtocol,
  async terminate() {
    stopTokenBucket();
    ephemeralKey = null;
    tier = null;
    try {
      if (driver && typeof driver.disconnect === 'function') await driver.disconnect();
    } catch (_) {}
    setStatus('Disconnected');
  },
  consumeTokensForPacket(size) {
    if (!bucketTimer) return true;
    if (tokens >= size) {
      tokens -= size;
      return true;
    }
    return false;
  },
  dispose() {
    clearInterval(scanTimer);
    stopTokenBucket();
  }
};