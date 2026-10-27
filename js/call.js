import { LocalDB } from './db.js';
import { API_BASE, store } from './config.js';
import { supabase, authHeaders } from './supabase.js';
import { icon } from './icons.js';
import { SkyNetLoader, showAlert } from './loader.js';
import { mountPinRow } from './pin.js';

if (!store.get('is_logged_in', false)) location.replace('login.html');

const $ = (id) => document.getElementById(id);
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const RING_TIMEOUT = 35000;
const TABS = [
  { key: 'Contact', label: 'Contact', icon: 'phone' },
  { key: 'Missed', label: 'Missed Call', icon: 'history' },
  { key: 'Share', label: 'Share to my contact', icon: 'gift' },
  { key: 'Sync', label: 'More', icon: 'refresh' }
];

let me = { id: '', name: '' };
let registered = store.get('call_registered', []) || [];
let unregistered = store.get('call_unregistered', []) || [];
let localContacts = store.get('local_contacts', []) || [];
let blocked = new Set(store.get('blocked_uuids', []) || []);
let activeTab = 'Contact';
let expanded = null;
let msgTarget = null;

let pc = null;
let localStream = null;
let callChannel = null;
let inbox = null;
let call = null;
let ringTimer = null;
let durationTimer = null;
let pendingIce = [];
let loud = false;
let pinRow = null;
let incomingTimer = null;

$('back').innerHTML = icon('back', 22);
$('pip-close').innerHTML = icon('close', 14);

function normalize(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (/^0\d{10}$/.test(d)) return '+234' + d.slice(1);
  if (/^234\d{10}$/.test(d)) return '+' + d;
  return d;
}

function nameFor(contact) {
  const local = localContacts.find((c) => normalize(c.phone) === normalize(contact.phone_number));
  return (local && local.name) || contact.full_name || contact.local_contact_name || 'Unknown Member';
}

function videoActive() {
  const p = LocalDB.getProfile();
  return p.video_call_enabled === 'yes' && (parseInt(p.video_plan_days ?? '0', 10) || 0) > 0;
}

function header() {
  const p = LocalDB.getProfile();
  const days = parseInt(p.video_plan_days ?? '0', 10) || 0;
  const online = p.online_friends_count ?? '—';
  $('sub').textContent = online + ' Friends Online | Video Plan: ' + (videoActive() ? days + ' Days Left' : 'Expired');
}

function renderTabs() {
  $('tabs').innerHTML = '';
  TABS.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'tab' + (activeTab === t.key ? ' on' : '');
    b.innerHTML = icon(t.icon, 18) + '<span>' + t.label + '</span>';
    b.addEventListener('click', () => {
      if (t.key === 'Missed') openMissed();
      else if (t.key === 'Sync') sync();
      else {
        activeTab = t.key;
        expanded = null;
        renderTabs();
        renderList();
      }
    });
    $('tabs').appendChild(b);
  });
}

function renderList() {
  const box = $('list');
  box.innerHTML = '';

  if (activeTab === 'Contact') {
    if (!registered.length) {
      box.innerHTML = '<div class="call-empty">No registered core contacts found.<br>Tap "Add / Import Contacts" then "Sync Contacts".</div>';
      return;
    }
    registered.forEach((c, i) => {
      const isOpen = expanded === i;
      const el = document.createElement('div');
      el.className = 'contact';
      const name = nameFor(c);
      el.innerHTML =
        '<div class="row"><span class="avatar-s"></span><span class="nm"><span class="n"></span><small class="s"></small></span>' +
        '<button class="mini" data-a="menu" aria-label="Options">' + icon('menu', 18) + '</button></div>';
      const av = el.querySelector('.avatar-s');
      if (c.profile_url && /^https?:\/\//i.test(c.profile_url)) {
        const img = new Image();
        img.src = c.profile_url;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => { av.textContent = name[0] || 'U'; img.remove(); });
        av.appendChild(img);
      } else {
        av.textContent = name[0] || 'U';
      }
      el.querySelector('.n').textContent = name;
      el.querySelector('.s').textContent = blocked.has(c.uuid) ? 'Blocked' : '';
      el.querySelector('.row').addEventListener('click', () => {
        expanded = isOpen ? null : i;
        renderList();
      });
      el.querySelector('[data-a="menu"]').addEventListener('click', (e) => {
        e.stopPropagation();
        contactMenu(c, i);
      });
      if (isOpen) {
        const q = document.createElement('div');
        q.className = 'quick';
        q.innerHTML =
          '<button data-k="audio" aria-label="Audio call" style="color:#2e7d32">' + icon('phone', 20) + '</button>' +
          '<button data-k="video" aria-label="Video call" style="color:#1976d2">' + icon('laptop', 20) + '</button>' +
          '<button data-k="msg" aria-label="Message" style="color:#ef6c00">' + icon('bell', 20) + '</button>';
        q.querySelector('[data-k="audio"]').addEventListener('click', () => startCall(c, 'audio'));
        q.querySelector('[data-k="video"]').addEventListener('click', () => startCall(c, 'video'));
        q.querySelector('[data-k="msg"]').addEventListener('click', () => openMessage(c));
        el.appendChild(q);
      }
      box.appendChild(el);
    });
    return;
  }

  const list = unregistered;
  if (!list.length) {
    box.innerHTML = '<div class="call-empty">No unregistered contacts.</div>';
    return;
  }
  const p = LocalDB.getProfile();
  const link = p.referral_link || (p.referral_code ? 'https://skynetwifi.pages.dev/ref/' + p.referral_code : 'https://skynetwifi.pages.dev');
  list.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'contact';
    el.innerHTML = '<div class="row"><span class="nm"><span class="n"></span><small class="s"></small></span><button class="btn" style="width:auto;height:34px;padding:0 12px;font-size:11px">Invite via SMS</button></div>';
    el.querySelector('.n').textContent = nameFor(c);
    el.querySelector('.s').textContent = c.phone_number || '';
    el.querySelector('button').addEventListener('click', () => {
      const body = 'Join me on SkyNet WiFi: ' + link;
      location.href = 'sms:' + encodeURIComponent(c.phone_number || '') + '?body=' + encodeURIComponent(body);
    });
    box.appendChild(el);
  });
}

function contactMenu(c, i) {
  const choice = window.prompt('Type 1 to Delete Contact, or 2 to Block/Unblock.', '');
  if (choice === '1') {
    registered.splice(i, 1);
    store.set('call_registered', registered);
    expanded = null;
    renderList();
  } else if (choice === '2') {
    if (blocked.has(c.uuid)) blocked.delete(c.uuid);
    else blocked.add(c.uuid);
    store.set('blocked_uuids', Array.from(blocked));
    renderList();
  }
}

async function pickContacts() {
  if ('contacts' in navigator && 'ContactsManager' in window) {
    try {
      const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
      picked.forEach((p) => {
        const phone = normalize((p.tel || [])[0]);
        if (phone) localContacts.push({ name: (p.name || [])[0] || phone, phone });
      });
      store.set('local_contacts', dedupe(localContacts));
      localContacts = store.get('local_contacts', []);
      showAlert(picked.length + ' contacts imported.', true);
      return;
    } catch (_) {}
  }
  $('add').classList.add('show');
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => {
    if (!c.phone || seen.has(c.phone)) return false;
    seen.add(c.phone);
    return true;
  });
}

async function sync() {
  const phones = dedupe(localContacts).map((c) => c.phone).slice(0, 500);
  if (!phones.length) {
    showAlert('Add or import contacts first.', false);
    return;
  }
  if (!store.get('contacts_consent', false)) {
    if (!window.confirm('SkyNet will send the phone numbers you selected to find which friends use SkyNet WiFi. Continue?')) return;
    store.set('contacts_consent', true);
  }
  SkyNetLoader.show('Synchronizing contacts...');
  try {
    const res = await fetch(API_BASE + 'mycontct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ phones })
    });
    const data = await res.json().catch(() => ({}));
    SkyNetLoader.hide();
    if (res.status !== 200) {
      showAlert('Contact sync failed. Try again later.', false);
      return;
    }
    registered = (Array.isArray(data.registered) ? data.registered : []).filter((c) => c.uuid !== me.id);
    unregistered = Array.isArray(data.unregistered) ? data.unregistered : [];
    store.set('call_registered', registered);
    store.set('call_unregistered', unregistered);
    renderList();
  } catch (_) {
    SkyNetLoader.hide();
    showAlert('Network connection lost. Please check your interface', false);
  }
}

function openMissed() {
  const list = $('missed-list');
  list.innerHTML = '';
  const items = LocalDB.getProfile().missed_calls || [];
  if (!items.length) list.innerHTML = '<li>No missed call parameters recorded.</li>';
  items.slice().reverse().forEach((m) => {
    const li = document.createElement('li');
    li.textContent = m.caller_name || 'Unknown Caller';
    const s = document.createElement('small');
    s.textContent = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
    li.appendChild(s);
    list.appendChild(li);
  });
  $('missed').classList.add('show');
}

function recordMissed(name) {
  const p = LocalDB.getProfile();
  const arr = Array.isArray(p.missed_calls) ? p.missed_calls : [];
  arr.push({ caller_name: name, timestamp: new Date().toISOString() });
  p.missed_calls = arr.slice(-50);
  LocalDB.setProfile(p);
}

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (_) {}
}

function failAlert(text) {
  showAlert(text, false);
  speak(text);
}

async function api(path, body) {
  return fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body)
  });
}

function openMessage(c) {
  msgTarget = c;
  $('msg-title').textContent = 'Message to ' + nameFor(c);
  $('msg-text').value = '';
  $('msg').classList.add('show');
}

$('msg-send').addEventListener('click', async () => {
  const text = $('msg-text').value.trim();
  if (!text || !msgTarget) return;
  try {
    const res = await api('massage', { target_uuid: msgTarget.uuid, phone: msgTarget.phone_number, payload: text });
    $('msg').classList.remove('show');
    showAlert(res.status === 200 ? 'Message sent.' : 'Message failed.', res.status === 200);
  } catch (_) {
    showAlert('Network connection lost. Please check your interface', false);
  }
});
$('msg-cancel').addEventListener('click', () => $('msg').classList.remove('show'));

function openUpgrade() {
  if (!pinRow) pinRow = mountPinRow($('up-pin'), (ok) => { $('up-pay').disabled = !ok; });
  pinRow.reset();
  $('upgrade').classList.add('show');
}

$('up-cancel').addEventListener('click', () => $('upgrade').classList.remove('show'));
$('up-pay').addEventListener('click', async () => {
  const pin = pinRow.value();
  SkyNetLoader.show('Processing payment...');
  try {
    const res = await api('pay', { amount: 3000, pin, idem: crypto.randomUUID() });
    SkyNetLoader.hide();
    if (res.status === 200) {
      await LocalDB.syncProfile();
      header();
      $('upgrade').classList.remove('show');
      showAlert('Video plan activated.', true);
    } else {
      const d = await res.json().catch(() => ({}));
      showAlert(d.message || 'Payment failed. Check your wallet balance.', false);
    }
  } catch (_) {
    SkyNetLoader.hide();
    showAlert('Network connection lost. Please check your interface', false);
  }
});

function media(kind) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return navigator.mediaDevices.getUserMedia(
    kind === 'video'
      ? { audio, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } }
      : { audio }
  );
}

function newPeer() {
  const p = new RTCPeerConnection(ICE);
  p.onicecandidate = (e) => {
    if (e.candidate) sendSignal('ice', { c: e.candidate });
  };
  p.ontrack = (e) => {
    $('remote').srcObject = e.streams[0];
  };
  p.onconnectionstatechange = () => {
    if (p.connectionState === 'connected') onConnected();
    if (p.connectionState === 'failed' || p.connectionState === 'closed') endCall(false);
  };
  localStream.getTracks().forEach((t) => p.addTrack(t, localStream));
  return p;
}

function sendSignal(event, payload) {
  if (callChannel) callChannel.send({ type: 'broadcast', event, payload });
}

async function joinCallChannel(id) {
  callChannel = supabase.channel('call:' + id, { config: { private: true, broadcast: { self: false } } });
  callChannel
    .on('broadcast', { event: 'accepted' }, async () => {
      if (!call || call.role !== 'caller' || !pc) return;
      clearTimeout(ringTimer);
      $('who-state').textContent = 'Connecting...';
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal('offer', { sdp: offer });
    })
    .on('broadcast', { event: 'offer' }, async ({ payload }) => {
      if (!pc) return;
      await pc.setRemoteDescription(payload.sdp);
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal('answer', { sdp: answer });
    })
    .on('broadcast', { event: 'answer' }, async ({ payload }) => {
      if (!pc) return;
      await pc.setRemoteDescription(payload.sdp);
      await flushIce();
    })
    .on('broadcast', { event: 'ice' }, async ({ payload }) => {
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(payload.c); } catch (_) {}
      } else {
        pendingIce.push(payload.c);
      }
    })
    .on('broadcast', { event: 'hangup' }, () => endCall(false));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('channel timeout')), 8000);
    callChannel.subscribe((s) => {
      if (s === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
      if (s === 'CHANNEL_ERROR') { clearTimeout(t); reject(new Error('channel error')); }
    });
  });
}

async function flushIce() {
  const list = pendingIce;
  pendingIce = [];
  for (const c of list) {
    try { await pc.addIceCandidate(c); } catch (_) {}
  }
}

function showCallUi(name, kind, state) {
  $('who-name').textContent = name;
  $('who-av').textContent = (name[0] || 'U').toUpperCase();
  $('who-state').textContent = state;
  $('who').style.display = kind === 'video' ? 'none' : 'block';
  $('pip').classList.toggle('hidden', kind !== 'video');
  $('local').srcObject = kind === 'video' ? localStream : null;
  $('ctrls').innerHTML =
    '<button class="ctrl" id="spk" aria-label="Speaker">' + icon('bolt', 26) + '</button>' +
    '<button class="ctrl red" id="hang" aria-label="End call">' + icon('phone', 28) + '</button>';
  $('spk').addEventListener('click', toggleSpeaker);
  $('hang').addEventListener('click', () => endCall(true));
  $('incall').classList.add('show');
}

function toggleSpeaker() {
  loud = !loud;
  $('who-state').textContent = loud ? 'Loudspeaker Active' : 'Connected via Ear-Speaker';
  const el = $('remote');
  if (typeof el.setSinkId === 'function') el.setSinkId('default').catch(() => {});
}

function onConnected() {
  if (!call || call.connected) return;
  call.connected = true;
  clearTimeout(ringTimer);
  const started = Date.now();
  $('who-state').textContent = 'Connected via Ear-Speaker';
  durationTimer = setInterval(() => {
    if (!loud) {
      const s = Math.floor((Date.now() - started) / 1000);
      $('who-state').textContent = 'Connected ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }
  }, 1000);
}

async function endCall(notify) {
  if (!call && !pc && !localStream) return;
  clearTimeout(ringTimer);
  clearInterval(durationTimer);
  if (notify) sendSignal('hangup', {});
  const wasCall = !!call;
  const ch = callChannel;
  callChannel = null;
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  $('remote').srcObject = null;
  $('local').srcObject = null;
  $('incall').classList.remove('show');
  pendingIce = [];
  call = null;
  loud = false;
  if (ch) setTimeout(() => supabase.removeChannel(ch), 500);
  if (notify && wasCall) speak('Call ended by user');
}

async function startCall(contact, kind) {
  if (call) return;
  if (blocked.has(contact.uuid)) {
    showAlert('This contact is blocked.', false);
    return;
  }
  if (kind === 'video' && !videoActive()) {
    openUpgrade();
    return;
  }
  SkyNetLoader.show('Calling...');
  try {
    const res = await api(kind === 'video' ? 'videocall' : 'call', { target_uuid: contact.uuid, type: kind });
    if (res.status !== 200) {
      SkyNetLoader.hide();
      failAlert('The user you are trying to reach is unavailable');
      return;
    }
    const id = crypto.randomUUID();
    localStream = await media(kind);
    call = { id, role: 'caller', kind, connected: false };
    await joinCallChannel(id);
    pc = newPeer();
    SkyNetLoader.hide();
    showCallUi(nameFor(contact), kind, 'Ringing...');
    await sendInvite(contact.uuid, { callId: id, kind, from: me.id, name: me.name });
    ringTimer = setTimeout(() => {
      if (call && !call.connected) {
        endCall(true);
        failAlert('The user you are trying to reach is unavailable');
      }
    }, RING_TIMEOUT);
  } catch (err) {
    SkyNetLoader.hide();
    await endCall(false);
    failAlert(err && err.name === 'NotAllowedError' ? 'Camera or microphone permission denied' : 'Network connection lost. Please check your interface');
  }
}

async function sendInvite(uuid, payload) {
  const ch = supabase.channel('inbox:' + uuid, { config: { private: true } });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('invite timeout')), 8000);
    ch.subscribe((s) => {
      if (s === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
    });
  });
  await ch.send({ type: 'broadcast', event: 'invite', payload });
  setTimeout(() => supabase.removeChannel(ch), 2000);
}

function onInvite(payload) {
  if (!payload || !payload.callId || call || blocked.has(payload.from)) return;
  const kind = payload.kind === 'video' ? 'video' : 'audio';
  const name = String(payload.name || 'Unknown Caller').slice(0, 40);
  $('who-name').textContent = name;
  $('who-av').textContent = (name[0] || 'U').toUpperCase();
  $('who-state').textContent = 'Incoming ' + kind + ' call...';
  $('who').style.display = 'block';
  $('pip').classList.add('hidden');
  $('ctrls').innerHTML =
    '<button class="ctrl red" id="dec" aria-label="Decline">' + icon('phone', 28) + '</button>' +
    '<button class="ctrl green" id="acc" aria-label="Accept">' + icon('phone', 28) + '</button>';
  $('incall').classList.add('show');
  speak('Incoming call from ' + name);

  incomingTimer = setTimeout(() => {
    recordMissed(name);
    $('incall').classList.remove('show');
  }, 30000);

  $('dec').addEventListener('click', async () => {
    clearTimeout(incomingTimer);
    $('incall').classList.remove('show');
    try {
      await joinCallChannel(payload.callId);
      sendSignal('hangup', {});
    } catch (_) {}
    const ch = callChannel;
    callChannel = null;
    if (ch) setTimeout(() => supabase.removeChannel(ch), 500);
  });

  $('acc').addEventListener('click', async () => {
    clearTimeout(incomingTimer);
    try {
      localStream = await media(kind);
      call = { id: payload.callId, role: 'callee', kind, connected: false };
      await joinCallChannel(payload.callId);
      pc = newPeer();
      showCallUi(name, kind, 'Connecting...');
      sendSignal('accepted', {});
    } catch (_) {
      await endCall(false);
      failAlert('Camera or microphone permission denied');
    }
  });
}

function listenInbox() {
  if (!me.id) return;
  inbox = supabase.channel('inbox:' + me.id, { config: { private: true } });
  inbox.on('broadcast', { event: 'invite' }, ({ payload }) => onInvite(payload)).subscribe();
}

function dragPip() {
  const pip = $('pip');
  let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  pip.addEventListener('pointerdown', (e) => {
    drag = true; sx = e.clientX; sy = e.clientY;
    const r = pip.getBoundingClientRect(); ox = r.left; oy = r.top;
    pip.setPointerCapture(e.pointerId);
  });
  pip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    pip.style.left = Math.max(0, Math.min(innerWidth - pip.offsetWidth, ox + e.clientX - sx)) + 'px';
    pip.style.top = Math.max(0, Math.min(innerHeight - pip.offsetHeight, oy + e.clientY - sy)) + 'px';
    pip.style.right = 'auto';
  });
  pip.addEventListener('pointerup', () => { drag = false; });
}

$('pip-close').addEventListener('click', () => $('pip').classList.add('hidden'));
$('pick').addEventListener('click', pickContacts);
$('sync').addEventListener('click', sync);
$('missed-close').addEventListener('click', () => $('missed').classList.remove('show'));
$('add-cancel').addEventListener('click', () => $('add').classList.remove('show'));
$('add-save').addEventListener('click', () => {
  const name = $('add-name').value.trim();
  const phone = normalize($('add-phone').value);
  if (!name || phone.length < 11) {
    showAlert('Enter a name and a valid phone number.', false);
    return;
  }
  localContacts = dedupe([...localContacts, { name, phone }]);
  store.set('local_contacts', localContacts);
  $('add-name').value = '';
  $('add-phone').value = '';
  $('add').classList.remove('show');
  showAlert('Contact saved. Tap Sync Contacts.', true);
});

window.addEventListener('beforeunload', () => {
  if (call) sendSignal('hangup', {});
});

(async function init() {
  const { data } = await supabase.auth.getSession();
  if (!data || !data.session) {
    location.replace('login.html');
    return;
  }
  me.id = data.session.user.id;
  me.name = LocalDB.getProfile().full_name || '';
  header();
  renderTabs();
  renderList();
  dragPip();
  listenInbox();
  LocalDB.syncProfile().then(header);
})();