import { SkyNetLoader, showAlert, showBanner } from './js/loader.js';

const root = document.documentElement;
const $ = (s, c = document) => (c || document).querySelector(s);
const $$ = (s, c = document) => Array.from((c || document).querySelectorAll(s));
const on = (el, type, fn, opt) => {
  if (el && el.addEventListener) el.addEventListener(type, fn, opt);
};
const mql = (q) => (window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener() {}, addListener() {} });
const watch = (m, fn) => {
  if (m.addEventListener) m.addEventListener('change', fn);
  else if (m.addListener) m.addListener(fn);
};
const safe = (name, fn) => {
  try {
    fn();
  } catch (err) {
    console.warn('[SkyNet site] ' + name + ' failed:', err);
  }
};

const reduce = mql('(prefers-reduced-motion: reduce)').matches;
const hover = mql('(hover: hover)').matches;
const conn = navigator.connection || {};
const lite = reduce || conn.saveData === true || (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);

const SITE = {
  whatsapp: '2348166836059',
  stores: {
    android: 'https://play.google.com/store/apps/details?id=com.skynetwifi',
    ios: '',
    windows: ''
  },
  strip: ['3G', '4G LTE', '5G Ready', 'VPN', 'HD Video Calls', 'SMS & Chat', 'Fast Activation', '24/7 Support', 'Secure PIN', 'Wallet Funding', 'Unlimited Options']
};

const MIN_SHOW = 1100;
const t0 = performance.now();
let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  setTimeout(() => {
    safe('loader-hide', () => SkyNetLoader.hide());
    root.classList.remove('is-loading');
  }, Math.max(0, MIN_SHOW - (performance.now() - t0)));
}

safe('loader-show', () => SkyNetLoader.show('Loading SkyNet WiFi'));
root.classList.add('js');
if (lite) root.classList.add('lite');
if (document.readyState === 'complete') finish();
else on(window, 'load', finish, { once: true });
setTimeout(finish, 4000);
setTimeout(() => root.classList.add('reveal-all'), 6000);

const nav = $('#nav');
const menu = $('#menu');
const scrim = $('#scrim');
const burger = $('#burger');
const ind = $('#ind');
const linksBox = $('#links');
const navLinks = $$('#links a');
const menuItems = $$('.m-item');
let lastFocus = null;
let activeId = 'home';

safe('theme', () => {
  let stored = null;
  try {
    stored = localStorage.getItem('skynet_site_theme');
  } catch (_) {}
  const apply = (mode) => {
    root.dataset.theme = mode;
    const meta = $('#themeColor');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#050f2b' : '#f4f8ff');
    const use = $('#theme use');
    if (use) use.setAttribute('href', mode === 'dark' ? '#i-sun' : '#i-moon');
  };
  apply(stored || (mql('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  on($('#theme'), 'click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      localStorage.setItem('skynet_site_theme', next);
    } catch (_) {}
  });
});

safe('strip', () => {
  const strip = $('#strip');
  if (!strip) return;
  const items = SITE.strip.map((t) => '<span><svg class="ic" aria-hidden="true"><use href="#i-check"/></svg>' + t.replace(/&/g, '&amp;') + '</span>').join('');
  strip.innerHTML = items + items;
});

safe('year', () => {
  const y = $('#year');
  if (y) y.textContent = new Date().getFullYear();
});

function setMenu(open) {
  if (!menu) return;
  menu.classList.toggle('open', open);
  if (scrim) scrim.classList.toggle('show', open);
  if (burger) {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  menu.inert = !open;
  root.classList.toggle('lock', open);
  if (open) {
    lastFocus = document.activeElement;
    setTimeout(() => {
      const first = $('.m-item', menu);
      if (first) first.focus();
    }, 250);
  } else if (lastFocus && lastFocus.focus) {
    lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
}

const isOpen = () => !!(menu && menu.classList.contains('open'));

safe('menu', () => {
  menuItems.forEach((el, i) => el.style.setProperty('--i', i));
  on(burger, 'click', () => setMenu(!isOpen()));
  on($('#menuClose'), 'click', () => setMenu(false));
  on(scrim, 'click', () => setMenu(false));
  on(document, 'keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      setMenu(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const f = $$('a, button', menu).filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  watch(mql('(min-width: 1100px)'), (e) => {
    if (e.matches && isOpen()) setMenu(false);
  });
});

safe('anchors', () => {
  on(document, 'click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[data-nav]') : null;
    if (!a) return;
    const hash = a.getAttribute('href');
    if (!hash || hash.charAt(0) !== '#' || hash.length < 2) return;
    const target = $(hash);
    if (!target) return;
    e.preventDefault();
    const wasOpen = isOpen();
    if (wasOpen) setMenu(false);
    setTimeout(() => {
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      try {
        history.replaceState(null, '', hash);
      } catch (_) {}
    }, wasOpen ? 60 : 0);
  });
});

function moveIndicator(el) {
  if (!el || !ind || !linksBox || getComputedStyle(linksBox).display === 'none') return;
  const box = linksBox.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  ind.style.setProperty('--ix', r.left - box.left + 14 + 'px');
  ind.style.setProperty('--iw', Math.max(10, r.width - 28) + 'px');
}

function setActive(id) {
  activeId = id;
  let current = null;
  navLinks.forEach((a) => {
    const onIt = a.getAttribute('href') === '#' + id;
    a.classList.toggle('on', onIt);
    if (onIt) current = a;
  });
  menuItems.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + id));
  moveIndicator(current);
}

safe('spy', () => {
  if (!('IntersectionObserver' in window)) return;
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) setActive(en.target.id);
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
  $$('main section[id]').forEach((s) => spy.observe(s));
  on(window, 'resize', () => setActive(activeId), { passive: true });
  setActive('home');
});

safe('scroll', () => {
  const bar = $('#progress');
  const topBtn = $('#top');
  let lastY = 0;
  let ticking = false;
  const update = () => {
    ticking = false;
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar) bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0) + ')';
    if (nav) {
      nav.classList.toggle('scrolled', y > 24);
      nav.classList.toggle('hide', y > lastY + 6 && y > 500 && !isOpen());
      if (y < lastY - 6 || y < 500) nav.classList.remove('hide');
    }
    if (topBtn) topBtn.classList.toggle('show', y > 900);
    lastY = y;
  };
  on(window, 'scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  on(topBtn, 'click', () => window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }));
  update();
});

const fmt = (n, dec, suffix) => n.toFixed(dec) + (suffix || '');

function countUp(el) {
  const end = parseFloat(el.dataset.count);
  if (Number.isNaN(end)) return;
  const dec = parseInt(el.dataset.dec || '0', 10);
  const suffix = el.dataset.suffix || '';
  if (reduce) {
    el.textContent = fmt(end, dec, suffix);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 1600);
    el.textContent = fmt(end * (1 - Math.pow(1 - p, 3)), dec, suffix);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

safe('reveal', () => {
  const targets = $$('.reveal');
  const steps = $('#steps');
  if (steps) targets.push(steps);
  if (!('IntersectionObserver' in window)) {
    root.classList.add('reveal-all');
    return;
  }
  const gaugeVal = $('#gaugeVal');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const el = en.target;
      el.classList.add('in');
      $$('[data-count]', el).forEach(countUp);
      if (el.matches('[data-count]')) countUp(el);
      if (el.id === 'gauge' && gaugeVal) gaugeVal.style.strokeDashoffset = String(283 * 0.18);
      io.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  targets.forEach((el) => io.observe(el));
});

safe('live', () => {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => en.target.classList.toggle('live', en.isIntersecting));
  }, { rootMargin: '120px 0px' });
  $$('.sec').forEach((s) => io.observe(s));
});

safe('rotor', () => {
  const rotor = $('#rotor');
  if (!rotor || reduce) return;
  const words = ['fast data', 'a built-in VPN', 'HD video calls', 'instant messages'];
  let i = 0;
  setInterval(() => {
    if (document.hidden) return;
    rotor.classList.add('out');
    setTimeout(() => {
      i = (i + 1) % words.length;
      rotor.textContent = words[i];
      rotor.classList.remove('out');
    }, 380);
  }, 2800);
});

safe('tilt', () => {
  const vis = $('#vis');
  const dash = $('#dash');
  if (!vis || !dash || !hover || lite) return;
  on(vis, 'pointermove', (e) => {
    const r = vis.getBoundingClientRect();
    dash.style.setProperty('--ry', ((e.clientX - r.left) / r.width - 0.5) * 12 + 'deg');
    dash.style.setProperty('--rx', -((e.clientY - r.top) / r.height - 0.5) * 10 + 'deg');
  });
  on(vis, 'pointerleave', () => {
    dash.style.setProperty('--ry', '0deg');
    dash.style.setProperty('--rx', '0deg');
  });
});

safe('spotlight', () => {
  const bento = $('#bento');
  if (!bento || !hover) return;
  on(bento, 'pointermove', (e) => {
    const card = e.target.closest ? e.target.closest('.bc') : null;
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', e.clientX - r.left + 'px');
    card.style.setProperty('--my', e.clientY - r.top + 'px');
  });
});

safe('globe', () => {
  const canvas = $('#globe');
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!canvas || !ctx) return;
  const N = 64;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.399963;
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r });
  }
  let w = 1;
  let h = 1;
  let rot = 0;
  let running = false;
  let last = 0;

  const size = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = canvas.width = Math.max(1, Math.round(r.width * dpr));
    h = canvas.height = Math.max(1, Math.round(r.height * dpr));
  };

  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    const R = Math.min(w, h) * 0.4;
    const cx = w / 2;
    const cy = h / 2;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const grd = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.05);
    grd.addColorStop(0, 'rgba(30,140,255,0.16)');
    grd.addColorStop(1, 'rgba(30,140,255,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,140,255,0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    [0.5, 0.86].forEach((k) => {
      ctx.beginPath();
      ctx.ellipse(cx, cy, R, R * k * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke();
    });
    const p = pts.map((q) => ({ x: cx + (q.x * c + q.z * s) * R, y: cy + q.y * R, z: -q.x * s + q.z * c }));
    const lim = R * 0.46;
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        if (p[i].z < -0.15 && p[j].z < -0.15) continue;
        const dx = p[i].x - p[j].x;
        const dy = p[i].y - p[j].y;
        const d = dx * dx + dy * dy;
        if (d < lim * lim) {
          ctx.strokeStyle = 'rgba(30,140,255,' + (0.35 * (1 - d / (lim * lim)) * (0.5 + (p[i].z + p[j].z) / 4)).toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(p[i].x, p[i].y);
          ctx.lineTo(p[j].x, p[j].y);
          ctx.stroke();
        }
      }
    }
    p.forEach((q, i) => {
      const a = 0.25 + 0.75 * ((q.z + 1) / 2);
      ctx.fillStyle = (i % 9 === 0 ? 'rgba(124,92,255,' : 'rgba(30,140,255,') + a + ')';
      ctx.beginPath();
      ctx.arc(q.x, q.y, (1.4 + 1.8 * ((q.z + 1) / 2)) * (w / 600), 0, Math.PI * 2);
      ctx.fill();
    });
  };

  const frame = (t) => {
    if (!running) return;
    requestAnimationFrame(frame);
    if (t - last < 34) return;
    last = t;
    rot += 0.007;
    draw();
  };

  size();
  draw();
  if (lite || !('IntersectionObserver' in window)) return;
  on(window, 'resize', () => {
    size();
    draw();
  }, { passive: true });
  new IntersectionObserver((entries) => {
    const visible = entries[0].isIntersecting && !document.hidden;
    if (visible && !running) {
      running = true;
      requestAnimationFrame(frame);
    } else if (!visible) {
      running = false;
    }
  }).observe(canvas);
  on(document, 'visibilitychange', () => {
    if (document.hidden) running = false;
  });
});

const ua = navigator.userAgent || '';
const platform = /android/i.test(ua) ? 'android' : /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : /windows/i.test(ua) ? 'windows' : null;

safe('stores', () => {
  $$('.tile').forEach((tile) => {
    const key = tile.dataset.store;
    const url = SITE.stores[key];
    if (url) {
      tile.href = url;
      tile.target = '_blank';
      tile.rel = 'noopener';
    } else {
      tile.classList.add('soon');
      tile.setAttribute('role', 'button');
      const go = $('.go', tile);
      if (go && go.lastChild) go.lastChild.textContent = ' Coming soon';
      on(tile, 'click', (e) => {
        e.preventDefault();
        showAlert('This store version is coming soon. Use the web app install option below.', false);
      });
    }
    if (key === platform) {
      const tag = document.createElement('span');
      tag.className = 'rec';
      tag.textContent = 'For your device';
      tile.appendChild(tag);
    }
  });
});

safe('install', () => {
  const bar = $('#installBar');
  const btn = $('#installBtn');
  const text = $('#installText');
  if (!bar) return;
  const standalone = mql('(display-mode: standalone)').matches || navigator.standalone === true;
  let deferred = null;
  on(window, 'beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if (!standalone) bar.hidden = false;
  });
  if (platform === 'ios' && !standalone) {
    if (text) text.textContent = 'On iPhone or iPad: tap Share, then Add to Home Screen to install SkyNet WiFi.';
    if (btn) btn.hidden = true;
    bar.hidden = false;
  }
  on(btn, 'click', async () => {
    if (!deferred) return;
    deferred.prompt();
    const choice = await deferred.userChoice;
    deferred = null;
    bar.hidden = true;
    if (choice && choice.outcome === 'accepted') showAlert('SkyNet WiFi is being installed.', true);
  });
  on(window, 'appinstalled', () => {
    bar.hidden = true;
  });
});

safe('copy', () => {
  $$('[data-copy]').forEach((btn) => {
    on(btn, 'click', async () => {
      const text = btn.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
        } catch (_) {}
        ta.remove();
      }
      showAlert('Copied: ' + text, true);
    });
  });
});

safe('faq', () => {
  const qa = $('#qa');
  on(qa, 'toggle', (e) => {
    if (!e.target.open) return;
    $$('details', qa).forEach((d) => {
      if (d !== e.target) d.open = false;
    });
  }, true);
});

safe('form', () => {
  const form = $('#form');
  const name = $('#fName');
  const msg = $('#fMsg');
  const phone = $('#fPhone');
  if (!form || !name || !msg) return;
  const flag = (input, bad) => {
    const box = input.closest('.fld');
    if (box) box.classList.toggle('bad', bad);
  };
  on(form, 'input', (e) => flag(e.target, false));
  on(form, 'submit', (e) => {
    e.preventDefault();
    const badName = name.value.trim().length < 2;
    const badMsg = msg.value.trim().length < 5;
    flag(name, badName);
    flag(msg, badMsg);
    if (badName || badMsg) {
      showAlert('Please enter your name and a short message.', false);
      return;
    }
    const text = 'Hello SkyNet WiFi, my name is ' + name.value.trim() + (phone && phone.value.trim() ? ' (' + phone.value.trim() + ')' : '') + '. ' + msg.value.trim();
    window.open('https://wa.me/' + SITE.whatsapp + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
    form.reset();
    showAlert('Opening WhatsApp to send your message.', true);
  });
});

safe('map', () => {
  on($('#mapBtn'), 'click', () => {
    const box = $('#mapbox');
    if (!box) return;
    const frame = document.createElement('iframe');
    frame.src = 'https://www.google.com/maps?q=Gusau,Zamfara,Nigeria&output=embed';
    frame.title = 'SkyNet WiFi location in Gusau, Zamfara';
    frame.loading = 'lazy';
    frame.referrerPolicy = 'no-referrer-when-downgrade';
    frame.allowFullscreen = true;
    box.appendChild(frame);
    const face = $('#mapface');
    if (face) face.remove();
  });
});

safe('offline', () => {
  on(window, 'offline', () => showBanner('You are offline. Some content may not load.'));
});

safe('sw-cleanup', () => {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => r.unregister())).catch(() => {});
  }
});

on(window, 'error', (e) => console.warn('[SkyNet site] runtime error:', e.message));