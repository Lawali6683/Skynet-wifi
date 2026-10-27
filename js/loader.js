const LOGO = 'assets/images/icon.png';

let loaderEl = null;
let alertEl = null;
let alertTimer = null;

function buildLoader() {
  loaderEl = document.createElement('div');
  loaderEl.className = 'sn-loader';
  loaderEl.innerHTML =
    '<div class="sn-loader-box"><span class="blob b1"></span><span class="blob b2"></span>' +
    '<div class="core"><img src="' + LOGO + '" alt=""></div></div>' +
    '<p class="sn-loader-text"></p>';
  document.body.appendChild(loaderEl);
}

export const SkyNetLoader = {
  show(text = '') {
    if (!loaderEl) buildLoader();
    loaderEl.querySelector('.sn-loader-text').textContent = text;
    loaderEl.classList.add('show');
  },
  hide() {
    if (loaderEl) loaderEl.classList.remove('show');
  }
};

const ICON_OK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>';
const ICON_ERR = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.2v.1"/></svg>';

export function showAlert(message, isSuccess = false) {
  if (!alertEl) {
    alertEl = document.createElement('div');
    alertEl.className = 'sn-alert';
    alertEl.setAttribute('role', 'alert');
    document.body.appendChild(alertEl);
  }
  alertEl.className = 'sn-alert ' + (isSuccess ? 'ok' : 'err');
  alertEl.innerHTML = (isSuccess ? ICON_OK : ICON_ERR) + '<span></span>';
  alertEl.querySelector('span').textContent = message;
  requestAnimationFrame(() => alertEl.classList.add('show'));
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => alertEl.classList.remove('show'), 4000);
}

let bannerEl = null;
let bannerTimer = null;

export function showBanner(message, actionText = null, onAction = null, duration = 12000) {
  if (bannerEl) bannerEl.remove();
  clearTimeout(bannerTimer);

  bannerEl = document.createElement('div');
  bannerEl.className = 'sn-banner';
  bannerEl.setAttribute('role', 'status');
  bannerEl.innerHTML = '<span class="msg"></span>';
  bannerEl.querySelector('.msg').textContent = message;

  const dismiss = () => {
    if (!bannerEl) return;
    const el = bannerEl;
    bannerEl = null;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  };

  if (actionText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = actionText;
    btn.addEventListener('click', () => {
      dismiss();
      if (typeof onAction === 'function') onAction();
    });
    bannerEl.appendChild(btn);
  }

  document.body.appendChild(bannerEl);
  requestAnimationFrame(() => bannerEl && bannerEl.classList.add('show'));
  bannerTimer = setTimeout(dismiss, actionText ? duration : 3000);
}
import('./logger.js').catch(() => {});

const PRESS = '.btn, .plan-btn, .plan-others, .tier, .key, .ctrl, .icon-btn, .perm-item, .tab, .copy-btn, .mini, .quick button, .token button';

document.addEventListener('pointerdown', (e) => {
  const el = e.target && e.target.closest ? e.target.closest(PRESS) : null;
  if (!el || el.disabled) return;
  const box = el.getBoundingClientRect();
  const size = Math.max(box.width, box.height) * 2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.width = dot.style.height = size + 'px';
  dot.style.left = e.clientX - box.left - size / 2 + 'px';
  dot.style.top = e.clientY - box.top - size / 2 + 'px';
  el.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove());
  try {
    if (navigator.vibrate) navigator.vibrate(6);
  } catch (_) {}
}, { passive: true });