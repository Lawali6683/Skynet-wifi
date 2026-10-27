import { store } from './config.js';
import { icon } from './icons.js';
import { SkyNetLoader, showAlert } from './loader.js';

const PERMS = [
  { key: 'accessibility', kind: 'native', title: 'Accessibility Guard', desc: 'Intercepts network dialer requests to manage shortcodes.' },
  { key: 'tunnel', kind: 'native', title: 'VPN Secure Tunnel', desc: 'Establishes a local virtual private tunnel network.' },
  { key: 'camera', kind: 'camera', title: 'Video Call Matrix', desc: 'Enables hardware camera access for high-definition video feeds.' },
  { key: 'microphone', kind: 'microphone', title: 'Voice Audio Input', desc: 'Enables microphone access with localized audio filtering.' },
  { key: 'wifi', kind: 'native', title: 'Local Wi-Fi Controller', desc: 'Manages native network interface links and speed capping.' },
  { key: 'location', kind: 'location', title: 'Network Geolocation Link', desc: 'Required to scan and hook nearby local Wi-Fi routers.' },
  { key: 'alarm', kind: 'notification', title: 'System Alarm Protocol', desc: 'Enables alarm synchronization schedules and push notifications.' },
  { key: 'audio', kind: 'audio', title: 'Ringtone & Audio Engine', desc: 'Manages audio levels, ringtone streaming, and text-to-speech outputs.' }
];

const grid = document.getElementById('grid');
const goBtn = document.getElementById('go');
const saved = store.get('perm_state', {}) || {};
const granted = {};

function persist() {
  store.set('perm_state', granted);
}

async function liveStatus(item) {
  try {
    if (item.kind === 'camera' || item.kind === 'microphone' || item.kind === 'location') {
      if (!navigator.permissions) return null;
      const name = item.kind === 'location' ? 'geolocation' : item.kind;
      const result = await navigator.permissions.query({ name });
      return result.state === 'granted';
    }
    if (item.kind === 'notification') {
      return 'Notification' in window ? Notification.permission === 'granted' : null;
    }
  } catch (_) {}
  return null;
}

function stopStream(stream) {
  stream.getTracks().forEach((t) => t.stop());
}

async function requestPermission(item) {
  switch (item.kind) {
    case 'camera':
      stopStream(await navigator.mediaDevices.getUserMedia({ video: true }));
      return true;
    case 'microphone':
      stopStream(await navigator.mediaDevices.getUserMedia({ audio: true }));
      return true;
    case 'location':
      await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 15000 }));
      return true;
    case 'notification':
      if (!('Notification' in window)) return true;
      return (await Notification.requestPermission()) === 'granted';
    case 'audio': {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        await ctx.resume();
        const ok = ctx.state === 'running';
        ctx.close();
        return ok;
      }
      return true;
    }
    default:
      return true;
  }
}

function render() {
  grid.innerHTML = '';
  PERMS.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'perm-item' + (granted[item.key] ? ' done' : '');
    btn.style.animationDelay = i * 0.05 + 's';
    btn.innerHTML =
      '<span class="pi">' + icon(granted[item.key] ? 'shieldcheck' : 'shield', 18) + '</span>' +
      '<span class="tx"><b></b><span></span></span>' +
      '<span class="st">' + icon(granted[item.key] ? 'checkcircle' : 'radio', 20) + '</span>';
    btn.querySelector('b').textContent = item.title;
    btn.querySelector('.tx span').textContent = item.desc;
    btn.addEventListener('click', async () => {
      try {
        granted[item.key] = await requestPermission(item);
        if (!granted[item.key]) showAlert(item.title + ' was not granted', false);
      } catch (_) {
        granted[item.key] = false;
        showAlert(item.title + ' was denied. Allow it from device settings.', false);
      }
      persist();
      render();
    });
    grid.appendChild(btn);
  });
  goBtn.disabled = !PERMS.every((p) => granted[p.key]);
}

goBtn.addEventListener('click', () => {
  store.set('is_setup_done', true);
  SkyNetLoader.show();
  location.replace('register.html');
});

(async function init() {
  for (const item of PERMS) {
    const live = await liveStatus(item);
    granted[item.key] = live === null ? !!saved[item.key] : live;
  }
  persist();
  render();
})();