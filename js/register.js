import { supabase } from './supabase.js';
import { API_BASE } from './config.js';
import { SkyNetLoader, showAlert } from './loader.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const overlay = $('overlay');
const avatar = $('avatar');
const pins = Array.from(document.querySelectorAll('#pin-row input'));
const fields = {
  name: $('name'),
  phone: $('phone'),
  email: $('email'),
  referral: $('referral'),
  password: $('password'),
  confirm: $('confirm')
};

const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.6C3.7 9.4 2 12 2 12s3.6 6 10 6c1.5 0 2.8-.3 4-.8"/></svg>';

let profileFile = null;
let busy = false;

document.querySelectorAll('[data-eye]').forEach((btn) => {
  const input = fields[btn.dataset.eye];
  btn.innerHTML = EYE_OFF;
  btn.addEventListener('click', () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    btn.innerHTML = hidden ? EYE_ON : EYE_OFF;
  });
});

pins.forEach((input, i) => {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 1);
    $('pin-row').classList.remove('invalid');
    if (input.value && i < 3) pins[i + 1].focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && i > 0) pins[i - 1].focus();
  });
});

Object.entries(fields).forEach(([key, input]) => {
  input.addEventListener('input', () => input.closest('.field').classList.remove('invalid'));
});

async function checkClipboardForReferral() {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (/^\d{6}$/.test(text) && !fields.referral.value) fields.referral.value = text;
  } catch (_) {}
}

function fail(message, element) {
  showAlert(message, false);
  if (element) {
    element.classList.remove('invalid');
    void element.offsetWidth;
    element.classList.add('invalid');
  }
  return false;
}

function getPin() {
  return pins.map((p) => p.value).join('');
}

function validate() {
  const f = (k) => fields[k].closest('.field');
  if (!fields.name.value.trim()) return fail('Name required', f('name'));
  if (!fields.phone.value.trim()) return fail('Phone number required', f('phone'));
  const email = fields.email.value.trim();
  if (!email) return fail('Email required', f('email'));
  if (!email.includes('@')) return fail('Invalid email configuration', f('email'));
  if (getPin().length < 4) return fail('Please complete the 4-digit Security PIN', $('pin-row'));
  if (fields.password.value.length < 6) return fail('Password requires minimum 6 characters', f('password'));
  if (!fields.confirm.value) return fail('Confirmation required', f('confirm'));
  if (fields.password.value !== fields.confirm.value) return fail('Passwords do not match', f('confirm'));
  return true;
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

function setPreview(file) {
  profileFile = file;
  const url = URL.createObjectURL(file);
  avatar.innerHTML = '';
  const img = new Image();
  img.src = url;
  img.alt = '';
  avatar.appendChild(img);
}

function onFile(e) {
  const file = e.target.files && e.target.files[0];
  if (file) setPreview(file);
  e.target.value = '';
}

async function processRegistration() {
  if (busy) return;
  if (!profileFile) {
    showAlert('Please capture or select a profile image to continue', false);
    return;
  }

  busy = true;
  overlay.classList.remove('show');
  SkyNetLoader.show('Synchronizing Secure Pipeline...');

  try {
    const ext = (profileFile.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const fileName = crypto.randomUUID() + '.' + ext;

    const { error: uploadError } = await supabase.storage
      .from('skynet_files')
      .upload(fileName, profileFile, { cacheControl: '3600', upsert: false, contentType: profileFile.type });
    if (uploadError) throw uploadError;

    const { data } = supabase.storage.from('skynet_files').getPublicUrl(fileName);
    const phone = fields.phone.value.trim();

    const response = await fetch(API_BASE + 'register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: fields.name.value.trim(),
        phone_number: phone,
        email: fields.email.value.trim(),
        referral_code: fields.referral.value.trim(),
        security_pin: getPin(),
        password: fields.password.value,
        device_uuid: 'HW-' + hashCode(phone),
        profile_url: data.publicUrl
      })
    });

    SkyNetLoader.hide();

    if (response.status === 200 || response.status === 201) {
      showAlert('Registration Successful!', true);
      setTimeout(() => location.replace('login.html'), 1000);
    } else {
      let message = 'Server registration failed. Please try again.';
      try {
        const body = await response.json();
        if (body && (body.message || body.error)) message = body.message || body.error;
      } catch (_) {}
      showAlert(message, false);
    }
  } catch (err) {
    SkyNetLoader.hide();
    showAlert((err && err.message) || 'Network error. Please try again.', false);
  } finally {
    busy = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (validate()) overlay.classList.add('show');
});

$('pick-camera').addEventListener('click', () => $('file-camera').click());
$('pick-gallery').addEventListener('click', () => $('file-gallery').click());
$('file-camera').addEventListener('change', onFile);
$('file-gallery').addEventListener('change', onFile);
$('activate').addEventListener('click', processRegistration);
$('cancel').addEventListener('click', () => overlay.classList.remove('show'));

checkClipboardForReferral();